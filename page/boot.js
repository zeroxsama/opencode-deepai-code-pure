// 带路页脚本：magpie 的沙盒页 CSP connect-src 'none' 发不出任何请求，唯一能做的
// 联网动作是把自身导航到本地服务（官方 pages 文档 §host part）。
//
// 服务由插件宿主在 index.mjs 里起（127.0.0.1:adminPort），与宿主同进程、直接读写
// 号池。端口取自插件选项 adminPort，与 magpie.page.service.option 一致。
//
// magpie web（远程浏览器）时 127.0.0.1 是看页面那台机器，bridge 会给出
// magpie.service：magpie web 在自己地址上替本服务转发的路径。有就跳那里。
;(async function () {
  var DEFAULT_PORT = 3493
  var port = DEFAULT_PORT
  var service = ""
  var $said = document.getElementById("said")

  function say(t) { if ($said) $said.textContent = t }

  try {
    var t = await window.magpie?.ready
    void t
  } catch (e) {}

  // 远程转发路径（magpie web 提供给本服务的代理基址）
  try {
    var s = window.magpie?.service
    if (typeof s === "string" && /^https?:\/\//.test(s)) service = s.replace(/\/+$/, "")
  } catch (e) {}

  // 端口与服务端读的是同一个选项
  try {
    var o = await window.magpie?.options?.get?.()
    if (o && Number.isFinite(Number(o.adminPort)) && Number(o.adminPort) > 0) port = Number(o.adminPort)
  } catch (e) {}

  var target = service ? service + "/" : "http://127.0.0.1:" + port + "/"

  // 兜底：5 秒后这份文档还活着 = 跳转没走成（服务没起来）。
  function armFail() {
    setTimeout(function () {
      if (!$said || !document.getElementById("said")) return
      if (document.getElementById("boot-retry")) return
      $said.innerHTML = ""
      var p1 = document.createElement("p")
      p1.textContent = "账号管理服务没有在运行（" + (service || "127.0.0.1:" + port) + "）。"
      $said.appendChild(p1)
      var p2 = document.createElement("p")
      p2.textContent = "请确认插件已启用；或在终端执行下面命令查看插件状态："
      $said.appendChild(p2)
      var code = document.createElement("code")
      code.textContent = "magpie plugin"
      $said.appendChild(document.createElement("br"))
      $said.appendChild(code)
      var btn = document.createElement("button")
      btn.id = "boot-retry"
      btn.type = "button"
      btn.textContent = "重试"
      btn.addEventListener("click", function () { location.reload() })
      $said.appendChild(btn)
    }, 5000)
  }

  // 远程浏览器且没有 service 转发时，给出说明（桌面窗口一般不会有这问题）
  function isLoopback(h) {
    h = String(h || "").toLowerCase().replace(/^\[|\]$/g, "")
    return h === "" || h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\./.test(h)
  }
  if (!service && !isLoopback(location.hostname)) {
    say("服务只在运行 magpie 的机器上监听 127.0.0.1:" + port + "。")
    var host = location.hostname.replace(/^\[|\]$/g, "")
    var p = document.createElement("p")
    p.appendChild(document.createTextNode("在这台电脑上做端口转发后刷新： "))
    var c = document.createElement("code")
    c.textContent = "ssh -N -L " + port + ":127.0.0.1:" + port + " <user>@" + host
    p.appendChild(c)
    if ($said) $said.appendChild(p)
    return
  }

  armFail()
  location.replace(target)
})()
