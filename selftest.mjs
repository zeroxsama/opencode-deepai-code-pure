// 黑盒自测：起一个 mock 上游，验证纯插件直连链路（不跑 Go 网关）。
// bun ./magpie-pure/selftest.mjs  或  node ./magpie-pure/selftest.mjs
import assert from "node:assert/strict"
import http from "node:http"
import os from "node:os"
import fs from "node:fs/promises"
import path from "node:path"

// ---- mock 上游状态 ----
const seen = {
  headers: [], chat: [], modelsCalls: 0, theosCalls: 0, usageCalls: 0,
  chatN: 0,
}
let chatMode = "ok" // ok | busy-once | unauthorized-once | switch

const MODELS = {
  models: [
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash", reasoning: false,
      input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072,
      premier: false, api: "", theosPerRequest: "0" },
    { id: "gpt-6-astra", name: "GPT-6 Astra", reasoning: true,
      input: ["text"], contextWindow: 200000, maxTokens: 64000,
      premier: true, api: "openai-responses", theosPerRequest: "0.5" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true,
      input: ["text"], contextWindow: 200000, maxTokens: 32000, premier: true },
  ],
  default: "glm-5.3-flash",
}

const server = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    const send = (code, obj, type = "application/json", headers = {}) => {
      res.writeHead(code, { "content-type": type, ...headers })
      res.end(typeof obj === "string" ? obj : JSON.stringify(obj))
    }
    const u = req.url
    seen.headers.push({ url: u, h: { ...req.headers } })

    if (u === "/deepai_code/models") { seen.modelsCalls++; return send(200, MODELS) }

    if (u === "/deepai_code/theos") {
      seen.theosCalls++
      return send(200, { enabled: true, balance: "1.50000", granted: "0", refresh_at: "2026-11-07T00:00:00Z", lane_version: 2 })
    }
    if (u === "/get_usage_summary") {
      seen.usageCalls++
      return send(200, { is_pro: false, plan: "Free", is_authenticated: true, credits_remaining: 12.4, period_description: "2026-11" })
    }

    if (u === "/deepai_code/chat/completions" && req.method === "POST") {
      seen.chatN++
      const b = JSON.parse(body || "{}")
      seen.chat.push({ body: b, h: { ...req.headers } })

      if (chatMode === "busy-once" && seen.chatN === 1) {
        return send(409, { error: { code: "session_busy", message: "busy" } }, "application/json", { "retry-after": "0" })
      }
      if (chatMode === "unauthorized-once" && seen.chatN === 1) {
        return send(401, { error: { message: "bad key" } })
      }
      // 私有头断言样本
      const out = {
        id: "chatcmpl-1", object: "chat.completion", model: b.model,
        choices: [{ index: 0, message: { role: "assistant", content: "pong", reasoning: "think" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8, cost: 0.001 },
      }
      if (b.stream) {
        const sse =
          `data: ${JSON.stringify({ id: "c", model: b.model, choices: [{ delta: { content: "po", reasoning: "th" } }] })}\n\n` +
          `data: [DONE]\n\n`
        return send(200, sse, "text/event-stream")
      }
      return send(200, out)
    }

    // 注册链路 mock
    if (u === "/get_user_login_type") return send(200, { user_exists: false })
    if (u === "/save_custom_signup_data") return send(200, {})
    if (u === "/daily-time-sync/registration/") return send(201, { key: "sess" })
    if (u === "/daily-time-sync/login/") return send(200, { key: "sess" })
    if (u === "/daily-time-sync/user/") return send(200, {
      pk: 1, username: "new@demo", email: "new@demo",
      userprofile: { api_key: "uuid-new-key-0001" }, userprofile2: { plan: "free" },
    })
    if (u.startsWith("/verify_email")) return send(200, "ok", "text/html")
    if (u === "/daily-time-sync/logout/") return send(200, {})

    return send(404, { error: "not found" })
  })
})

