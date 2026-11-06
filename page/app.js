// 运行在 sandbox="allow-scripts" 的独立 origin 框架里：只能读 bridge 允许的
// usage:summary / providers:list，以及插件自己的 options。没有 fetch。
await magpie.ready

var $ = function (id) { return document.getElementById(id) }

try {
  var s = await magpie.read("usage:summary", { period: "today" })
  var rows = [
    ["调用数", s.calls],
    ["错误数", s.errors],
    ["输入 token", s.tokensIn],
    ["输出 token", s.tokensOut],
    ["费用", s.cost],
  ]
  $("usage").innerHTML = "<tbody>" + rows.map(function (r) {
    return "<tr><th>" + r[0] + "</th><td>" + (r[1] == null ? "—" : r[1]) + "</td></tr>"
  }).join("") + "</tbody>"

  var p = await magpie.read("providers:list", {})
  var list = (p && p.providers) || []
  $("providers").innerHTML = list.map(function (x) {
    return "<li>" + (x.name || x.id) + " <code>" + x.id + "</code></li>"
  }).join("") || "<li>（无）</li>"
} catch (e) {
  $("msg").textContent = "读取失败：" + (e && e.message ? e.message : e)
}

try {
  var o = await magpie.options.get()
  $("options").textContent = JSON.stringify(o || {}, null, 2)
} catch (e) {
  $("options").textContent = "（无选项）"
}
