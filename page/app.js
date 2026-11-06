// 运行在 sandbox="allow-scripts" 的独立 origin 框架里：只能读 bridge 允许的
// usage:summary / providers:list，以及插件自己的 options。没有 fetch。
//
// 注意：本文件用 classic <script src> 加载，不能用顶层 await（经典脚本里是
// 语法错误，会导致整段脚本不执行、10 秒无应答 -> magpie 报「页面出错了」）。
// 全部逻辑包在 async IIFE 里，并对每个数据源单独兜底，保证页面一定应答。

;(function () {
  var $ = function (id) { return document.getElementById(id) }
  var set = function (id, html) { var el = $(id); if (el) el.innerHTML = html }
  var text = function (id, s) { var el = $(id); if (el) el.textContent = s }

  function cell(v) { return v == null ? "—" : String(v) }

  function renderUsage(s) {
    if (!s || typeof s !== "object") { set("usage", "<tbody><tr><td>无数据</td></tr></tbody>"); return }
    var rows = [
      ["调用数", s.calls],
      ["错误数", s.errors],
      ["输入 token", s.tokensIn != null ? s.tokensIn : s.inputTokens],
      ["输出 token", s.tokensOut != null ? s.tokensOut : s.outputTokens],
      ["费用", s.cost],
    ]
    var html = "<tbody>"
    for (var i = 0; i < rows.length; i++) {
      html += "<tr><th>" + rows[i][0] + "</th><td>" + cell(rows[i][1]) + "</td></tr>"
    }
    html += "</tbody>"
    set("usage", html)
  }

  function renderProviders(p) {
    var list = (p && p.providers) || []
    if (!list.length) { set("providers", "<li>（无）</li>"); return }
    var html = ""
    for (var i = 0; i < list.length; i++) {
      var x = list[i] || {}
      var name = x.name || x.id || "?"
      html += "<li>" + name + " <code>" + cell(x.id) + "</code></li>"
    }
    set("providers", html)
  }

  function renderOptions(o) {
    try { text("options", JSON.stringify(o || {}, null, 2)) }
    catch (e) { text("options", "（选项不可序列化）") }
  }

  async function main() {
    // 先完成握手，让页面在 10 秒窗口内应答；读取失败也不影响就绪。
    try { await magpie.ready } catch (e) { /* 仍继续渲染 */ }

    // 每个数据源独立 try/catch：一个失败不拖垮整页。
    try {
      var s = await magpie.read("usage:summary", { period: "today" })
      renderUsage(s)
    } catch (e) {
      set("usage", "<tbody><tr><td>读取用量失败</td></tr></tbody>")
      text("msg", "usage: " + (e && e.message ? e.message : e))
    }

    try {
      var p = await magpie.read("providers:list", {})
      renderProviders(p)
    } catch (e) {
      set("providers", "<li>读取供应商失败</li>")
    }

    try {
      var o = await magpie.options.get()
      renderOptions(o)
    } catch (e) {
      text("options", "（无选项）")
    }
  }

  // 兜底：即便 main 抛出未捕获异常，也把「加载中」替换掉，避免静止页面。
  Promise.resolve()
    .then(main)
    .catch(function (e) {
      set("usage", "<tbody><tr><td>加载失败</td></tr></tbody>")
      set("providers", "<li>加载失败</li>")
      text("msg", (e && e.message) ? e.message : String(e))
    })
})()
