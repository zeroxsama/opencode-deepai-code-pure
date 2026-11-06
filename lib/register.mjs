// 注册 → 登录 → 取 Session → 验活 → 入池，对齐 internal/register/*。
// 用 Bun 的 fetch 复刻 WebClient 的 Cookie 会话、multipart 表单、内部重试、
// 邮箱验证链接轮询，结果写入 plugin 的 Pool（不再经过 Go 网关的 /admin/api）。

import { ORIGIN, WEB, DEFAULT_UA, DEFAULT_MODEL } from "./constants.mjs"
import { newMachineUUID } from "./machine.mjs"
import { accountFromAPIKey, randomHex } from "./account.mjs"

const verifyLinkRe = /https?:\/\/api\.deepai\.org\/verify_email\?key=[0-9a-fA-F-]+/

function randomPassword(n = 18) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#"
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => chars[x % chars.length]).join("")
}

class CookieJar {
  constructor() { this.map = new Map() }
  header() { return [...this.map.values()].join("; ") }
  absorb(resp) {
    const raw = resp.headers.get("set-cookie")
    if (!raw) return
    // 简化：按 "k=v" 取第一段（覆盖 sessionid / csrftoken 足够）
    for (const part of raw.split(/,(?=\s*[^;=]+=)/)) {
      const kv = part.split(";")[0].trim()
      const i = kv.indexOf("=")
      if (i > 0) this.map.set(kv.slice(0, i), kv)
    }
  }
}

export class WebClient {
  constructor({ origin = ORIGIN, ua = DEFAULT_UA, lang = "en", proxy = "", timeoutMs = 60000 } = {}) {
    this.origin = origin.replace(/\/+$/, "")
    this.ua = ua
    this.lang = lang
    this.proxy = proxy
    this.timeoutMs = timeoutMs
    this.jar = new CookieJar()
  }

  url(p) { return p.startsWith("http") ? p : this.origin + p }

  async do(method, p, { contentType, body, attempts = 3, signal } = {}) {
    let lastErr
    for (let i = 0; i < attempts; i++) {
      try {
        const headers = new Headers()
        headers.set("User-Agent", this.ua)
        headers.set("Accept-Language", this.lang)
        headers.set("Accept", "application/json, text/plain, */*")
        const cookie = this.jar.header()
        if (cookie) headers.set("Cookie", cookie)
        if (contentType) headers.set("Content-Type", contentType)
        const resp = await fetch(this.url(p), {
          method, headers, body, signal,
          redirect: "follow",
        })
        this.jar.absorb(resp)
        const text = await resp.text()
        return { status: resp.status, text }
      } catch (e) {
        lastErr = e
        if (signal && signal.aborted) throw e
      }
    }
    throw lastErr || new Error("网页请求失败")
  }

  postForm(p, fields, signal) {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields)) fd.append(k, v)
    return this.do("POST", p, { body: fd, attempts: 3, signal })
  }
  postJSON(p, obj, signal) {
    return this.do("POST", p, { contentType: "application/json", body: JSON.stringify(obj), attempts: 3, signal })
  }

  async userExists(email, signal) {
    const { status, text } = await this.postForm(WEB.loginType, { email }, signal)
    if (status !== 200) throw new Error(`查询邮箱: HTTP ${status}: ${text.slice(0, 200)}`)
    const o = JSON.parse(text)
    return !!o.user_exists
  }
  async saveSignupData(signal) {
    const r = await this.postJSON(WEB.signupData, {
      referrer: "[]", signup_page: "/chat", desired_username: null, language: this.lang,
    }, signal)
    if (r.status / 100 !== 2) throw new Error(`保存注册来源: HTTP ${r.status}`)
  }
  async register(email, password, signal) {
    const r = await this.postForm(WEB.register, {
      email, username: email, password1: password, password2: password,
    }, signal)
    if (r.status / 100 !== 2) throw new Error(`注册: HTTP ${r.status}: ${r.text.slice(0, 200)}`)
    return (JSON.parse(r.text || "{}").key) || ""
  }
  async login(email, password, signal) {
    const r = await this.postForm(WEB.login, { username: email, password }, signal)
    if (r.status / 100 !== 2) throw new Error(`登录: HTTP ${r.status}: ${r.text.slice(0, 200)}`)
    return (JSON.parse(r.text || "{}").key) || ""
  }
  async fetchUser(signal) {
    const { status, text } = await this.do("GET", WEB.user, { attempts: 2, signal })
    if (status / 100 !== 2) throw new Error(`读取会话: HTTP ${status}: ${text.slice(0, 200)}`)
    return JSON.parse(text)
  }
  async verifyEmail(link, signal) {
    if (!link.startsWith("https://api.deepai.org/verify_email") &&
        !link.startsWith("http://api.deepai.org/verify_email")) {
      throw new Error("验证链接域名不合法")
    }
    const { status, text } = await this.do("GET", link, { attempts: 3, signal })
    if (status >= 400) throw new Error(`验证邮箱: HTTP ${status}`)
    return text
  }
  async logout(signal) {
    await this.do("POST", WEB.logout, { attempts: 1, signal })
  }
}

