// 给每个 agent 的工具（magpie 文档 §"给每个智能体的工具"）。
// 对齐 Go 网关的原生扩展端点 /v1/deepai/theos、/usage、/web_search、
// /find_service，以及管理接口账号/密钥/统计/设置/注册。
//
// magpie 会把这些工具挂到 /mcp/magpie/tools，工具名形如
// deepai-pure_quota / deepai-pure_web_search。
// 依赖 @opencode-ai/plugin 只用于 schema 构造；没有该依赖时降级为纯
// JSON Schema 对象，保证在纯 Node 自测里也能加载。

let toolDef = null
try {
  const mod = await import("@opencode-ai/plugin")
  toolDef = mod.tool
} catch {
  toolDef = null
}

// 统一构造：有 plugin.tool 就走 zod，否则返回带 JSON Schema 的裸对象，
// magpie 同样接受 JSON Schema 对象作为 args。
const z = {
  string: (d) => ({ type: "string", description: d }),
  number: () => ({ type: "number" }),
  boolean: () => ({ type: "boolean" }),
}

function makeTool(description, args, execute) {
  if (toolDef) {
    const argDef = {}
    for (const [k, v] of Object.entries(args)) {
      argDef[k] = toolDef.schema.string().describe(v.description || "")
    }
    return toolDef({ description, args: argDef, execute })
  }
  // JSON Schema 形式（magpie 文档：args 可以是 zod 字段表 / zod 对象 / JSON Schema）
  const properties = {}
  for (const [k, v] of Object.entries(args)) properties[k] = v
  return { description, args: { type: "object", properties }, execute }
}

export function buildTools(ctx) {
  const { upstream, state, catalog, runRegister, log } = ctx
  const acct = () => state.pool.next("")

  return {
    quota: makeTool(
      "查询当前 DeepAI 账号的免费 Theos 额度 / 余额",
      {},
      async () => {
        const a = acct()
        if (!a) return { error: "没有可用账号" }
        try {
          const al = await upstream.theos(a)
          state.pool.setAllowance(a.id, al, null)
          await state.save()
          return { account: a.name, ...al }
        } catch (e) { return { error: e.message } }
      }
    ),
    usage: makeTool(
      "查询 DeepAI 订阅与用量摘要（/get_usage_summary）",
      {},
      async () => {
        const a = acct()
        if (!a) return { error: "没有可用账号" }
        try { return await upstream.usageSummary(a) } catch (e) { return { error: e.message } }
      }
    ),
    web_search: makeTool(
      "调用上游 DeepAI 联网搜索",
      { query: z.string("搜索关键词"), num_results: z.number("结果数量") },
      async ({ query, num_results }) => {
        const a = acct()
        if (!a) return { error: "没有可用账号" }
        try { return await upstream.webSearch(a, { query, num_results: Number(num_results) || 5 }) }
        catch (e) { return { error: e.message } }
      }
    ),
    find_service: makeTool(
      "调用上游 DeepAI 服务推荐",
      { query: z.string("需求描述") },
      async ({ query }) => {
        const a = acct()
        if (!a) return { error: "没有可用账号" }
        try { return await upstream.findService(a, { query }) }
        catch (e) { return { error: e.message } }
      }
    ),
    models: makeTool(
      "列出当前缓存的 DeepAI 模型目录与默认模型",
      {},
      async () => ({ default: catalog.defaultID, updated: catalog.updated, models: catalog.models })
    ),
    accounts: makeTool(
      "列出号池账号（脱敏，不含 API Key）",
      {},
      async () => ({
        count: state.pool.size(),
        accounts: state.pool.list().map((a) => ({
          id: a.id, name: a.name, source: a.source, group: a.group,
          enabled: a.enabled, status: a.status, failures: a.failures,
          isPro: a.isPro, theos: a.theos ? a.theos.balance : null,
        })),
      })
    ),
    add_account: makeTool(
      "把一个上游 API Key 加入号池",
      { key: z.string("DeepAI 上游 API Key（Api-Key 头）"), username: z.string("账号备注名") },
      async ({ key, username }) => {
        const { accountFromAPIKey } = await import("./account.mjs")
        const a = accountFromAPIKey(key, { username, source: "manual" })
        const added = state.pool.upsert(a)
        await state.save()
        log?.(`[deepai] 添加账号 ${a.name} ${added ? "(new)" : "(updated)"}`)
        return { id: a.id, name: a.name, added }
      }
    ),
    import_desktop: makeTool(
      "从本机 DeepAI Code 桌面端凭据文件导入账号",
      { path: z.string("凭据文件路径（可选）") },
      async ({ path }) => {
        const { desktopSecretDirs } = await import("./machine.mjs")
        const { readFile } = await import("node:fs/promises")
        const { accountFromCredentials } = await import("./account.mjs")
        const nodePath = await import("node:path")
        const dirs = desktopSecretDirs(path || "")
        let n = 0
        for (const d of dirs) {
          try {
            const cred = JSON.parse(await readFile(nodePath.join(d, "deepai-account.bin"), "utf8"))
            const a = accountFromCredentials(cred, "desktop")
            state.pool.upsert(a)
            n++
          } catch { /* next */ }
        }
        await state.save()
        return { imported: n, tried: dirs.length }
      }
    ),
    stats: makeTool(
      "查看网关累计请求 / token / 成本统计",
      {},
      async () => ({ stats: state.stats, recent_logs: state.logs.slice(-10) })
    ),
    settings: makeTool(
      "查看或调整设置（fallback_model / max_retries / model_aliases）",
      { json: z.string("要合并的设置 JSON（可选）") },
      async ({ json }) => {
        if (json) {
          try { Object.assign(state.settings, JSON.parse(json)); await state.save() }
          catch (e) { return { error: e.message } }
        }
        return { ...state.settings }
      }
    ),
    register: makeTool(
      "注册一个新 DeepAI 账号并入池（需配置邮箱后端）",
      { email: z.string("邮箱（可选）"), password: z.string("密码（可选）") },
      async ({ email, password }) => {
        const rec = await runRegister({ email, password })
        await state.save()
        return rec
      }
    ),
  }
}
