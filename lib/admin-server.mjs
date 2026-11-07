// 账号管理本地服务（magpie page host part）。
//
// magpie 的沙盒页 CSP connect-src 'none'，发不出任何请求；官方允许的唯一联网动作是
// 把自身导航到本地服务。服务与插件宿主同进程，直接读写 Runtime 单例的 state.pool /
// state.settings / state.stats / catalog，因此能做「完整账号管理」：
//   列表（脱敏）/ 加 Key / 删号 / 启停 / 改分组与备注 / 导入桌面凭据 /
//   注册新账号入池 / 查 Theos 配额 / 用量摘要 / 累计统计 / 设置 / 模型目录。
//
// 每个路由用随机 token 守卫（boot.js 在跳转时把 token 带上），并校验 Host 只能是
// 127.0.0.1 / localhost / [::1]（对齐官方 host part 的安全要求）。
//
// 服务层不 import magpie 任何东西，createAdminServer 返回 { handler, token, port }，
// 便于 node 单测直接喂 mock runtime。
import http from "node:http"
import { randomBytes } from "node:crypto"

const LOOPBACK = /^(localhost|127\.[0-9.]+|\[::1\])(:\d+)?$/i

function send(res, status, body, type = "application/json; charset=utf-8") {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  })
  res.end(payload)
}
function json(res, status, obj) { send(res, status, obj) }
async function readBody(req) {
  const chunks = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > 256 * 1024) throw new Error("请求体过大")
    chunks.push(c)
  }
  const s = Buffer.concat(chunks).toString("utf8")
  if (!s) return {}
  try { return JSON.parse(s) } catch { throw new Error("请求体不是合法 JSON") }
}

// 账号脱敏：绝不把 apiKey / password 发到页面（页面是公开可读的沙盒）。
export function publicAccount(a) {
  return {
    id: a.id, name: a.name, username: a.username || "", source: a.source,
    group: a.group || "default", enabled: a.enabled !== false,
    status: a.status || "unknown", failures: a.failures || 0,
    isPro: !!a.isPro, email: a.email || "", plan: a.plan || "",
    keyHint: a.apiKey ? a.apiKey.slice(0, 4) + "…" + a.apiKey.slice(-4) : "",
    theos: a.theos ? { enabled: a.theos.enabled, balance: a.theos.balance, checkedAt: a.theos.checkedAt } : null,
    lastUsed: a.lastUsed || 0, lastErr: a.lastErr || "", note: a.note || "",
    registeredAt: a.registeredAt || 0,
  }
}