// 静态邮箱后端：随机 user@domain，无收件箱（对齐 staticProvider / none）。
export function makeAddress(domain, backend = "static", email = "") {
  if (backend === "none") {
    if (!email) throw new Error("mail-backend=none 时必须显式提供邮箱")
    return email
  }
  return `${randomHex(5)}@${domain}`
}

// CF Temp Email Worker 后端（mailbox.go 的最小复刻）。
export class CFMailbox {
  constructor({ base, adminKey, domain, email, signal } = {}) {
    this.base = String(base || "").replace(/\/+$/, "")
    this.adminKey = adminKey || ""
    this.domain = domain
    this.email = email
    this.signal = signal
  }
  async create() {
    const r = await fetch(`${this.base}/api/mailbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.adminKey ? { "X-Admin-Key": this.adminKey } : {}) },
      body: JSON.stringify({ domain: this.domain }), signal: this.signal,
    }).catch(() => null)
    if (r && r.ok) {
      const j = await r.json().catch(() => ({}))
      if (j.email || j.address) return j.email || j.address
    }
    return makeAddress(this.domain)
  }
  async waitVerification(since, timeoutMs = 120000, intervalMs = 1000) {
    const deadline = Date.now() + timeoutMs
    let iv = 300
    while (Date.now() < deadline) {
      const r = await fetch(`${this.base}/api/mails?address=${encodeURIComponent(this.email)}&since=${since}`, {
        headers: this.adminKey ? { "X-Admin-Key": this.adminKey } : {}, signal: this.signal,
      }).catch(() => null)
      if (r && r.ok) {
        const j = await r.json().catch(() => ({}))
        const mails = Array.isArray(j) ? j : (j.mails || [])
        for (const m of mails) {
          const text = `${m.subject || ""} ${m.body || m.text || ""}`
          if (/verif/i.test(text)) {
            const link = text.match(verifyLinkRe)
            if (link) return link[0]
          }
        }
      }
      await new Promise((res) => setTimeout(res, iv))
      iv = Math.min(intervalMs, iv * 2)
    }
    return ""
  }
}

// 单账号完整链路（pipeline.RunOne 的最小但保真复刻）。
// opts: { pool, upstream, domain, backend, email, password, group, verify, base, adminKey, signal }
export async function runOne(opts = {}) {
  const { pool, upstream, signal } = opts
  const backend = opts.backend || "static"
  const email = opts.email || makeAddress(opts.domain || "example.com", backend)
  const password = opts.password || randomPassword(18)
  const group = opts.group || "default"
  const rec = { email, password, group, source: "register", proxy: opts.proxy || "" }

  const wc = new WebClient({ proxy: opts.proxy, ua: opts.userAgent, lang: opts.lang })
  const exists = await wc.userExists(email, signal).catch(() => false)

  if (!exists) {
    await wc.saveSignupData(signal).catch(() => {})
    await wc.register(email, password, signal).catch((e) => { rec.registerErr = e.message })
  }
  // 登录兜底：注册偶发 504 但实际已建成
  await wc.login(email, password, signal).catch((e) => { rec.loginErr = e.message })
  const user = await wc.fetchUser(signal)
  const apiKey = user?.userprofile?.api_key
  if (!apiKey) throw new Error("会话缺少 api_key（注册/登录失败）")

  const acct = accountFromAPIKey(apiKey, {
    username: user.username || email, source: "register",
    isPro: String(user.userprofile2?.plan || "").toLowerCase() === "pro",
    email, password, group, plan: user.userprofile2?.plan || "",
    machineID: newMachineUUID(), proxy: opts.proxy,
  })

  // 验活：GET /theos（对齐 pipeline 的 theosWithRetry）
  try {
    const al = await upstream.theos(acct, signal)
    pool.setAllowance(acct.id, al, null)
    rec.theos = al
  } catch (e) { rec.theosErr = e.message }

  const added = pool.upsert(acct)
  rec.accountID = acct.id
  rec.added = added

  // 邮箱验证（异步补跑语义：这里尽力等待）
  if (opts.verify && backend === "cf" && opts.base) {
    const mb = new CFMailbox({ base: opts.base, adminKey: opts.adminKey, email, signal })
    const link = await mb.waitVerification(Date.now() - 10000, opts.verifyWaitMs || 120000)
    if (link) {
      await wc.verifyEmail(link, signal).catch(() => {})
      acct.emailVerified = true
      rec.verified = true
    }
  }
  await wc.logout(signal).catch(() => {})
  return rec
}
