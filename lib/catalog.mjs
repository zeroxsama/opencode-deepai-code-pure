// 模型目录 + 别名解析，对齐 internal/registry/registry.go 与
// server/common.go 的 resolveModel。上游目录动态下发，插件做缓存 + 别名 +
// 兜底回落（任意客户端开箱即用）。

import { BUILTIN_ALIASES, DEFAULT_MODEL } from "./constants.mjs"

const norm = (s) => String(s || "").trim().toLowerCase()
  .replace(/^deepai\//, "").replace(/^openai\//, "")

export function isResponses(m) { return m && m.api === "openai-responses" }
export function isFree(m) {
  if (!m) return false
  if (m.theosPerRequest != null && m.theosPerRequest !== "") {
    const v = String(m.theosPerRequest)
    return v === "0" || v === "0.0" || v === "0.00"
  }
  return !m.premier
}
export function supportsImage(m) {
  return Array.isArray(m && m.input) && m.input.includes("image")
}

export class Catalog {
  constructor() {
    this.models = []
    this.defaultID = DEFAULT_MODEL
    this.aliases = {}
    this.fallback = ""
    this.updated = 0
  }

  update(models, def) {
    this.models = models
    this.defaultID = def || (models[0] && models[0].id) || DEFAULT_MODEL
    this.updated = Math.floor(Date.now() / 1000)
  }

  find(id) {
    const n = norm(id)
    return this.models.find((m) => norm(m.id) === n) || null
  }

  // 对齐 registry.Resolve：精确 → 自定义别名 → 内置别名 → 包含匹配 →
  // 名称匹配 → 兜底 → 第一个模型。
  resolve(name, fallback = "") {
    const n = norm(name)
    const effectiveDefault = (this.fallback && this.find(this.fallback)?.id) || this.fallback || this.defaultID
    const def = fallback || effectiveDefault
    if (n) {
      let m = this.find(n)
      if (m) return m
      const alias = this.aliases[n] || BUILTIN_ALIASES[n]
      if (alias) { m = this.find(alias); if (m) return m }
      m = this.models.find((x) => norm(x.id).includes(n))
      if (m) return m
      m = this.models.find((x) => n === norm(x.name).replace(/\s+/g, "-"))
      if (m) return m
    }
    m = this.find(def)
    if (m) return m
    return this.models[0] || defaultModelEntry()
  }

  // 转成 magpie/OpenCode 的 Model（含 magpie 独有 free/rate）。
  toModels() {
    const out = {}
    for (const m of this.models) {
      const model = {
        id: m.id,
        name: m.name || m.id,
        limit: {
          context: Number(m.contextWindow) || 200000,
          output: Number(m.maxTokens) || 32000,
        },
        reasoning: !!m.reasoning,
        tool_call: true,
        modalities: { input: Array.isArray(m.input) && m.input.length ? m.input : ["text"] },
      }
      if (isFree(m)) model.free = true
      if (m.theosPerRequest) {
        const r = Number(m.theosPerRequest)
        if (Number.isFinite(r) && r > 0) model.rate = r
      }
      if (isResponses(m)) model.provider = { npm: "@ai-sdk/openai" }
      out[m.id] = model
    }
    // 自定义别名也列出来（registry.List 语义）
    for (const [alias, target] of Object.entries(this.aliases)) {
      const m = this.find(target)
      if (!m || out[alias]) continue
      out[alias] = { ...out[m.id], id: alias, name: `${alias} → ${m.name}` }
    }
    return out
  }
}

export function defaultModelEntry() {
  return {
    id: DEFAULT_MODEL, name: "GLM 5.3 Flash", reasoning: false,
    input: ["text"], contextWindow: 1048576, maxTokens: 131072,
    premier: false, api: "", theosPerRequest: "0",
  }
}
