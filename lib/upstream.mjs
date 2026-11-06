// 上游客户端，逐条对齐：
//   internal/deepai/client.go（commonHeaders / FetchModels / OpenModel /
//     Theos / UsageSummary / WebSearch / FindService / Transcribe / ExchangeCode）
//   internal/server/common.go（openModel 的换号重试 / 409 容量退避 / 错误映射）
//
// 所有私有请求头（Api-Key、X-DeepAI-Code-Theos: 2、X-DeepAI-Code-Machine、
// 浏览器指纹头、X-Session-Affinity）都在这里补齐，不再依赖 Go 网关。

import {
  ORIGIN, P, H, LANE_VERSION, DEFAULT_UA, RETRY_AFTER_FALLBACK_MS,
} from "./constants.mjs"
import { UpstreamError, retryAfter, readTextLimited } from "./http.mjs"
import { accountMachineFingerprint } from "./account.mjs"

export class Upstream {
  constructor({ pool, origin, processFP, maxRetries = 3, log } = {}) {
    this.pool = pool
    this.origin = (origin || ORIGIN).replace(/\/+$/, "")
    this.processFP = processFP || ""
    this.maxRetries = maxRetries
    this.log = log || (() => {})
    // 模型负载（session_busy 计数），供 magpie.load 上报。
    this.busy = Object.create(null)
  }

  modelURL(path) { return this.origin + path }
  rootURL(path) { return this.origin + path }

  noteBusy(model, busy) {
    if (!model) return
    const cur = this.busy[model] || 0
    this.busy[model] = busy
      ? Math.min(10000, cur + 50)
      : Math.max(0, cur * 0.5)
  }
  loadSnapshot() { return { ...this.busy } }

  // 对齐 client.commonHeaders
  commonHeaders(acct, extra = {}) {
    const h = new Headers()
    h.set(H.lane, LANE_VERSION)
    h.set("Accept", "application/json")
    const fp = accountMachineFingerprint(acct, this.processFP)
    if (fp) h.set(H.machine, fp)
    let ua = DEFAULT_UA
    if (acct && acct.userAgent) ua = acct.userAgent
    if (ua) h.set("User-Agent", ua)
    if (acct) {
      if (acct.acceptLanguage) h.set("Accept-Language", acct.acceptLanguage)
      if (acct.secCHUA) { h.set("sec-ch-ua", acct.secCHUA); h.set("sec-ch-ua-mobile", "?0") }
      if (acct.platform) h.set("sec-ch-ua-platform", acct.platform)
      if (acct.apiKey) h.set(H.key, acct.apiKey)
    }
    for (const [k, v] of Object.entries(extra)) if (v != null && v !== "") h.set(k, v)
    return h
  }

  async request(path, { method = "GET", acct = null, body, headers = {}, signal, op = "上游请求" } = {}) {
    const url = path.startsWith("http") ? path : this.modelURL(path)
    const hdr = this.commonHeaders(acct, headers)
    const init = { method, headers: hdr, signal }
    if (body != null) init.body = body
    const resp = await fetch(url, init)
    if (resp.status >= 200 && resp.status < 300) return resp
    const text = await readTextLimited(resp)
    throw new UpstreamError(op, resp.status, text)
  }

  // 对齐 client.FetchModels（无需 API Key，但需要机器指纹）
  async fetchModels(signal) {
    const resp = await this.request(P.models, { acct: null, signal, op: "模型目录" })
    const data = await resp.json()
    const seen = new Set()
    const models = []
    for (const m of (data && data.models) || []) {
      if (!m || !m.id || seen.has(m.id)) continue
      seen.add(m.id)
      models.push({ ...m, input: Array.isArray(m.input) && m.input.length ? m.input : ["text"] })
    }
    if (!models.length) throw new Error("上游模型目录为空")
    return { models, def: data.default || models[0].id }
  }

  async theos(acct, signal) {
    const resp = await this.request(P.theos, { acct, signal, op: "查询 Theos" })
    const j = await resp.json()
    return { enabled: !!j.enabled, balance: j.balance, granted: j.granted, refresh_at: j.refresh_at, lane_version: j.lane_version }
  }

  async usageSummary(acct, signal) {
    const url = this.rootURL(P.usage)
    const hdr = this.commonHeaders(acct)
    hdr.set("User-Agent", "DeepAI-Code")
    const resp = await fetch(url, { headers: hdr, signal })
    if (resp.status / 100 !== 2) {
      const text = await readTextLimited(resp)
      throw new UpstreamError("查询用量", resp.status, text)
    }
    return await resp.json()
  }

  postJSON(path, acct, payload, op, signal) {
    return this.request(path, {
      method: "POST", acct,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal, op,
    }).then((r) => r.json())
  }
  webSearch(acct, payload, signal) { return this.postJSON(P.webSearch, acct, payload, "联网搜索", signal) }
  findService(acct, payload, signal) { return this.postJSON(P.findService, acct, payload, "服务搜索", signal) }

