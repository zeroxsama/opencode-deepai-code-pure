// 对齐 internal/deepai/machine.go：机器指纹采集、sha256、占位过滤、随机 UUID。
// magpie 插件跑在 Bun 宿主里，可以用 Bun.$ 执行系统命令（文档 §"插件能拿到什么"）。

import { createHash, randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir, platform } from "node:os"
import path from "node:path"

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/
const PLACEHOLDERS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "03000200-0400-0500-0006-000700080009",
])

export function machineFingerprint(raw) {
  const s = String(raw || "").trim().toLowerCase()
  if (!s) return ""
  return createHash("sha256").update(s).digest("hex")
}

export function parseUUID(s) {
  const m = UUID_RE.exec(String(s || ""))
  if (!m) return ""
  const low = m[0].toLowerCase()
  return PLACEHOLDERS.has(low) ? "" : low
}

export function newMachineUUID() {
  const b = randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function parseMachineGuid(out) {
  const m = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(String(out || ""))
  if (!m) return ""
  return UUID_RE.test(m[1]) ? m[1].toLowerCase() : m[1].trim()
}

async function run(name, args) {
  try {
    // Bun 的 shell；Node 下用 child_process.execFile 兜底。
    if (typeof Bun !== "undefined" && Bun.$) {
      const r = await Bun.$`${name} ${args}`.quiet().nothrow()
      return r.stdout ? r.stdout.toString() : ""
    }
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const out = await promisify(execFile)(name, args, { timeout: 12000 }).catch(() => ({ stdout: "" }))
    return String(out.stdout || "")
  } catch {
    return ""
  }
}

// 返回原始机器标识（未 sha256）；失败返回空串。
export async function detectMachineRaw() {
  const goos = platform()
  try {
    if (goos === "win32") {
      const out = await run("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        "(Get-CimInstance Win32_ComputerSystemProduct).UUID",
      ])
      const id = parseUUID(out)
      if (id) return id
      const reg = await run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"])
      return parseMachineGuid(reg)
    }
    if (goos === "darwin") {
      const out = await run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"])
      const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)
      if (m && UUID_RE.test(m[1])) return m[1].toLowerCase()
    }
    if (goos === "linux") {
      for (const p of ["/sys/class/dmi/id/product_uuid", "/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try {
          const s = (await readFile(p, "utf8")).trim()
          if (!s) continue
          return parseUUID(s) || s
        } catch { /* next */ }
      }
    }
  } catch { /* best effort */ }
  return ""
}

// 桌面端数据目录（helpers.DesktopBaseDirs / DesktopSecretDirs）。
export function desktopBaseDirs(explicit) {
  const out = []
  const push = (v) => { if (v) out.push(v) }
  if (explicit) push(explicit)
  push(process.env.T3CODE_HOME)
  push(process.env.DEEPAI_CODE_HOME)
  push(path.join(homedir(), ".deepai-code"))
  return [...new Set(out)]
}

export function desktopSecretDirs(explicit) {
  const bases = desktopBaseDirs(explicit)
  const out = []
  for (const b of bases) {
    for (const suffix of ["", "userdata", path.join("userdata", "secrets"), "secrets", "dev", path.join("dev", "secrets")]) {
      out.push(suffix ? path.join(b, suffix) : b)
    }
  }
  return [...new Set(out)]
}
