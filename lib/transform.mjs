// 响应归一化，对齐 internal/server/chat.go 的 transformChatResponse /
// transformChatChunk、common.go 的 parseUsage、以及 SSE 流式改写。
//
// magpie 已经把 agent 协议翻译成 chat completions，所以插件只需要把上游
// 私有字段（reasoning / cost / provider）归一化成 OpenAI 生态通用字段，
// 并把 model 改回对外模型名。对流式正文改写时必须去掉 content-length /
// content-encoding（magpie 文档 §"请求"）。

import { stripFramingHeaders } from "./http.mjs"

export function addReasoningContent(msg) {
  if (!msg || typeof msg !== "object") return
  if (msg.reasoning_content == null && msg.reasoning != null) {
    msg.reasoning_content = msg.reasoning
  }
}

export function transformChatResponse(text, publicModel) {
  let out
  try { out = JSON.parse(text) } catch { return text }
  if (publicModel) out.model = publicModel
  const choices = Array.isArray(out.choices) ? out.choices : []
  for (const c of choices) if (c && c.message) addReasoningContent(c.message)
  return JSON.stringify(out)
}

export function transformChatChunk(line, publicModel) {
  // 输入是 "data: {...}" 或 "data: [DONE]"
  if (!line.startsWith("data:")) return line
  const payload = line.slice(5).trimStart()
  if (payload === "[DONE]" || payload === "") return line
  try {
    const o = JSON.parse(payload)
    if (publicModel) o.model = publicModel
    for (const c of Array.isArray(o.choices) ? o.choices : []) {
      if (c && c.delta) addReasoningContent(c.delta)
    }
    return "data: " + JSON.stringify(o)
  } catch { return line }
}

// 把上游 SSE 响应改写成归一化流（逐块）。返回新的 Response。
export function rewriteSSEResponse(resp, publicModel) {
  const headers = stripFramingHeaders(resp.headers)
  headers.set("Content-Type", "text/event-stream; charset=utf-8")
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const reader = resp.body.getReader()
  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) { controller.close(); return }
      const chunk = dec.decode(value, { stream: true })
      const lines = chunk.split("\n")
      const out = lines.map((l) => transformChatChunk(l.replace(/\r$/, ""), publicModel)).join("\n")
      controller.enqueue(enc.encode(out))
    },
    cancel() { reader.cancel().catch(() => {}) },
  })
  return new Response(stream, { status: resp.status, headers })
}

// 对齐 common.go parseUsage：兼容 chat/completions 与 responses 的 usage 字段。
export function parseUsage(v) {
  const u = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, reasoning_tokens: 0, cost: 0 }
  if (!v || typeof v !== "object") return u
  u.prompt_tokens = Number(v.prompt_tokens ?? v.input_tokens) || 0
  u.completion_tokens = Number(v.completion_tokens ?? v.output_tokens) || 0
  u.total_tokens = Number(v.total_tokens) || (u.prompt_tokens + u.completion_tokens)
  if (v.completion_tokens_details) u.reasoning_tokens = Number(v.completion_tokens_details.reasoning_tokens) || 0
  if (v.reasoning_tokens != null) u.reasoning_tokens = Number(v.reasoning_tokens) || 0
  u.cost = Number(v.cost) || 0
  return u
}

export function chatTextLen(out) {
  try {
    const c = Array.isArray(out.choices) ? out.choices : []
    return c.reduce((n, x) => n + String((x.message && x.message.content) || "").length, 0)
  } catch { return 0 }
}