// 纯逻辑：把请求路由到 runtime 操作，返回 { status, body }。单测可直接调用。
export async function dispatch(method, path, query, body, ctx) {
  const rt = await ctx.getRuntime()
  const { state, upstream, catalog } = rt
  const pool = state.pool
  const save = () => state.save().catch(() => {})
  const find = (id) => pool.list().find((a) => a.id === String(id || ""))

  try {
    if (path === "/api/state" && method === "GET") {
      return { status: 200, body: {
        accounts: pool.list().map(publicAccount),
        count: pool.size(),
        settings: { ...state.settings },
        stats: { ...state.stats },
        machineID: state.machineID,
        defaultModel: catalog.defaultID,
        modelsUpdated: state.modelsUpdated,
        models: state.models.map((m) => ({ id: m.id, name: m.name, free: m.free })),
      } }
    }

    if (path === "/api/accounts" && method === "POST") {
      const { accountFromAPIKey } = await import("./account.mjs")
      const a = accountFromAPIKey(String(body.key || "").trim(), {
        username: String(body.username || "").trim(),
        group: String(body.group || "default"),
        source: "manual",
      })
      const added = pool.upsert(a)
      await save()
      return { status: 200, body: { ok: true, added, account: publicAccount(a) } }
    }

    if (path.startsWith("/api/accounts/") && method === "PATCH") {
      const a = find(path.split("/")[3])
      if (!a) return { status: 404, body: { error: "账号不存在" } }
      if (body.enabled != null) a.enabled = !!body.enabled
      if (body.group != null) a.group = String(body.group)
      if (body.note != null) a.note = String(body.note).slice(0, 200)
      if (body.username != null) a.username = String(body.username)
      await save()
      return { status: 200, body: { ok: true, account: publicAccount(a) } }
    }

    if (path.startsWith("/api/accounts/") && method === "DELETE") {
      const id = path.split("/")[3]
      const ok = pool.remove(id)
      await save()
      return { status: 200, body: { ok, removed: ok } }
    }

    if (path === "/api/import-desktop" && method === "POST") {
      const n = await rt.importDesktop(String(body.path || ""))
      await save()
      return { status: 200, body: { ok: true, imported: n } }
    }

    if (path === "/api/register" && method === "POST") {
      const { runOne } = await import("./register.mjs")
      const rec = await runOne({
        pool, upstream,
        domain: rt.opts.domain || "", backend: body.backend || rt.opts.mailBackend || "static",
        email: body.email || "", password: body.password || "",
        base: rt.opts.tempMailBase || "", adminKey: rt.opts.tempMailAdminKey || "",
        verify: rt.opts.verify !== false, group: body.group || rt.opts.group || "default",
      })
      await save()
      return { status: 200, body: { ok: true, rec } }
    }

    if (path.startsWith("/api/quota/") && method === "GET") {
      const a = find(path.split("/")[3])
      if (!a) return { status: 404, body: { error: "账号不存在" } }
      const al = await upstream.theos(a)
      pool.setAllowance(a.id, al, null)
      await save()
      return { status: 200, body: { ok: true, account: publicAccount(a), allowance: al } }
    }

    if (path.startsWith("/api/usage-summary/") && method === "GET") {
      const a = find(path.split("/")[3])
      if (!a) return { status: 404, body: { error: "账号不存在" } }
      const u = await upstream.usageSummary(a)
      return { status: 200, body: { ok: true, usage: u } }
    }

    if (path === "/api/checkin" && method === "POST") {
      let ok = 0
      for (const a of pool.list()) {
        try { const al = await upstream.theos(a); pool.setAllowance(a.id, al, null); ok++ }
        catch (e) { pool.markResult(a.id, false, e.message) }
      }
      await save()
      return { status: 200, body: { ok: true, probed: ok, total: pool.size() } }
    }

    if (path === "/api/settings" && method === "POST") {
      const allowed = ["fallback_model", "max_retries", "model_aliases", "request_timeout_sec", "log_keep"]
      for (const k of allowed) if (body[k] != null) state.settings[k] = body[k]
      await save()
      catalog.fallback = state.settings.fallback_model || ""
      catalog.aliases = { ...catalog.aliases, ...(state.settings.model_aliases || {}) }
      return { status: 200, body: { ok: true, settings: { ...state.settings } } }
    }

    if (path === "/api/refresh-models" && method === "POST") {
      await rt.refreshModels()
      return { status: 200, body: { ok: true, count: state.models.length, defaultModel: state.defaultModel } }
    }

    if (path === "/api/stats" && method === "GET") {
      return { status: 200, body: { stats: { ...state.stats }, recent_logs: state.logs.slice(-20) } }
    }

    return { status: 404, body: { error: "未知接口" } }
  } catch (e) {
    return { status: 502, body: { error: String(e && e.message ? e.message : e) } }
  }
}

