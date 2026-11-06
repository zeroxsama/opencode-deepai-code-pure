// 浏览器登录（对齐 server/login.go 的 handleLoginStart / handleLoginPoll）：
// 打开桌面端登录页 -> 本机回环 HTTP 服务接 /auth-callback?code=… ->
// ExchangeCode 换 API Key -> 作为第二个登录账号加入号池。
//
// magpie 的 oauth method.authorize 自己打开 url 并调用 callback；callback
// 里起一个短命的回环服务器等待上游跳转。Bun 与 Node 都可用 node:http。

import http from "node:http"
import { randomHex } from "./account.mjs"

// 起一个只接一次 /auth-callback 的回环服务器，返回 { port, wait, close }。
export function startCallbackServer({ host = "127.0.0.1", timeoutMs = 120000 } = {}) {
  let resolveCode, rejectCode
  const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej })
  let timer

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${host}`)
    if (u.pathname === "/auth-callback") {
      const code = u.searchParams.get("code") || ""
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end("<!doctype html><meta charset=utf-8><p>登录完成，可以关闭此窗口并回到 magpie。</p>")
      if (code) resolveCode(code)
      else rejectCode(new Error("回调缺少 code 参数"))
    } else {
      res.writeHead(404); res.end("not found")
    }
  })

  const ready = new Promise((res, rej) => {
    server.once("error", rej)
    server.listen(0, host, () => res(server.address().port))
  })

  const wait = Promise.race([
    codePromise,
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error("等待浏览器登录超时")), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))

  return {
    ready,
    wait,
    close: () => new Promise((r) => server.close(() => r())),
  }
}

export function newState() { return randomHex(16) }
