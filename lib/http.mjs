// 对齐 internal/deepai/client.go 的 HTTPError / Retryable / CapacityWaiting /
// RetryAfter，以及 server/common.go 的 writeUpstreamErr 语义。
// 插件的 fetch 把上游响应原样返回；magpie 据此做账号标记与故障切换。

export class UpstreamError extends Error {
  constructor(op, status, body) {
    const text = typeof body === "string" ? body : (body && body.text) || ""
    super(`${op}: HTTP ${status}: ${truncate(text, 300)}`)
    this.name = "UpstreamError"
    this.status = status
    this.body =
      typeof body === "string" ? body : text
    this.code = extractCode(this.body)
  }
  // 400/404/422 是请求本身的问题，重试无意义；
  // 401/403/409/429/5xx 与账号或容量相关，可换号重试。
  retryable() {
    return this.status === 401 || this.status === 403 ||
      this.status === 409 || this.status === 429 || this.status >= 500
  }
  capacityWaiting() {
    return this.status === 409 && this.code === "session_busy"
  }
  authFailed() {
    return this.status === 401 || this.status === 403
  }
}

function extractCode(body) {
  try {
    const o = JSON.parse(body)
    return (o && o.error && o.error.code) || ""
  } catch {
    return ""
  }
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "…" : s
}

export function retryAfter(resp, fallbackMs) {
  const v = resp && resp.headers && resp.headers.get
    ? resp.headers.get("retry-after") : null
  if (v != null) {
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0) return Math.min(n * 1000, 30000)
    const t = Date.parse(v)
    if (Number.isFinite(t)) return Math.max(0, Math.min(t - Date.now(), 30000))
  }
  return fallbackMs
}

export function isTransient(err) {
  const s = String((err && err.message) || err)
  return /No exit node|TLS handshake|unexpected EOF|ECONNRESET|ETIMEDOUT|EOF/i.test(s)
}

// magpie 的 fetch 只接受一个 Response。把上游原样响应透传即可。
// 这里提供按需改写流式正文时去掉 content-length / content-encoding 的工具。
export function stripFramingHeaders(headers) {
  const h = new Headers(headers)
  h.delete("content-length")
  h.delete("content-encoding")
  return h
}

// 读取一个响应体的文本（带上限），用于错误判定与非流式日志记录。
export async function readTextLimited(resp, maxBytes = 8 << 20) {
  const buf = await resp.arrayBuffer()
  const bytes = buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf
  return new TextDecoder().decode(bytes)
}