export function createHandler(ctx) {
  return async function handler(req, res) {
    // 守卫：Host 必须本机（或 ctx.hosts 白名单，兼容 magpie web 转发）+ token。
    // 根页 HTML 本身不含 secrets，且负责把 token 注入页面；只有 /api/ 校验 token。
    const u = new URL(req.url, "http://127.0.0.1")
    const host = String(req.headers.host || "").toLowerCase()
    const hostOK = LOOPBACK.test(host) ||
      (Array.isArray(ctx.hosts) && ctx.hosts.some((x) => host === String(x).toLowerCase()))
    if (!hostOK) return send(res, 403, "Forbidden", "text/plain; charset=utf-8")
    // 反代可能带 /xxx/service/ 前缀：取 pathname 里 /api/ 起始的那一段做路由。
    let pathname = u.pathname
    const apiAt = pathname.indexOf("/api/")
    if (apiAt > 0) pathname = pathname.slice(apiAt)
    if (pathname === "/" || pathname === "/index.html" || /\/index\.html$/.test(pathname)) {
      // 根页 HTML 不含 secrets，且负责把 token 注入页面；只有 /api/ 校验 token。
      return send(res, 200, INDEX_HTML(ctx.token), "text/html; charset=utf-8")
    }
    if (!pathname.startsWith("/api/")) return send(res, 404, "Not found", "text/plain; charset=utf-8")
    const tok = u.searchParams.get("token") || req.headers["x-admin-token"] || ""
    if (tok !== ctx.token) return send(res, 403, "Forbidden", "text/plain; charset=utf-8")
    let body = {}
    try { body = await readBody(req) } catch (e) { return json(res, 400, { error: e.message }) }
    const out = await dispatch(req.method, pathname, u.searchParams, body, ctx)
    return json(res, out.status, out.body)
  }
}

export async function startAdminServer(ctx = {}) {
  const token = ctx.token || randomBytes(24).toString("hex")
  const full = { ...ctx, token }
  // 白名单：本机监听地址 + 调用方追加的 host（magpie web 转发）。
  const hosts = Array.isArray(full.hosts) ? full.hosts.slice() : []
  const bindHost = full.host || "127.0.0.1"
  hosts.push(bindHost.toLowerCase())
  hosts.push("localhost")
  full.hosts = hosts
  const server = http.createServer(createHandler(full))
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(full.port || 0, bindHost, resolve)
  })
  try { server.unref() } catch {} // 服务不阻止宿主/测试进程退出
  const port = server.address().port
  return { server, port, token, close: () => new Promise((r) => server.close(r)) }
}