await new Promise((r) => server.listen(0, "127.0.0.1", r))
const ORIGIN = `http://127.0.0.1:${server.address().port}`
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "deepai-pure-test-"))

// 让 index.mjs 的 RUNTIME 单例用 mock origin；必须在首次 import 前设置 env，
// 但这里显式用 options.origin 更可靠。detectMachineRaw 用 machineID 覆盖。
process.env.DEEPAI_MACHINE_ID = "11111111-2222-3333-4444-555555555555"

const ns = await import("./index.mjs")
const input = {
  directory: tmp,
  client: { app: { log: () => {} } },
  magpie: { options: {}, load: () => {} },
}
const options = {
  origin: ORIGIN,
  machineID: "11111111-2222-3333-4444-555555555555",
  importDesktop: false, // 自测不碰真实桌面凭据
  noAdminServer: true,  // 自测不起账号管理本地服务
}

try {
  // 1) 入口只导出一个函数
  const fns = Object.entries(ns).filter(([, v]) => typeof v === "function")
  assert.equal(fns.length, 1, "入口应只导出一个插件函数")
  assert.equal(fns[0][0], "DeepAIPurePlugin")
  console.log("✓ 入口导出：仅 DeepAIPurePlugin 一个函数")

  const hooks = await ns.DeepAIPurePlugin(input, options)

  // 2) config
  const cfg = {}
  await hooks.config(cfg)
  assert.ok(cfg.provider.deepai, "config 声明供应商 deepai")
  assert.equal(cfg.provider.deepai.npm, "@ai-sdk/openai-compatible")
  assert.equal(cfg.provider.deepai.api, ORIGIN + "/deepai_code", "api 必须含 /deepai_code 前缀")
  const cfg2 = { provider: { deepai: { name: "custom" } } }
  await hooks.config(cfg2)
  assert.equal(cfg2.provider.deepai.name, "custom", "??= 保护用户配置")
  console.log("✓ config：供应商声明 + apiBase 前缀 + ??= 保护")

  // 3) provider.models（动态目录 + free + Responses）
  const models = await hooks.provider.models({ models: cfg.provider.deepai.models })
  assert.ok(models["glm-5.3-flash"], "含上游下发模型")
  assert.equal(models["glm-5.3-flash"].free, true, "免费模型标记 free")
  assert.equal(models["glm-5.3-flash"].limit.context, 1048576)
  assert.equal(models["gpt-6-astra"].provider.npm, "@ai-sdk/openai", "Responses 模型")
  assert.equal(models["gpt-6-astra"].rate, 0.5, "theosPerRequest -> rate")
  assert.ok(models["claude-opus-5-5"], "付费模型也在目录")
  console.log("✓ provider.models：动态目录 + free/rate/Responses/别名")

  // 4) 登录方式：四种
  assert.equal(hooks.auth.methods.length, 4, "四种登录方式")
  assert.equal(hooks.auth.methods[0].type, "api")
  assert.equal(hooks.auth.methods[2].type, "oauth")
  console.log("✓ auth.methods：api / 导入 / oauth / 注册 共 4 种")

  // 5) 用方式 1 登录两个账号 -> 号池 2 个 Key
  const r1 = await hooks.auth.methods[0].authorize({ key: "uuid-key-AAAA-1111", metadata: { username: "a@demo" } })
  assert.equal(r1.type, "success")
  const r2 = await hooks.auth.methods[0].authorize({ key: "uuid-key-BBBB-2222", metadata: { username: "b@demo" } })
  assert.equal(r2.type, "success")
  assert.notEqual(r1.metadata.acctID, r2.metadata.acctID, "两个账号不同 acctID")
  console.log("✓ 登录：填 Key 产生两个号池账号")

  // 6) loader.fetch 直连推理（私有头 + 号池）
  const auth = { type: "api", key: "x", metadata: { acctID: r1.metadata.acctID } }
  const load = await hooks.auth.loader(async () => auth)
  assert.equal(load.baseURL, ORIGIN + "/deepai_code")
  assert.equal(load.apiKey, undefined, "不应让 magpie 注入 Bearer")
  const resp = await load.fetch(ORIGIN + "/deepai_code/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal(resp.status, 200)
  const out = await resp.json()
  assert.equal(out.model, "glm-5.3-flash", "model 改回对外名")
  assert.equal(out.choices[0].message.reasoning_content, "think", "reasoning -> reasoning_content")
  assert.equal(out.choices[0].message.content, "pong")
  // 私有头断言
  const chat1 = seen.chat[seen.chat.length - 1]
  assert.equal(chat1.h["x-deepai-code-theos"], "2", "Theos 车道头")
  assert.ok(chat1.h["x-deepai-code-machine"], "机器指纹头存在")
  assert.ok(chat1.h["api-key"], "Api-Key 头存在")
  assert.equal(chat1.h["api-key"].length > 0, true)
  console.log("✓ loader.fetch：号池直连 + Api-Key/Theos/Machine 私有头 + 响应归一化")

  // 7) 别名解析：gpt-4o -> 默认模型
  await load.fetch(ORIGIN + "/deepai_code/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
  })
  const aliasBody = seen.chat[seen.chat.length - 1].body
  assert.equal(aliasBody.model, "glm-5.3-flash", "别名解析到真实 API id")
  console.log("✓ 别名：gpt-4o -> glm-5.3-flash")

  // 8) chat.headers 会话粘性
  const hh = { headers: {} }
  await hooks["chat.headers"]({ model: { providerID: "deepai" }, sessionID: "sess_abc-1" }, hh)
  assert.equal(hh.headers["X-Session-Affinity"], "sess_abc-1")
  const hh2 = { headers: {} }
  await hooks["chat.headers"]({ model: { providerID: "other" }, sessionID: "sess_abc-1" }, hh2)
  assert.equal(hh2.headers["X-Session-Affinity"], undefined)
  const hh3 = { headers: {} }
  await hooks["chat.headers"]({ model: { providerID: "deepai" }, sessionID: "bad id!" }, hh3)
  assert.equal(hh3.headers["X-Session-Affinity"], undefined)
  console.log("✓ chat.headers：仅本供应商 + 合法 sessionID 注入粘性头")

  // 9) usage：Theos 钱包 + 订阅
  const u = await hooks.auth.usage(async () => auth)
  assert.equal(u.plan, "Free")
  assert.ok(u.windows.length >= 2, "Theos + 订阅两个窗口")
  assert.equal(u.windows[0].balance, 1.5)
  assert.equal(u.windows[0].unit, "Theos")
  console.log("✓ auth.usage：Theos 钱包 + 订阅余额窗口")

  // 10) 409 session_busy 退避重试
  seen.chatN = 0; chatMode = "busy-once"
  const rBusy = await load.fetch(ORIGIN + "/deepai_code/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal(rBusy.status, 200, "409 后退避重试成功")
  assert.equal(seen.chatN, 2, "恰好发了两次（1 次 409 + 1 次成功）")
  console.log("✓ 容量：409 session_busy 按 Retry-After 退避重试")

  // 11) 401 换号重试
  seen.chatN = 0; chatMode = "unauthorized-once"
  const rSwitch = await load.fetch(ORIGIN + "/deepai_code/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal(rSwitch.status, 200, "401 后换号成功")
  assert.equal(seen.chatN, 2)
  const keys = seen.chat.slice(-2).map((c) => c.h["api-key"])
  assert.notEqual(keys[0], keys[1], "两次用了不同的 Api-Key（换号）")
  console.log("✓ 故障切换：401 换号，两次 Api-Key 不同")

  // 12) 流式 SSE 归一化
  chatMode = "ok"
  const rStream = await load.fetch(ORIGIN + "/deepai_code/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }], stream: true }),
  })
  const sse = await rStream.text()
  assert.ok(sse.includes("reasoning_content"), "SSE chunk 归一化 reasoning")
  assert.ok(sse.includes("[DONE]"), "保留 [DONE]")
  assert.ok(!sse.includes("content-length"), "流式去掉 framing")
  console.log("✓ SSE：逐块归一化 reasoning_content，保留 [DONE]")

  // 13) checkin 全账号配额复探
  const ck = await hooks.auth.checkin()
  assert.ok(ck.outcome === "done" || ck.outcome === "failed")
  assert.ok(seen.theosCalls >= 2, "checkin 复探了账号")
  console.log("✓ auth.checkin：全账号配额复探")

  // 14) 工具集
  assert.ok(hooks.tool, "提供 tool 钩子")
  const toolNames = Object.keys(hooks.tool)
  assert.ok(toolNames.includes("quota") && toolNames.includes("web_search") && toolNames.includes("register"))
  console.log("✓ tool：quota/usage/web_search/find_service/models/accounts/… 共 " + toolNames.length + " 个")

  // 15) 状态持久化 + AES-256-GCM 加密（独立 State 验证）
  const { State } = await import("./lib/state.mjs")
  const st = new State({ directory: tmp, masterKeyRaw: "a".repeat(64) })
  await st.load()
  assert.ok(st.pool.size() >= 2, "状态里持久化了 >=2 个账号")
  const { accountFromAPIKey } = await import("./lib/account.mjs")
  st.pool.upsert(accountFromAPIKey("uuid-key-CCCC-3333", { username: "c@demo" }))
  st.stats.total_requests = 42
  await st.save()
  const raw = await fs.readFile(path.join(tmp, "deepai-pure-state.json"), "utf8")
  const j = JSON.parse(raw)
  assert.equal(j.sealed, true, "状态文件加密")
  assert.ok(j.iv && j.tag && j.data)
  assert.ok(!raw.includes("uuid-key"), "明文 Key 不落盘")
  const st2 = new State({ directory: tmp, masterKeyRaw: "a".repeat(64) })
  await st2.load()
  assert.equal(st2.stats.total_requests, 42, "加密状态可解密回读")
  assert.ok(st2.pool.size() >= 3, "加密账号可回读")
  console.log("✓ State：AES-256-GCM 加密落盘 + 解密回读")

  // 16) 机器指纹确定性
  const { machineFingerprint, newMachineUUID } = await import("./lib/machine.mjs")
  const fp = machineFingerprint("ABC-123")
  assert.equal(fp, machineFingerprint("abc-123"), "大小写归一")
  assert.equal(fp.length, 64, "sha256 hex")
  assert.equal(machineFingerprint(""), "")
  assert.match(newMachineUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "UUID v4")
  console.log("✓ machine：sha256 指纹 + UUID v4")

  // 17) 协议归一化单测
  const { transformChatResponse, parseUsage } = await import("./lib/transform.mjs")
  const norm = JSON.parse(transformChatResponse(
    JSON.stringify({ model: "real", choices: [{ message: { content: "x", reasoning: "r" } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }),
    "public"))
  assert.equal(norm.model, "public")
  assert.equal(norm.choices[0].message.reasoning_content, "r")
  assert.equal(parseUsage({ input_tokens: 7, output_tokens: 8 }).prompt_tokens, 7, "Responses 用量字段")
  console.log("✓ transform：model 改写 / reasoning_content / 双协议 usage")

  // 18) 号池调度单测
  const { Pool } = await import("./lib/pool.mjs")
  const { accountFromAPIKey: mk } = await import("./lib/account.mjs")
  const p = new Pool([mk("k1"), mk("k2"), mk("k3")])
  p.setAllowance(p.accounts[0].id, { enabled: true, balance: "0" }, null)
  const first = p.next()
  assert.notEqual(first.id, p.accounts[0].id, "0 额度账号第一轮被跳过")
  console.log("✓ Pool：0 额度两轮筛选 + 轮询")

  console.log("\n全部断言通过。")
} finally {
  server.close()
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
}
