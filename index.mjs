// DeepAI Code 纯插件（magpie / OpenCode provider）。
//
// 不跑 Go 网关：插件在 Bun 宿主里直连 https://api.deepai.org，把
// DeepAICode2API 的 Go 实现逐条复刻成 JS 模块：
//   - 私有请求头 / 机器指纹      lib/upstream.mjs + lib/machine.mjs
//   - 号池轮询 / 配额 / 故障切换  lib/pool.mjs
//   - 动态模型目录 + 别名        lib/catalog.mjs
//   - Theos / 用量 / 联网能力    lib/upstream.mjs
//   - 浏览器登录 / 注册入池      lib/oauth.mjs + lib/register.mjs
//   - 控制台/统计/工具           lib/state.mjs + lib/tools.mjs + page/
//   - 协议归一化                 lib/transform.mjs
//
// 入口只导出 DeepAIPurePlugin 一个函数：magpie 把「模块导出的每个函数」
// 都当作插件调用，辅助函数必须保持模块内私有。

import { State } from "./lib/state.mjs"
import { Catalog, isResponses } from "./lib/catalog.mjs"
import { Upstream } from "./lib/upstream.mjs"
import {
  detectMachineRaw, machineFingerprint, desktopSecretDirs,
} from "./lib/machine.mjs"
import {
  accountFromAPIKey, accountFromCredentials,
} from "./lib/account.mjs"
import { startCallbackServer, newState } from "./lib/oauth.mjs"
import { runOne, makeAddress } from "./lib/register.mjs"
import { buildTools } from "./lib/tools.mjs"
import {
  ORIGIN, MODEL_BASE, P, H, DEFAULT_MODEL, BUILTIN_ALIASES,
} from "./lib/constants.mjs"
import { startAdminServer } from "./lib/admin-server.mjs"
import {
  transformChatResponse, rewriteSSEResponse, parseUsage, chatTextLen,
} from "./lib/transform.mjs"

const PROVIDER = "deepai"
const AFFINITY_OK = /^[A-Za-z0-9._:-]{1,256}$/
const DEFAULT_ADMIN_PORT = 3493

// 单个模块实例里共享的运行时状态（所有登录账号共用一个号池）。
// 用 input.directory 作为持久化目录。
class Runtime {
  constructor(input, options) {
    const opts = options || (input && input.magpie && input.magpie.options) || {}
    this.input = input
    this.opts = opts
    this.client = input && input.client
    this.dir = (input && input.directory) || process.cwd()
    this.origin = (opts.origin || process.env.DEEPAI_API_ORIGIN || ORIGIN).replace(/\/+$/, "")
    // magpie 用 baseURL + /chat/completions 拼请求；DeepAI 上游带
    // /deepai_code 前缀，所以暴露给 magpie 的基地址必须包含它。
    this.apiBase = this.origin + MODEL_BASE
    this.log = (msg) => {
      try { this.client && this.client.app && this.client.app.log({ level: "info", message: `[deepai] ${msg}` }) } catch {}
    }
    this.state = new State({ directory: this.dir, masterKeyRaw: opts.masterKey || "" })
    this.catalog = new Catalog()
    this.processFP = ""
    this._init = null

    this._modelRefresh = null
    this._loadTimer = null
  }