// ---------- 内嵌管理 UI（服务提供，不受沙盒 CSP 限制） ----------
function INDEX_HTML(token) {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepAI Code · 账号管理</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;padding:18px;background:#f6f7f9;color:#222;max-width:1080px;margin:0 auto}
h1{font-size:1.2rem;margin:0 0 4px}h2{font-size:.95rem;margin:18px 0 8px;opacity:.85}
.sub,.hint{font-size:.8rem;opacity:.7;margin:2px 0 10px}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:12px 14px;margin-bottom:14px;box-shadow:0 1px 2px rgba(0,0,0,.03)}
@media(prefers-color-scheme:dark){body{background:#1b1d21;color:#ddd}.card{background:#24272c;border-color:#363a40}}
table{border-collapse:collapse;width:100%;font-size:.8rem}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid rgba(128,128,128,.18);vertical-align:middle}
th{font-weight:500;opacity:.7}tr:hover td{background:rgba(128,128,128,.05)}
button,input,select{font:inherit;font-size:.8rem;padding:5px 9px;border:1px solid rgba(128,128,128,.4);border-radius:6px;background:transparent;color:inherit}
button{cursor:pointer}button:hover{background:rgba(128,128,128,.12)}button.primary{background:#3b6ef5;color:#fff;border-color:transparent}
button.danger{color:#c0392b}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0}
.row label{font-size:.78rem;opacity:.8;min-width:70px}.row input,.row select{flex:1;min-width:120px}
.tag{display:inline-block;font-size:.7rem;padding:1px 7px;border-radius:10px;background:rgba(128,128,128,.16)}
.tag.ok{background:#2e9e5b33;color:#2e9e5b}.tag.err{background:#c0392b22;color:#c0392b}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.74rem}
#msg{font-size:.8rem;margin:8px 0;min-height:1em}.bad{color:#c0392b}.good{color:#2e9e5b}
pre{font-size:.74rem;white-space:pre-wrap;background:rgba(128,128,128,.08);padding:8px;border-radius:6px;max-height:220px;overflow:auto}
.small{font-size:.72rem;opacity:.65}
</style></head><body>
<h1>DeepAI Code · 账号管理</h1>
<p class="sub">完整号池管理：加 Key / 删号 / 启停 / 分组 / 导入桌面凭据 / 注册入池 / 查配额 / 设置。服务运行在插件宿主进程内，直接读写号池。</p>
<div id="msg"></div>

<div class="card"><h2>号池账号 <span id="count" class="tag">…</span></h2>
<table id="accounts"><tbody><tr><td>加载中…</td></tr></tbody></table></div>

<div class="card"><h2>添加账号（API Key）</h2>
<div class="row"><label>Key</label><input id="key" placeholder="UUID 格式 apiKey" autocomplete="off"></div>
<div class="row"><label>备注名</label><input id="username" placeholder="可选"><label>分组</label><input id="group" value="default"></div>
<div class="row"><button class="primary" id="add">添加 / 更新</button></div></div>

<div class="card"><h2>导入 / 注册 / 批量</h2>
<div class="row"><button id="import">导入桌面端凭据</button><input id="import-path" placeholder="凭据目录（可选）"></div>
<div class="row"><button id="checkin">全账号配额复探</button><button id="refresh">刷新模型目录</button></div>
<div class="row"><label>注册邮箱</label><input id="reg-email" placeholder="留空自动生成"><label>密码</label><input id="reg-pass" placeholder="留空自动生成"></div>
<div class="row"><label>邮箱后端</label><select id="reg-backend"><option value="static">static</option><option value="cf">cf</option><option value="none">none</option></select>
<label>分组</label><input id="reg-group" value="default"><button class="primary" id="register">注册新账号入池</button></div>
<p class="hint">注册需先在「插件选项」里配好 <span class="mono">domain / mailBackend / tempMailBase</span>，或走 <span class="mono">magpie plugin options deepai</span>。</p></div>

<div class="card"><h2>设置</h2>
<div class="row"><label>兜底模型</label><input id="set-fallback" placeholder="留空不覆盖"><label>最大重试</label><input id="set-retries" type="number" min="1" max="10"></div>
<div class="row"><button class="primary" id="save-settings">保存设置</button></div></div>

<div class="card"><h2>累计统计 / 最近日志</h2><button id="stats">刷新统计</button><pre id="stats-box">—</pre></div>

<script>
var TOKEN=${JSON.stringify(token)};
function $(id){return document.getElementById(id)}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function msg(t,bad){var m=$("msg");m.textContent=t;m.className=bad?"bad":"good";if(!bad)setTimeout(function(){if(m.textContent===t)m.textContent=""},4000)}
async function api(path,method,body){method=method||"GET";var o={method:method,headers:{"X-Admin-Token":TOKEN}};if(body){o.headers["Content-Type"]="application/json";o.body=JSON.stringify(body)}var url=new URL(String(path).replace(/^\//,""),document.baseURI).href;var r=await fetch(url,o);var j=await r.json().catch(function(){return {}});if(!r.ok||j.error)throw new Error(j.error||("HTTP "+r.status));return j}
function rowHtml(a){var s=a.status==="ok"?"ok":a.status==="error"?"err":"";var th=a.theos?("Theos "+(a.theos.balance!=null?a.theos.balance:"?")+(a.theos.enabled?"":" (禁用)")):"—";return "<tr data-id=\\""+esc(a.id)+"\\">"+
 "<td><b>"+esc(a.name)+"</b><br><span class=small>"+esc(a.username||a.email||"")+" · "+esc(a.keyHint)+"</span></td>"+
 "<td>"+esc(a.source)+" <span class=tag>"+esc(a.group)+"</span><br><span class=small>"+(a.isPro?"Pro":"Free")+" "+(a.plan?esc(a.plan):"")+"</span></td>"+
 "<td><span class='tag "+s+"'>"+esc(a.status)+"</span><br><span class=small>失败 "+a.failures+" · "+esc(th)+"</span></td>"+
 "<td><span class=small>"+esc(a.lastErr||a.note||"")+"</span></td>"+
 "<td><button data-act=toggle>"+(a.enabled?"停用":"启用")+"</button> <button data-act=quota>查配额</button> <button data-act=usage>用量</button> <button data-act=group>改分组</button> <button class=danger data-act=del>删除</button></td></tr>"}
async function load(){try{var j=await api("/api/state");$("count").textContent=j.count+" 个";$("accounts").querySelector("tbody").innerHTML=j.accounts.length?j.accounts.map(rowHtml).join(""):"<tr><td>号池为空</td></tr>";$("set-fallback").value=j.settings.fallback_model||"";$("set-retries").value=j.settings.max_retries||3}catch(e){msg("加载失败: "+e.message,1)}}
$("accounts").addEventListener("click",async function(e){var b=e.target.closest("button");if(!b)return;var tr=b.closest("tr"),id=tr&&tr.dataset.id,act=b.dataset.act;if(!id)return;try{
 if(act==="toggle"){var on=b.textContent==="停用";await api("/api/accounts/"+id,"PATCH",{enabled:!on});msg("已"+(on?"停用":"启用"))}
 else if(act==="del"){if(!confirm("确认删除该账号？"))return;await api("/api/accounts/"+id,"DELETE");msg("已删除")}
 else if(act==="quota"){var q=await api("/api/quota/"+id);msg("配额: "+JSON.stringify(q.allowance))}
 else if(act==="usage"){var u=await api("/api/usage-summary/"+id);msg("用量: "+JSON.stringify(u.usage))}
 else if(act==="group"){var g=prompt("新分组名","default");if(g==null)return;await api("/api/accounts/"+id,"PATCH",{group:g});msg("分组已改")}
 load()}catch(err){msg("操作失败: "+err.message,1)}});
$("add").addEventListener("click",async function(){try{await api("/api/accounts","POST",{key:$("key").value,username:$("username").value,group:$("group").value});$("key").value="";msg("账号已加入号池");load()}catch(e){msg(e.message,1)}});
$("import").addEventListener("click",async function(){try{var j=await api("/api/import-desktop","POST",{path:$("import-path").value});msg("导入 "+j.imported+" 个账号");load()}catch(e){msg(e.message,1)}});
$("checkin").addEventListener("click",async function(){try{var j=await api("/api/checkin","POST",{});msg("复探 "+j.probed+"/"+j.total);load()}catch(e){msg(e.message,1)}});
$("refresh").addEventListener("click",async function(){try{var j=await api("/api/refresh-models","POST",{});msg("模型 "+j.count+" 个，默认 "+j.defaultModel);load()}catch(e){msg(e.message,1)}});
$("register").addEventListener("click",async function(){try{msg("注册中…（可能耗时数十秒）");var j=await api("/api/register","POST",{email:$("reg-email").value,password:$("reg-pass").value,backend:$("reg-backend").value,group:$("reg-group").value});msg("注册完成: "+(j.rec.email||j.rec.accountID));load()}catch(e){msg("注册失败: "+e.message,1)}});
$("save-settings").addEventListener("click",async function(){try{var b={fallback_model:$("set-fallback").value};if($("set-retries").value)b.max_retries=Number($("set-retries").value);await api("/api/settings","POST",b);msg("设置已保存");load()}catch(e){msg(e.message,1)}});
$("stats").addEventListener("click",async function(){try{$("stats-box").textContent=JSON.stringify(await api("/api/stats"),null,2)}catch(e){msg(e.message,1)}});
load();setInterval(load,30000);
</script></body></html>`
}
