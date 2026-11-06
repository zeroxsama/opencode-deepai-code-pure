// 账号模型，对齐 internal/deepai/import.go + types.go 的 Account。
// 一个账号 = 一个上游 API Key（+ 可选浏览器指纹 / 独立机器指纹）。

import { createHash, randomBytes } from "node:crypto"
import { newMachineUUID, machineFingerprint } from "./machine.mjs"
import { DEFAULT_UA } from "./constants.mjs"

export const randomHex = (n) => randomBytes(n).toString("hex")
export const keyFingerprint = (k) => createHash("sha256").update(k).digest("hex").slice(0, 16)
export const shortHash = (k) => keyFingerprint(k).slice(0, 8)

export function validateKey(key) {
  const s = String(key || "").trim()
  if (!s) throw new Error("API Key 不能为空")
  if (s.length > 512 || /[ \t\r\n]/.test(s)) throw new Error("API Key 格式非法")
  return s
}

// 对齐 AccountFromAPIKey
export function accountFromAPIKey(key, opts = {}) {
  const k = validateKey(key)
  const username = String(opts.username || "").trim()
  return {
    id: randomHex(8),
    name: username || `DeepAI ${shortHash(k)}`,
    source: opts.source || "manual",
    apiKey: k,
    username,
    isPro: !!opts.isPro,
    group: opts.group || "default",
    enabled: opts.enabled !== false,
    status: "unknown",
    email: opts.email || "",
    password: opts.password || "",
    plan: opts.plan || "",
    emailVerified: !!opts.emailVerified,
    registeredAt: opts.registeredAt || 0,
    proxy: opts.proxy || "",
    fingerprint: opts.fingerprint || "",
    userAgent: opts.userAgent || DEFAULT_UA,
    acceptLanguage: opts.acceptLanguage || "en-US,en;q=0.9",
    secCHUA: opts.secCHUA || '"Chromium";v="156", "Google Chrome";v="156"',
    platform: opts.platform || '"Windows"',
    machineID: opts.machineID || newMachineUUID(),
    failures: 0,
    lastUsed: 0,
    lastErr: "",
    note: "",
    theos: null,
  }
}

// 从桌面端凭据 JSON 构造（import.go AccountFromCredentials）
export function accountFromCredentials(cred, source = "desktop") {
  return accountFromAPIKey(cred.apiKey, {
    username: cred.username,
    isPro: !!cred.isPro,
    source,
  })
}

export const keyID = (a) => keyFingerprint(a.apiKey)

// 账号级/进程级机器指纹选择，对齐 client.commonHeaders。
export function accountMachineFingerprint(acct, processFP) {
  if (acct && acct.machineID) {
    const f = machineFingerprint(acct.machineID)
    if (f) return f
  }
  return processFP || ""
}