  async ready() {
    if (this._init) return this._init
    this._init = (async () => {
      await this.state.load()
      // 进程级机器指纹：显式覆盖 > 状态缓存 > 现采
      const override = this.opts.machineID || process.env.DEEPAI_MACHINE_ID
      let raw = override || this.state.machineID
      if (!raw) {
        raw = await detectMachineRaw()
        if (raw) { this.state.machineID = raw; await this.state.save() }
      }
      this.processFP = machineFingerprint(raw)

      this.catalog.aliases = { ...BUILTIN_ALIASES, ...(this.state.settings.model_aliases || {}) }
      this.catalog.fallback = this.state.settings.fallback_model || ""
      if (this.state.models.length) {
        this.catalog.update(this.state.models, this.state.defaultModel)
      }
      this.upstream = new Upstream({
        pool: this.state.pool,
        origin: this.origin,
        processFP: this.processFP,
        maxRetries: Number(this.state.settings.max_retries) || 3,
        log: this.log,
      })

      // 桌面端凭据导入（对齐 main.autoImport）：仅首次、有配置时。
      if (this.opts.importDesktop !== false) {
        const n = await this.importDesktop(this.opts.desktopPath || "")
        if (n) this.log(`启动时导入 ${n} 个桌面端账号`)
      }
      // 直接 env Key（对齐 DEEPAI_API_KEY）
      const envKey = process.env.DEEPAI_API_KEY
      if (envKey) {
        try { this.state.pool.upsert(accountFromAPIKey(envKey, { source: "manual" })) } catch {}
      }
      await this.state.save()
      await this.refreshModels()
      // 模型负载上报（magpie.load）：不常驻定时器（bun 下 unref 不一定生效，
      // 会挂住宿主进程），改为在每次容量/成功事件后即时上报一次。
      return this
    })()
    return this._init
  }

  async importDesktop(explicit) {
    const { readFile } = await import("node:fs/promises")
    const path = await import("node:path")
    let n = 0
    for (const d of desktopSecretDirs(explicit)) {
      try {
        const cred = JSON.parse(await readFile(path.join(d, "deepai-account.bin"), "utf8"))
        if (cred && cred.apiKey) {
          this.state.pool.upsert(accountFromCredentials(cred, "desktop"))
          n++
        }
      } catch { /* next */ }
    }
    return n
  }

  async refreshModels() {
    try {
      const { models, def } = await this.upstream.fetchModels()
      this.catalog.update(models, def)
      this.state.models = models
      this.state.defaultModel = def
      this.state.modelsUpdated = this.catalog.updated
      await this.state.save()
      this.log(`模型目录已更新：${models.length} 个，默认 ${def}`)
    } catch (e) {
      this.log(`模型目录拉取失败（用缓存）：${e.message}`)
    }
  }

  // 容量/成功事件后即时向 magpie 上报模型负载（5 分钟内有效）。
  reportLoad() {
    try {
      if (this.input && this.input.magpie && typeof this.input.magpie.load === "function") {
        const snap = this.upstream.loadSnapshot()
        if (Object.keys(snap).length) this.input.magpie.load(PROVIDER, snap)
      }
    } catch {}
  }

  // 账号作用域：把登录得到的 key 追加到号池，返回其 id。
  addAccount(key, meta = {}) {
    const acct = accountFromAPIKey(key, { ...meta, source: meta.source || "manual" })
    this.state.pool.upsert(acct)
    this.state.save().catch(() => {})
    return acct.id
  }

