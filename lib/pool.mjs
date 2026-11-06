// 号池调度，逐条对齐 internal/store/store.go：
//   NextAccountGroup（两轮：先 needQuota，再全集回退）、pickLocked（轮询 +
//   失败最少）、hasQuota（0 额度 15 分钟陈旧判定）、MarkAccountResult、
//   SetAccountAllowance、UpsertAccount（按 keyID/email 去重）。

import { keyID } from "./account.mjs"
import { QUOTA_STALE_MS } from "./constants.mjs"

export function hasQuota(a) {
  if (!a || !a.theos || !a.theos.enabled) return true
  const bal = String(a.theos.balance ?? "").trim()
  if (!bal) return true
  const v = Number(bal)
  if (!Number.isFinite(v)) return true
  if (v > 0) return true
  const checkedAt = a.theos.checkedAt || 0
  if (checkedAt <= 0) return true
  return Date.now() - checkedAt * 1000 > QUOTA_STALE_MS
}

function pickLocked(accounts, rotate, eligible, needQuota) {
  const n = accounts.length
  let best = null
  let bestIdx = -1
  for (let i = 0; i < n; i++) {
    const idx = (rotate + i) % n
    const a = accounts[idx]
    if (!eligible(a)) continue
    if (needQuota && !hasQuota(a)) continue
    if (best === null || (a.failures || 0) < (best.failures || 0)) {
      best = a
      bestIdx = idx
    }
    if ((a.failures || 0) === 0) {
      return { acct: a, rotate: (idx + 1) % n }
    }
  }
  if (bestIdx >= 0) return { acct: best, rotate: (bestIdx + 1) % n }
  return { acct: best, rotate }
}

export class Pool {
  constructor(accounts = []) {
    this.accounts = accounts
    this.rotate = 0
  }

  list() { return this.accounts.slice() }
  size() { return this.accounts.length }

  upsert(a) {
    const kid = keyID(a)
    for (let i = 0; i < this.accounts.length; i++) {
      const ex = this.accounts[i]
      const sameEmail =
        a.email && ex.email && a.email.toLowerCase() === ex.email.toLowerCase()
      if (keyID(ex) === kid || sameEmail) {
        // 保留历史故障计数与配额缓存（store_test.go 的语义）
        a.failures = ex.failures
        a.theos = a.theos || ex.theos
        a.status = ex.status
        a.lastErr = ex.lastErr
        a.registeredAt = a.registeredAt || ex.registeredAt
        this.accounts[i] = a
        return false
      }
    }
    this.accounts.push(a)
    return true
  }

  remove(id) {
    const i = this.accounts.findIndex((a) => a.id === id)
    if (i < 0) return false
    this.accounts.splice(i, 1)
    return true
  }

  next(group = "") {
    const n = this.accounts.length
    if (n === 0) return null
    const g = String(group || "").trim()
    const eligible = (a) =>
      a.enabled !== false && (g === "" || String(a.group || "default").toLowerCase() === g.toLowerCase())
    const r1 = pickLocked(this.accounts, this.rotate, eligible, true)
    if (r1.acct) { this.rotate = r1.rotate; return r1.acct }
    const r2 = pickLocked(this.accounts, this.rotate, eligible, false)
    this.rotate = r2.rotate
    return r2.acct
  }

  markResult(id, ok, note = "") {
    for (const a of this.accounts) {
      if (a.id !== id) continue
      a.lastUsed = Math.floor(Date.now() / 1000)
      if (ok) {
        a.failures = 0
        a.status = "ok"
        a.lastErr = ""
        if (note) a.note = note
      } else {
        a.failures = (a.failures || 0) + 1
        a.status = "error"
        a.lastErr = note
      }
      return
    }
  }

  setAllowance(id, al, err = null) {
    for (const a of this.accounts) {
      if (a.id !== id) continue
      a.lastUsed = Math.floor(Date.now() / 1000)
      if (err) {
        a.status = "error"
        a.lastErr = String(err.message || err)
        a.failures = (a.failures || 0) + 1
        return
      }
      a.theos = { ...al, checkedAt: Math.floor(Date.now() / 1000) }
      a.status = "ok"
      a.lastErr = ""
      a.failures = 0
      return
    }
  }
}