  // 对齐 client.Transcribe（multipart voiceRecording）
  async transcribe(acct, { filename = "rec.webm", contentType = "audio/webm", data }, signal) {
    if (!data || !data.byteLength) throw new Error("音频内容为空")
    if (data.byteLength > 8 << 20) throw new Error("音频超过 8 MB")
    const fd = new FormData()
    fd.append("voiceRecording", new Blob([data], { type: contentType }), filename)
    const hdr = this.commonHeaders(acct)
    hdr.delete("Content-Type")
    if (acct && acct.apiKey) hdr.set("api-key", acct.apiKey)
    const resp = await fetch(this.rootURL(P.speech), { method: "POST", headers: hdr, body: fd, signal })
    if (resp.status / 100 !== 2) {
      const text = await readTextLimited(resp, 1 << 20)
      throw new UpstreamError("语音转写", resp.status, text)
    }
    const j = await resp.json()
    const text = String((j && j.text) || "").trim()
    if (!text) throw new Error("上游未返回转写文本")
    return text
  }

  // 对齐 client.ExchangeCode
  async exchangeCode(code, signal) {
    const resp = await this.request(P.exchange, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }), op: "登录换取密钥", signal,
    })
    const j = await resp.json()
    if (!j.api_key || /[\r\n]/.test(j.api_key)) throw new Error("登录响应缺少有效 API Key")
    return { apiKey: j.api_key, username: j.username, isPro: !!j.is_pro }
  }

  signInURL(state, port) {
    return this.modelURL(P.signIn) + `?state=${encodeURIComponent(state)}&port=${port}`
  }

  // 对齐 server/common.go 的 openModel：号池换号重试 + 409 容量退避。
  // 返回 { resp, acct, busy }。resp 是给 magpie 的 fetch 透传的 Response。
  async openModel({ path = P.chat, body, affinity = "", group = "", model = "", preferId = "", signal } = {}) {
    const accts = this.pool.list()
    if (!accts.length) throw new Error("没有可用账号，请先导入桌面端凭据、添加 API Key 或登录")
    let maxTries = this.maxRetries > 0 ? this.maxRetries : 3
    maxTries = Math.min(maxTries, accts.length + 2)
    const prefer = preferId ? accts.find((a) => a.id === preferId && a.enabled !== false) : null

    let lastErr = null
    let used = null
    let busy = false
    const tried = new Set()
    for (let i = 0; i < maxTries; i++) {
      let acct
      if (i === 0 && prefer && !tried.has(prefer.id)) {
        acct = prefer
      } else {
        acct = this.pool.next(group)
        let guard = 0
        while (acct && tried.has(acct.id) && guard++ < accts.length + 1) acct = this.pool.next(group)
      }
      if (!acct) break
      tried.add(acct.id)
      used = acct

      const headers = { "Content-Type": "application/json" }
      if (affinity) headers[H.affinity] = affinity
      let resp
      try {
        resp = await fetch(this.modelURL(path), {
          method: "POST",
          headers: this.commonHeaders(acct, headers),
          body,
          signal,
        })
      } catch (e) {
        lastErr = e
        this.pool.markResult(acct.id, false, String(e.message || e))
        if (signal && signal.aborted) break
        continue
      }

      if (resp.status >= 200 && resp.status < 300) {
        this.pool.markResult(acct.id, true, "")
        this.noteBusy(model, false)
        return { resp, acct, busy }
      }
      const text = await readTextLimited(resp)
      const he = new UpstreamError("上游推理", resp.status, text)

      if (he.capacityWaiting()) {
        busy = true
        this.noteBusy(model, true)
        lastErr = he
        await sleep(retryAfter(resp, RETRY_AFTER_FALLBACK_MS), signal)
        continue
      }
      if (!he.retryable()) {
        return { resp: upstreamErrorResponse(he), acct, busy }
      }
      lastErr = he
      this.pool.markResult(acct.id, false, he.message)
      if (signal && signal.aborted) break
    }
    if (!lastErr) lastErr = new Error("全部账号均不可用")
    if (lastErr instanceof UpstreamError && lastErr.authFailed()) {
      const e = new Error(lastErr.message)
      e.signIn = "expired"
      throw e
    }
    return { resp: upstreamErrorResponse(lastErr), acct: used, busy }
  }
}

function upstreamErrorResponse(err) {
  const status = err instanceof UpstreamError ? err.status : 502
  const body = err instanceof UpstreamError && err.body
    ? err.body
    : JSON.stringify({ error: { message: String(err.message || err), type: "upstream_error" } })
  return new Response(body, { status, headers: { "Content-Type": "application/json; charset=utf-8" } })
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    if (signal) signal.addEventListener("abort", () => { clearTimeout(t); resolve() }, { once: true })
  })
}
