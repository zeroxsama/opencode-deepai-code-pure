// 网关路由策略 + 用量记录（magpie 文档 §"路由与用量记录"）。
// 运行在 moejs 沙盒里：只能用标准 JS，不能 import，没有定时器 / fetch。
// 文件命名 *.gateway.js 自动被 magpie 识别。

// 自定义路由策略：优先选 Theos 余额充足、故障少、最近用得少的账号。
// seats 由 magpie 提供；这里按 known/used/resting/tokens 做一个加权排序，
// 尽量对齐 Go 网关「两轮配额筛选 + 轮询 + 失败最少」的调度偏好。
export const strategies = {
  "fewest-failures": function (pool, seats, options) {
    var order = []
    for (var i = 0; i < seats.length; i++) order.push(i)
    order.sort(function (a, b) {
      var A = seats[a], B = seats[b]
      // 正在休息的排后；无额度的排后；token 少的优先；故障少的优先。
      var ra = A.resting ? 1 : 0, rb = B.resting ? 1 : 0
      if (ra !== rb) return ra - rb
      var ua = A.known === false ? 1 : 0, ub = B.known === false ? 1 : 0
      if (ua !== ub) return ua - ub
      var ta = A.tokens || 0, tb = B.tokens || 0
      if (ta !== tb) return ta - tb
      return (A.used || 0) - (B.used || 0)
    })
    return order
  },
}

// 用量记录：统计慢请求（对齐网关日志 / 统计能力）。
var slow = 0
export function onUsage(row, options) {
  var threshold = (options && options.slowMs) || 30000
  if (row && row.ms > threshold) {
    slow++
    console.log("deepai slow:", row.provider, row.model, row.ms + "ms", "(" + slow + " so far)")
  }
}
