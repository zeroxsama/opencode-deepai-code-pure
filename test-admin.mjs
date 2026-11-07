// 账号管理本地服务的集成测试：起真实 HTTP 服务（端口 0 自动分配），用 fetch 打
// 全部 API，验证 guard / 路由 / 脱敏 / CRUD / 设置 / 配额 / 统计。
// 复用真实 State/Pool/Catalog，mock 上游的 theos/usageSummary 与 refreshModels。
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { State } from "./lib/state.mjs"
import { Catalog } from "./lib/catalog.mjs"
import { startAdminServer } from "./lib/admin-server.mjs"

const tmp = await mkdtemp(path.join(os.tmpdir(), "deepai-admin-test-"))
const state = new State({ directory: tmp })
const catalog = new Catalog()
catalog.update([{ id: "glm-5.3-flash", name: "GLM 5.3 Flash" }], "glm-5.3-flash")

const upstream = {
  async theos() { return { enabled: true, balance: 42 } },
  async usageSummary() { return { plan: "Pro", credits_remaining: 100 } },
}
const rt = {
  state, catalog, upstream,
  opts: { domain: "", mailBackend: "static", tempMailBase: "", tempMailAdminKey: "", verify: false, group: "default" },
  async ready() {},
  async importDesktop() { return 2 },
  async refreshModels() { state.models = [{ id: "glm-5.3-flash", name: "GLM 5.3 Flash" }]; state.defaultModel = "glm-5.3-flash" },
  log() {},
}

const info = await startAdminServer({ port: 0, token: "test-token", getRuntime: async () => rt })
const base = `http://127.0.0.1:${info.port}`
const H = { "X-Admin-Token": "test-token", "Content-Type": "application/json" }
async function call(method, p, body) {
  const r = await fetch(base + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}

try {
  // 1) guard：无 token 的 /api 被拒
  let r = await fetch(base + "/api/state")
  assert.equal(r.status, 403, "无 token 应 403")
  console.log("✓ guard：无 token 的 /api 被拒")

  // 2) 根页返回 HTML 且带注入的 token
  r = await fetch(base + "/")
  const html = await r.text()
  assert.equal(r.status, 200)
  assert.ok(html.includes("账号管理") && html.includes("test-token"), "根页含 UI 与注入 token")
  console.log("✓ 根页：返回管理 UI 且注入进程内 token")

  // 3) 空号池
  let j = await call("GET", "/api/state")
  assert.equal(j.json.count, 0)
  console.log("✓ 初始状态：空号池")

  // 4) 加号（脱敏，不泄露完整 key）
  const KEY = "12345678-abcd-efgh-ijkl-999999999999"
  j = await call("POST", "/api/accounts", { key: KEY, username: "alice", group: "vip" })
  assert.equal(j.json.ok, true)
  assert.equal(j.json.added, true)
  assert.ok(!JSON.stringify(j.json).includes(KEY), "响应绝不回显完整 apiKey")
  const id = j.json.account.id
  console.log("✓ 加号：写入号池且响应脱敏（不回显 apiKey）")

  // 5) 列表：1 个账号，字段齐全
  j = await call("GET", "/api/state")
  assert.equal(j.json.count, 1)
  assert.equal(j.json.accounts[0].name, "alice")
  assert.equal(j.json.accounts[0].group, "vip")
  assert.ok(!JSON.stringify(j.json).includes(KEY))
  console.log("✓ 列表：count=1、分组正确、全表脱敏")

  // 6) 启停 + 改分组 + 备注
  j = await call("PATCH", "/api/accounts/" + id, { enabled: false, group: "resting", note: "维护中" })
  assert.equal(j.json.account.enabled, false)
  assert.equal(j.json.account.group, "resting")
  assert.equal(j.json.account.note, "维护中")
  console.log("✓ 编辑：停用 / 分组 / 备注")

  // 7) 查配额（写回 theos 缓存）
  j = await call("GET", "/api/quota/" + id)
  assert.equal(j.json.allowance.balance, 42)
  assert.equal(j.json.account.theos.balance, 42)
  console.log("✓ 配额：调用上游并写回账号 theos 缓存")

  // 8) 用量摘要
  j = await call("GET", "/api/usage-summary/" + id)
  assert.equal(j.json.usage.plan, "Pro")
  console.log("✓ 用量摘要")

  // 9) 设置
  j = await call("POST", "/api/settings", { fallback_model: "glm-5.3-flash", max_retries: 5 })
  assert.equal(j.json.settings.max_retries, 5)
  assert.equal(state.settings.max_retries, 5)
  console.log("✓ 设置：写入 state.settings")

  // 10) 刷新模型目录
  j = await call("POST", "/api/refresh-models", {})
  assert.equal(j.json.count, 1)
  console.log("✓ 刷新模型目录")

  // 11) 导入桌面凭据
  j = await call("POST", "/api/import-desktop", {})
  assert.equal(j.json.imported, 2)
  console.log("✓ 导入桌面凭据")

  // 12) 全账号配额复探
  j = await call("POST", "/api/checkin", {})
  assert.equal(j.json.probed, 1)
  console.log("✓ 全账号配额复探")

  // 13) 统计
  j = await call("GET", "/api/stats")
  assert.ok(j.json.stats && Array.isArray(j.json.recent_logs))
  console.log("✓ 累计统计 / 日志")

  // 14) 删号
  j = await call("DELETE", "/api/accounts/" + id)
  assert.equal(j.json.removed, true)
  j = await call("GET", "/api/state")
  assert.equal(j.json.count, 0)
  console.log("✓ 删号：号池回到 0")

  // 15) 未知接口 404
  j = await call("GET", "/api/nope")
  assert.equal(j.status, 404)
  console.log("✓ 未知接口 404")

  console.log("\n全部断言通过。")
} finally {
  await info.close()
  await rm(tmp, { recursive: true, force: true })
}
