import { waitUntil } from "@vercel/functions";

const requiredEnv = [
  "OPENAI_API_KEY",
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_VERIFICATION_TOKEN"
];

const tenantTokenCache = { token: "", expiresAt: 0 };
const handledMessages = new Map();

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    const missing = requiredEnv.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      return res.status(500).json({ ok: false, error: `missing env: ${missing.join(", ")}` });
    }

    const payload = await readPayload(req);

    if (payload.type === "url_verification") {
      if (payload.token !== process.env.FEISHU_VERIFICATION_TOKEN) {
        console.warn("[feishu] url verification failed: invalid token");
        return res.status(403).json({ ok: false, error: "invalid verification token" });
      }
      console.log("[feishu] url verification succeeded");
      return res.status(200).json({ challenge: payload.challenge });
    }

    if (!isValidFeishuEvent(payload)) {
      console.warn(`[feishu] event rejected: invalid token eventType=${payload?.header?.event_type || "unknown"}`);
      return res.status(403).json({ ok: false, error: "invalid event token" });
    }

    console.log(`[feishu] accepted event type=${payload?.header?.event_type || "unknown"}`);
    waitUntil(handleMessageEvent(payload));
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
}

async function readPayload(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(rawBody || "{}");
}

function isValidFeishuEvent(payload) {
  return payload?.header?.token === process.env.FEISHU_VERIFICATION_TOKEN;
}

async function handleMessageEvent(payload) {
  const eventType = payload?.header?.event_type;
  if (eventType !== "im.message.receive_v1") {
    console.log(`[feishu] ignored event type=${eventType || "unknown"}`);
    return;
  }

  const message = payload?.event?.message;
  if (!message?.message_id) {
    console.log("[feishu] ignored message: missing message_id");
    return;
  }
  if (message.message_type !== "text") {
    console.log(`[feishu] ignored message id=${message.message_id}: messageType=${message.message_type || "unknown"}`);
    return;
  }
  if (markHandled(message.message_id)) {
    console.log(`[feishu] ignored duplicate message id=${message.message_id}`);
    return;
  }

  const userText = parseFeishuText(message.content);
  if (!userText) {
    console.log(`[feishu] ignored message id=${message.message_id}: empty text`);
    return;
  }

  console.log(`[feishu] processing message id=${message.message_id} chars=${userText.length}`);
  const answer = await askOpenAI(userText);
  console.log(`[openai] generated reply chars=${answer.length} for message id=${message.message_id}`);
  await replyToFeishuMessage(message.message_id, answer);
  console.log(`[feishu] replied message id=${message.message_id}`);
}

function markHandled(messageId) {
  const now = Date.now();
  for (const [id, createdAt] of handledMessages) {
    if (now - createdAt > 10 * 60 * 1000) handledMessages.delete(id);
  }
  if (handledMessages.has(messageId)) return true;
  handledMessages.set(messageId, now);
  return false;
}

function parseFeishuText(content) {
  try {
    const parsed = JSON.parse(content || "{}");
    return String(parsed.text || "").trim();
  } catch {
    return "";
  }
}

async function askOpenAI(input) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: "你是一个接入飞书的简洁中文助手。回答要直接、实用、友好。"
        },
        {
          role: "user",
          content: input
        }
      ]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return extractOpenAIText(data) || "我收到了，但这次没有生成可发送的文本回复。";
}

function extractOpenAIText(data) {
  if (typeof data.output_text === "string") return data.output_text.trim();
  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

async function getTenantAccessToken() {
  const now = Date.now();
  if (tenantTokenCache.token && tenantTokenCache.expiresAt > now + 60_000) {
    return tenantTokenCache.token;
  }

  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET
    })
  });
  const data = await response.json();
  if (!response.ok || data.code !== 0) {
    throw new Error(`tenant token request failed: ${response.status} ${JSON.stringify(data)}`);
  }

  tenantTokenCache.token = data.tenant_access_token;
  tenantTokenCache.expiresAt = Date.now() + Number(data.expire || 3600) * 1000;
  return tenantTokenCache.token;
}

async function replyToFeishuMessage(messageId, text) {
  const token = await getTenantAccessToken();
  const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      msg_type: "text",
      content: JSON.stringify({ text: text.slice(0, 6000) })
    })
  });
  const data = await response.json();
  if (!response.ok || data.code !== 0) {
    throw new Error(`Feishu reply failed: ${response.status} ${JSON.stringify(data)}`);
  }
}