  // 构造 loader.fetch：magpie 把翻译后的请求发到这里。
  makeLoaderFetch(preferId) {
    const rt = this
    return async function deepaiFetch(input, init) {
      await rt.ready()
      const url = typeof input === "string" ? input : (input && input.url) || ""
      const method = (init && init.method) || "GET"
      const bodyText = init && init.body != null ? String(init.body) : ""
      const signal = init && init.signal

      // 判断是不是推理请求（chat/responses）。其余（models 等辅助 GET）
      // magpie 不会走 loader.fetch，但兜底直连，避免误判。
      const isInference =
        method === "POST" && (url.includes(P.chat) || url.includes(P.responses))
      if (!isInference) {
        const acct = rt.state.pool.next("")
        const headers = rt.upstream.commonHeaders(acct)
        // 合并网关传来的头（不含私有头的覆盖关系由 commonHeaders 之后处理）
        if (init && init.headers) {
          new Headers(init.headers).forEach((v, k) => { if (k.toLowerCase() !== "content-type") headers.set(k, v) })
        }
        return fetch(url, { ...init, headers, signal })
      }

      // 解析 model / stream，做协议归一化与用量记录。
      let model = ""
      let stream = false
      try {
        const b = JSON.parse(bodyText)
        model = b.model || ""
        stream = !!b.stream
      } catch {}
      const m = rt.catalog.resolve(model)
      // 把请求里的 model 改成目录里的真实 API id（对齐 resolveModel）。
      let outBody = bodyText
      try {
        const b = JSON.parse(bodyText)
        b.model = m.id
        b.stream = !!b.stream
        outBody = JSON.stringify(b)
      } catch {}
      const publicModel = model || m.id
      const path = isResponses(m) ? P.responses : P.chat

      // 会话粘性：chat.headers 注入的 X-Session-Affinity，或 body.prompt_cache_key。
      let affinity = ""
      if (init && init.headers) {
        const h = new Headers(init.headers).get(H.affinity) || ""
        if (AFFINITY_OK.test(h)) affinity = h
      }
      if (!affinity) {
        try {
          const pck = JSON.parse(bodyText).prompt_cache_key
          if (typeof pck === "string" && AFFINITY_OK.test(pck.trim())) affinity = pck.trim()
        } catch {}
      }

      const t0 = Date.now()
      const { resp, acct, busy } = await rt.upstream.openModel({
        path, body: outBody, affinity, model: m.id, preferId, signal,
      })
      const ms = Date.now() - t0
      rt.reportLoad() // 容量/成功事件后即时上报负载（无常驻定时器）

      // 改写流式 / 非流式正文：归一化 reasoning、model 名。
      let finalResp = resp
      const ct = resp.headers.get("content-type") || ""
      if (resp.status >= 200 && resp.status < 300 && ct.includes("text/event-stream")) {
        finalResp = rewriteSSEResponse(resp, publicModel)
      } else if (resp.status >= 200 && resp.status < 300 && !stream) {
        const text = await resp.text()
        const norm = transformChatResponse(text, publicModel)
        let usage = {}
        try { usage = parseUsage(JSON.parse(norm).usage) } catch {}
        const headers = new Headers(resp.headers)
        headers.delete("content-length"); headers.delete("content-encoding")
        finalResp = new Response(norm, { status: resp.status, headers })
        rt.state.record({
          account: acct ? acct.id : "", model: m.id, endpoint: path.includes("responses") ? "responses" : "chat",
          stream: false, status: resp.status, latency_ms: ms,
          prompt_len: 0, output_len: chatTextLen(JSON.parse(norm)),
          tokens_in: usage.prompt_tokens || 0, tokens_out: usage.completion_tokens || 0, cost: usage.cost || 0,
        })
        rt.state.save().catch(() => {})
      }

      // 容量/登录状态标记（magpie 文档 §"登录状态" / 模型负载）。
      const outHeaders = new Headers(finalResp.headers)
      if (busy) outHeaders.set("Retry-After", "2")
      // 不改写流式 framing；只追加控制头。
      if (busy) {
        return new Response(finalResp.body, {
          status: finalResp.status,
          headers: outHeaders,
        })
      }
      return finalResp
    }
  }
}

// 模块级 Runtime 单例：magpie 里一个插件导出函数只被实例化一次，
// 多次登录/账号共享同一个号池。options 在首次构造时生效。
let RUNTIME = null
function runtime(input, options) {
  if (!RUNTIME) RUNTIME = new Runtime(input, options)
  return RUNTIME
}

// 账号管理本地服务（magpie page host part）：与宿主同进程，共享 RUNTIME.state。
// 幂等、不阻塞插件加载（端口占用只记日志，页面会在跳转失败时给提示）。
let ADMIN = null
function ensureAdminServer(rt) {
  if (ADMIN) return ADMIN
  if (rt.opts.noAdminServer) { ADMIN = Promise.resolve(null); return ADMIN }
  const port = Number(rt.opts.adminPort) || DEFAULT_ADMIN_PORT
  ADMIN = startAdminServer({
    port,
    getRuntime: async () => { await rt.ready(); return rt },
  }).then((info) => {
    rt.log(`账号管理服务已启动：http://127.0.0.1:${info.port}`)
    return info
  }).catch((e) => {
    rt.log(`账号管理服务启动失败：${e.message}`)
    return null
  })
  return ADMIN
}

