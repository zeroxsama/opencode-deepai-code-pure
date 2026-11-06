// 状态持久化，对齐 internal/store/store.go + store/state_seal.go。
//
// 落盘位置用 magpie 交给插件的 directory（= magpie 配置目录），文件名
// deepai-pure-state.json。可选整体 AES-256-GCM 加密：主密钥来自选项或
// DEEPAI2API_MASTER_KEY（对齐 Go 的 OpenWithKey）。

import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { Pool } from "./pool.mjs"

const FILE = "deepai-pure-state.json"

function fromKeyEnv(masterKeyRaw) {
  if (!masterKeyRaw) return null
  const s = String(masterKeyRaw).trim()
  // 64 hex 或 base64 的 32 字节
  try {
    if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex")
    const b = Buffer.from(s, "base64")
    if (b.length === 32) return b
  } catch { /* ignore */ }
  return null
}

function seal(plaintext, key) {
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", key, iv)
  const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()])
  const tag = c.getAuthTag()
  return JSON.stringify({ sealed: true, iv: iv.toString("base64"), tag: tag.toString("base64"), data: enc.toString("base64") })
}
function unseal(text, key) {
  const j = JSON.parse(text)
  if (!j.sealed) return text
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(j.iv, "base64"))
  d.setAuthTag(Buffer.from(j.tag, "base64"))
  return Buffer.concat([d.update(Buffer.from(j.data, "base64")), d.final()]).toString("utf8")
}

export class State {
  constructor({ directory, masterKeyRaw } = {}) {
    this.dir = directory || (typeof process !== "undefined" && process.cwd()) || "."
    this.path = path.join(this.dir, FILE)
    this.key = fromKeyEnv(masterKeyRaw || (typeof process !== "undefined" ? process.env.DEEPAI2API_MASTER_KEY : ""))
    this.pool = new Pool()
    this.settings = {
      model_aliases: {}, request_timeout_sec: 600, max_retries: 3,
      log_keep: 500, fallback_model: "",
    }
    this.stats = { total_requests: 0, failed_requests: 0, total_chars_out: 0, total_tokens_in: 0, total_tokens_out: 0, total_cost: 0, started_at: Math.floor(Date.now() / 1000) }
    this.logs = []
    this.models = []
    this.defaultModel = ""
    this.modelsUpdated = 0
    this.machineID = ""
    this._lastSaved = ""
  }

  snapshot() {
    return {
      accounts: this.pool.accounts, settings: this.settings, stats: this.stats,
      logs: this.logs, models: this.models, default_model: this.defaultModel,
      models_updated: this.modelsUpdated, machine_id: this.machineID,
    }
  }

  async load() {
    try {
      const raw = await readFile(this.path, "utf8")
      const text = this.key ? unseal(raw, this.key) : raw
      const j = JSON.parse(text)
      this.pool = new Pool(Array.isArray(j.accounts) ? j.accounts : [])
      this.settings = { ...this.settings, ...(j.settings || {}) }
      this.stats = { ...this.stats, ...(j.stats || {}) }
      this.logs = Array.isArray(j.logs) ? j.logs : []
      this.models = Array.isArray(j.models) ? j.models : []
      this.defaultModel = j.default_model || ""
      this.modelsUpdated = j.models_updated || 0
      this.machineID = j.machine_id || ""
      this._lastSaved = JSON.stringify(this.snapshot())
      return true
    } catch {
      return false
    }
  }

  async save() {
    const plain = JSON.stringify(this.snapshot())
    if (plain === this._lastSaved) return // 跳过无变化的重复写盘
    const text = this.key ? seal(plain, this.key) : plain
    await mkdir(this.dir, { recursive: true }) // 首次运行目录可能还不存在
    await writeFile(this.path, text, { mode: 0o600 })
    this._lastSaved = plain
  }

  record(row) {
    this.stats.total_requests++
    if (row.status >= 400) this.stats.failed_requests++
    this.stats.total_chars_out += row.output_len || 0
    this.stats.total_tokens_in += row.tokens_in || 0
    this.stats.total_tokens_out += row.tokens_out || 0
    this.stats.total_cost += row.cost || 0
    const keep = this.settings.log_keep || 500
    this.logs.push({ time: Math.floor(Date.now() / 1000), ...row })
    if (this.logs.length > keep) this.logs.splice(0, this.logs.length - keep)
  }
}
