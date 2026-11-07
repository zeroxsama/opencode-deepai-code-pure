// 控制台的纯展示逻辑，不碰 DOM / bridge，便于 node 单测。
// classic <script src> 加载：把能力挂到 globalThis.DeepAIView，供 app.js 使用。
//
// usage:summary 字段（对齐 magpie 官方 + 社区 usage 页 view.js）：
//   { calls, errors, input, output, cacheRead, cost, since,
//     models: [{ model, calls, cost, input, output }] }
// providers:list 可能是裸数组 / {providers:[]} / {data:[]} / 字符串数组。
(function () {
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    })
  }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0 }
  function count(n) {
    n = num(n)
    var a = Math.abs(n)
    if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 1 : 2) + "B"
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 1 : 2) + "M"
    if (a >= 1e5) return (n / 1e3).toFixed(0) + "K"
    return Math.round(n).toLocaleString("en-US")
  }
  function money(n) {
    n = num(n)
    if (n === 0) return "$0"
    if (n < 0.01) return "<$0.01"
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  function percent(part, whole) {
    if (!whole) return "0%"
    var p = (part / whole) * 100
    return (p < 1 && p > 0 ? p.toFixed(1) : Math.round(p)) + "%"
  }
  function since(s, lang) {
    if (!s || !s.since) return ""
    var d = new Date(s.since)
    if (isNaN(d)) return ""
    try { return "起始于 " + d.toLocaleDateString(lang || "zh", { year: "numeric", month: "short", day: "numeric" }) }
    catch (e) { return "起始于 " + d.toISOString().slice(0, 10) }
  }

  // 四张概览卡：[{ k, v, s, bad }]
  function tiles(s) {
    s = s || {}
    var calls = num(s.calls), errors = num(s.errors)
    var input = num(s.input != null ? s.input : s.tokensIn)
    var output = num(s.output != null ? s.output : s.tokensOut)
    var cache = num(s.cacheRead), cost = num(s.cost)
    var exact = s.cost != null ? String(s.cost) : "0"
    return [
      { k: "调用数", v: count(calls), s: "" },
      { k: "错误数", v: count(errors), s: calls ? percent(errors, calls) + " 的调用" : "", bad: errors > 0 },
      { k: "Token", v: count(input + output), s: "输入 " + count(input) + " · 输出 " + count(output) + (cache ? " · 缓存读 " + count(cache) : "") },
      { k: "费用", v: money(cost), s: (calls ? money(cost / calls) + " / 次 · " : "") + "原值 " + exact },
    ]
  }

  // 按模型排行：[{ name, value, detail, share }]
  function rows(s, sort) {
    if (["tokens", "calls", "cost"].indexOf(sort) < 0) sort = "tokens"
    var of = function (m) {
      return sort === "calls" ? num(m.calls) : sort === "cost" ? num(m.cost) : num(m.input) + num(m.output)
    }
    var list = (s && Array.isArray(s.models) ? s.models : []).slice()
      .sort(function (a, b) { return of(b) - of(a) || String(a.model).localeCompare(String(b.model)) })
    var top = list.length ? of(list[0]) : 0
    return list.map(function (m) {
      return {
        name: String(m.model || "?"),
        value: sort === "cost" ? money(m.cost) : count(of(m)),
        detail: sort === "calls" ? money(m.cost) : count(m.calls) + " 次调用",
        share: top > 0 ? of(m) / top : 0,
      }
    })
  }

  // 供应商归一化：[{ name, id }]
  function providers(p) {
    var list = Array.isArray(p) ? p : (p && (p.providers || p.data)) || []
    if (!Array.isArray(list)) list = []
    return list.map(function (x) {
      if (typeof x === "string") x = { id: x }
      x = x || {}
      return { name: String(x.name || x.id || "?"), id: String(x.id == null ? "" : x.id) }
    })
  }

  globalThis.DeepAIView = { esc: esc, num: num, count: count, money: money, percent: percent, since: since, tiles: tiles, rows: rows, providers: providers }
})()
