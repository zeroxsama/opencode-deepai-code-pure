// 运行在 sandbox="allow-scripts" 的独立 origin 框架里：
//   - 可读：usage:summary / providers:list（package.json permissions 声明）
//   - 可写：magpie.options.set（写插件自身 options 到 plugins.json）
//   - 不能：fetch / 表单 / frames / 内联脚本；read 不给账号、密钥、登录态。
// 因此本页只做「展示 + 选项编辑 + 入口引导」；注册/加号/配额等要联网或写号池的
// 操作必须走宿主 auth.methods、CLI 或 MCP 工具（见页内说明）。
//
// classic <script src> 加载，不能用顶层 await（语法错误会让整段不执行 -> 10 秒
// 无应答 -> magpie 报「页面出错了」）。全部逻辑包在 async IIFE，逐源兜底。
;(function () {
  var V = globalThis.DeepAIView
  var $ = function (id) { return document.getElementById(id) }
  var text = function (id, s) { var el = $(id); if (el) el.textContent = s }
  var esc = V ? V.esc : function (s) { return String(s == null ? "" : s) }

  var PERIODS = ["today", "7d", "30d"]
  var SORTS = ["tokens", "calls", "cost"]
  var state = { period: "today", sort: "tokens", summary: null, options: {} }
  var lang = "zh"

  // ---------- 用量总览（usage:summary 全字段） ----------
  function paint() {
    var s = state.summary
    // 周期 / 排序按钮选中态
    ;[["periods", "period", state.period], ["sorts", "sort", state.sort]].forEach(function (g) {
      var box = $(g[0]); if (!box) return
      box.querySelectorAll("button").forEach(function (b) {
        b.setAttribute("aria-selected", String(b.dataset[g[1]] === g[2]))
      })
    })
    if (!s) return
    text("since", V.since(s, lang))
    var tb = $("usage")
    if (tb) {
      tb.innerHTML = V.tiles(s).map(function (t) {
        return '<tr class="' + (t.bad ? "bad" : "") + '"><th>' + esc(t.k) + '</th><td>' +
          esc(t.v) + (t.s ? ' <span class="subv">' + esc(t.s) + '</span>' : "") + "</td></tr>"
      }).join("")
    }
    var list = V.rows(s, state.sort)
    var ul = $("models")
    if (ul) {
      var empty = $("models-empty")
      if (empty) empty.hidden = list.length > 0
      ul.innerHTML = list.map(function (r) {
        var w = Math.max(2, Math.round(r.share * 100))
        return '<li><span class="name" title="' + esc(r.name) + '">' + esc(r.name) + '</span>' +
          '<span class="num">' + esc(r.value) + ' · ' + esc(r.detail) + '</span>' +
          '<span class="bar"><i style="width:' + w + '%"></i></span></li>'
      }).join("")
    }
  }

  async function loadUsage() {
    try {
      state.summary = await magpie.read("usage:summary", { period: state.period })
      var e = $("usage-error"); if (e) e.hidden = true
    } catch (err) {
      var e2 = $("usage-error")
      if (e2) { e2.hidden = false; e2.textContent = "读取用量失败：" + (err && err.message ? err.message : err) }
    }
    paint()
  }

  // ---------- 供应商（providers:list，多形态兼容） ----------
  function renderProviders(p) {
    var list = V.providers(p)
    var ul = $("providers")
    if (!ul) return
    if (!list.length) { ul.innerHTML = "<li>（无）</li>"; return }
    ul.innerHTML = list.map(function (x) {
      return "<li>" + esc(x.name) + " <code>" + esc(x.id) + "</code></li>"
    }).join("")
  }

  // ---------- 插件选项（可读 + 可写：options.set） ----------
  var OPTION_HELP = {
    origin: "上游地址（默认 https://api.deepai.org）",
    domain: "注册邮箱域名",
    mailBackend: "邮箱后端：static / cf / none",
    tempMailBase: "CF 临时邮箱 Worker 地址",
    tempMailAdminKey: "临时邮箱管理 Key",
    verify: "注册是否验邮箱（true/false）",
    group: "账号分组",
    importDesktop: "启动时导入桌面端凭据（true/false）",
    desktopPath: "桌面端凭据路径（可选）",
    machineID: "显式机器 UUID（容器无 SMBIOS 时）",
    masterKey: "状态文件 AES-256-GCM 主密钥（64 hex/base64 32 字节）",
  }
  function renderOptions(o) {
    state.options = o && typeof o === "object" ? o : {}
    var form = $("option-form")
    if (!form) return
    var keys = Object.keys(OPTION_HELP)
    form.innerHTML = keys.map(function (k) {
      var val = state.options[k] == null ? "" : String(state.options[k])
      var typ = /Key|masterKey|adminKey/i.test(k) ? "password" : "text"
      return '<label class="opt"><span>' + esc(k) + '<small>' + esc(OPTION_HELP[k]) + "</small></span>" +
        '<input type="' + typ + '" data-opt="' + esc(k) + '" value="' + esc(val) + '" autocomplete="off"></label>'
    }).join("")
    var plain = $("options-json")
    if (plain) plain.textContent = JSON.stringify(state.options, null, 2)
  }
  function bindOptions() {
    var btn = $("opt-save")
    if (!btn) return
    btn.addEventListener("click", async function () {
      var next = {}
      $("option-form").querySelectorAll("input[data-opt]").forEach(function (i) {
        var k = i.dataset.opt, v = i.value
        if (v === "") return // 留空 = 不覆盖，沿用默认
        if (v === "true" || v === "false") next[k] = v === "true"
        else next[k] = v
      })
      // 保留本页 UI 偏好与未列出的键
      var merged = Object.assign({}, state.options, next)
      try {
        var saved = await magpie.options.set(merged)
        state.options = saved || merged
        renderOptions(state.options)
        text("opt-msg", "已保存；重启插件（关→开）后生效。")
      } catch (e) { text("opt-msg", "保存失败：" + (e && e.message ? e.message : e)) }
    })
  }

  // ---------- UI 偏好持久化（写进自身 options，每秒最多一次） ----------
  var saving = null
  function savePrefs() {
    if (saving) return
    saving = setTimeout(async function () {
      saving = null
      try {
        var cur = (await magpie.options.get()) || {}
        state.options = await magpie.options.set(Object.assign({}, cur, {
          _uiPeriod: state.period, _uiSort: state.sort,
        }))
      } catch (e) {}
    }, 1100)
  }

  // ---------- 登录 / 注册命令一键复制 ----------
  function bindCopy(btnId, codeId) {
    try {
      var btn = $(btnId), el = $(codeId)
      if (!btn || !el) return
      btn.addEventListener("click", function () {
        var t = el.textContent || ""
        var ok = function () { btn.textContent = "已复制"; setTimeout(function () { btn.textContent = "复制" }, 1500) }
        if (navigator.clipboard && navigator.clipboard.writeText)
          navigator.clipboard.writeText(t).then(ok, function () { btn.textContent = "请手动复制" })
        else btn.textContent = "请手动复制"
      })
    } catch (e) {}
  }

  async function main() {
    try { var th = await magpie.ready; lang = (th && th.lang) || "zh" } catch (e) {}

    // 恢复 UI 偏好
    try {
      var o0 = (await magpie.options.get()) || {}
      if (PERIODS.indexOf(o0._uiPeriod) >= 0) state.period = o0._uiPeriod
      if (SORTS.indexOf(o0._uiSort) >= 0) state.sort = o0._uiSort
    } catch (e) {}

    // 周期 / 排序交互
    ;[["periods", "period", PERIODS, function (v) { state.period = v; loadUsage() }],
      ["sorts", "sort", SORTS, function (v) { state.sort = v; paint() }]].forEach(function (g) {
      var box = $(g[0]); if (!box) return
      box.addEventListener("click", function (e) {
        var b = e.target.closest("button"); if (!b) return
        var v = b.dataset[g[1]]
        if (!v || g[2].indexOf(v) < 0 || v === state[g[1]]) return
        state[g[1]] = v; g[3](v); savePrefs(); paint()
      })
    })

    bindOptions()
    bindCopy("copy-login", "login-cmd")
    bindCopy("copy-register", "register-cmd")

    // 三个数据源各自兜底，一个失败不拖垮整页
    await loadUsage()
    try { renderProviders(await magpie.read("providers:list", {})) }
    catch (e) { var ul = $("providers"); if (ul) ul.innerHTML = "<li>读取供应商失败</li>" }
    try { renderOptions(await magpie.options.get()) }
    catch (e) { text("options-json", "（无选项）") }

    try { magpie.onTheme(function (t) { lang = (t && t.lang) || lang; paint() }) } catch (e) {}
    // 页面开着时每分钟刷新用量
    try { setInterval(loadUsage, 60000) } catch (e) {}
  }

  Promise.resolve().then(main).catch(function (e) {
    var m = $("msg"); if (m) m.textContent = (e && e.message) ? e.message : String(e)
    paint()
  })
})()