export const DeepAIPurePlugin = async (input, options) => {
  const rt = runtime(input, options)
  await rt.ready()
  ensureAdminServer(rt) // 起账号管理本地服务（幂等，不阻塞）

  const getAuth = (auth) => {
    // magpie 账号 -> 号池账号 id（存在 auth.metadata.acctID）
    return (auth && auth.metadata && auth.metadata.acctID) || ""
  }

  return {
    // 声明供应商 + 兜底模型（??= 保护用户配置）。
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "DeepAI Code (纯插件)",
        npm: "@ai-sdk/openai-compatible",
        api: rt.apiBase,
        models: {
          [DEFAULT_MODEL]: {
            name: "GLM 5.3 Flash",
            limit: { context: 1048576, output: 131072 },
            tool_call: true, free: true,
          },
        },
      }
    },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          // 方式一：直接填上游 API Key。magpie 的多账号 = 号池多 Key。
          type: "api",
          label: "DeepAI 上游 API Key",
          placeholder: "UUID 格式的 apiKey（桌面端凭据文件里的值）",
          async authorize(inputs) {
            const key = String((inputs && inputs.key) || "").trim()
            if (!key) return { type: "failed", error: "API Key 不能为空" }
            const meta = (inputs && inputs.metadata) || {}
            const id = rt.addAccount(key, {
              username: meta.username || "", isPro: !!meta.isPro, source: "manual",
            })
            return {
              type: "success", key,
              metadata: { acctID: id, username: meta.username || "", accountId: meta.username || id },
            }
          },
        },
        {
          // 方式二：从本机桌面端凭据导入（对齐 autoImport）。
          type: "api",
          label: "导入桌面端凭据",
          placeholder: "填任意占位串即可；实际凭据从本机读取",
          async authorize(inputs) {
            const explicit = String((inputs && inputs.path) || "")
            const n = await rt.importDesktop(explicit)
            if (!n) return { type: "failed", error: "未找到桌面端凭据 deepai-account.bin" }
            await rt.state.save()
            const first = rt.state.pool.list().find((a) => a.source === "desktop")
            return {
              type: "success", key: "desktop-import",
              metadata: { acctID: first ? first.id : "", accountId: `desktop(${n})`, imported: n },
            }
          },
        },
        {
          // 方式三：浏览器 OAuth 桌面登录（对齐 login.go）。
          type: "oauth",
          label: "浏览器登录 DeepAI Code",
          async authorize() {
            const srv = startCallbackServer({ timeoutMs: 180000 })
            const port = await srv.ready
            const state = newState()
            const url = rt.upstream.signInURL(state, port)
            return {
              url,
              instructions: "浏览器完成登录后会自动跳回本机；请在 magpie 里等待完成。",
              method: "auto",
              async callback() {
                try {
                  const code = await srv.wait
                  const cred = await rt.upstream.exchangeCode(code)
                  const id = rt.addAccount(cred.apiKey, {
                    username: cred.username, isPro: cred.isPro, source: "oauth",
                  })
                  return {
                    type: "success", key: cred.apiKey,
                    metadata: { acctID: id, accountId: cred.username || id },
                  }
                } finally {
                  await srv.close()
                }
              },
            }
          },
        },
        {
          // 方式四：注册新账号并入池（对齐 register 流水线）。
          type: "api",
          label: "注册新账号入池",
          placeholder: "填任意占位串；邮箱/密码可用 prompts 提供",
          prompts: [
            { type: "text", key: "email", message: "邮箱（留空自动生成）", placeholder: "auto" },
            { type: "text", key: "password", message: "密码（留空自动生成）", placeholder: "auto" },
            { type: "select", key: "backend", message: "邮箱后端",
              options: [
                { label: "静态域名", value: "static" },
                { label: "CF Temp Email", value: "cf" },
                { label: "无收件箱", value: "none" },
              ] },
          ],
          async authorize(inputs) {
            const o = inputs || {}
            const backend = o.backend || "static"
            let email = o.email && o.email !== "auto" ? o.email : ""
            if (!email && backend !== "none") email = makeAddress(rt.opts.domain || "", backend)
            const rec = await runOne({
              pool: rt.state.pool, upstream: rt.upstream,
              domain: rt.opts.domain || "", backend, email,
              password: o.password && o.password !== "auto" ? o.password : "",
              base: rt.opts.tempMailBase || "", adminKey: rt.opts.tempMailAdminKey || "",
              verify: rt.opts.verify !== false, group: rt.opts.group || "default",
            })
            await rt.state.save()
            return {
              type: "success", key: "register",
              metadata: { acctID: rec.accountID, accountId: rec.email },
            }
          },
        },
      ],

      // loader：把该账号对应的号池 id 绑定到 fetch。无 apiKey（避免 magpie
      // 往私有头里塞 Bearer），所有私有头由 commonHeaders 补齐。
      async loader(getAuthFn) {
        const auth = await getAuthFn()
        const preferId = getAuth(auth)
        return {
          baseURL: rt.apiBase,
          async fetch(input, init) {
            return rt.makeLoaderFetch(preferId)(input, init)
          },
        }
      },

      // 用量：聚合 Theos 钱包 + 订阅摘要（对齐 server/extensions 的 theos/usage）。
      async usage(getAuthFn) {
        await rt.ready()
        const auth = await getAuthFn()
        const id = getAuth(auth)
        let acct = id ? rt.state.pool.list().find((a) => a.id === id) : null
        if (!acct) acct = rt.state.pool.next("")
        if (!acct) return { error: "没有可用账号", windows: [] }
        const windows = []
        let plan = "Free"
        try {
          const al = await rt.upstream.theos(acct)
          rt.state.pool.setAllowance(acct.id, al, null)
          if (al.enabled) {
            const w = { name: "Theos 免费额度", display: `${al.balance ?? "?"} Theos`, unit: "Theos" }
            const n = Number(al.balance)
            if (Number.isFinite(n)) w.balance = n
            if (al.refresh_at) w.resetsAt = al.refresh_at
            windows.push(w)
          }
        } catch (e) { windows.push({ name: "Theos", display: e.message }) }
        try {
          const u = await rt.upstream.usageSummary(acct)
          plan = u.plan || (u.is_pro ? "Pro" : "Free")
          if (u.credits_remaining != null) {
            windows.push({ name: "订阅余额", display: `${u.credits_remaining} credits`, aside: true })
          }
        } catch { /* 保留 Theos 窗口 */ }
        await rt.state.save()
        return { plan, user: acct.username || acct.name, error: "", windows }
      },

      // 每日额度由机器指纹自动发放，网关的 checkin 是配额探测（非领取）。
      // 这里做一次 all-account 配额复探，对齐 /admin/api/checkin。
      async checkin() {
        await rt.ready()
        let ok = 0
        for (const a of rt.state.pool.list()) {
          try {
            const al = await rt.upstream.theos(a)
            rt.state.pool.setAllowance(a.id, al, null)
            ok++
          } catch (e) { rt.state.pool.markResult(a.id, false, e.message) }
        }
        await rt.state.save()
        return { outcome: ok > 0 ? "done" : "failed", message: `复探 ${ok}/${rt.state.pool.size()} 个账号额度` }
      },
    },

    // 每账号一次：模型目录来自上游（动态），转成 magpie Model。
    provider: {
      id: PROVIDER,
      async models(provider) {
        await rt.refreshModels()
        const listed = rt.catalog.toModels()
        return Object.keys(listed).length ? listed : provider.models
      },
    },

    // 会话粘性：网关用 X-Session-Affinity 做上游粘性调度。
    "chat.headers": async (input, output) => {
      if (!input || !input.model || input.model.providerID !== PROVIDER) return
      const sid = String(input.sessionID || "")
      if (AFFINITY_OK.test(sid)) output.headers[H.affinity] = sid
    },

    // 给每个 agent 的工具（magpie 的 MCP 工具服务器）。
    tool: buildTools({
      upstream: rt.upstream, state: rt.state, catalog: rt.catalog,
      log: rt.log,
      runRegister: (o) => runOne({
        pool: rt.state.pool, upstream: rt.upstream,
        domain: rt.opts.domain || o.domain || "",
        backend: o.backend || rt.opts.mailBackend || "static",
        email: o.email, password: o.password,
        base: rt.opts.tempMailBase || "", adminKey: rt.opts.tempMailAdminKey || "",
        verify: false, group: rt.opts.group || "default",
      }),
    }),
  }
}
