// 对齐 internal/deepai/types.go 与 register/web.go 的上游协议常量。
// 纯插件直连上游，不经过 Go 网关的 10087。

export const ORIGIN = "https://api.deepai.org"
export const SITE_ORIGIN = "https://deepai.org"
export const MODEL_BASE = "/deepai_code"

export const P = {
  models: MODEL_BASE + "/models",
  chat: MODEL_BASE + "/chat/completions",
  responses: MODEL_BASE + "/responses",
  theos: MODEL_BASE + "/theos",
  webSearch: MODEL_BASE + "/web_search",
  findService: MODEL_BASE + "/find_service",
  sessionsList: MODEL_BASE + "/sessions/list",
  signIn: MODEL_BASE + "/desktop_auth/",
  exchange: MODEL_BASE + "/desktop_auth/exchange/",
  usage: "/get_usage_summary",
  speech: "/speech_to_text",
}

// 网页注册链路（register.WebClient）
export const WEB = {
  loginType: "/get_user_login_type",
  signupData: "/save_custom_signup_data",
  register: "/daily-time-sync/registration/",
  login: "/daily-time-sync/login/",
  user: "/daily-time-sync/user/",
  logout: "/daily-time-sync/logout/",
  verifyPrefix: "https://api.deepai.org/verify_email",
}

export const H = {
  key: "Api-Key",
  lane: "X-DeepAI-Code-Theos",
  machine: "X-DeepAI-Code-Machine",
  affinity: "X-Session-Affinity",
}

export const LANE_VERSION = "2"
export const DEFAULT_MODEL = "glm-5.3-flash"

export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"

// 对齐 registry.builtinAliases（默认免费模型）
export const BUILTIN_ALIASES = {
  deepai: DEFAULT_MODEL,
  "deepai-code": DEFAULT_MODEL,
  default: DEFAULT_MODEL,
  "gpt-3.5-turbo": DEFAULT_MODEL,
  "gpt-4": DEFAULT_MODEL,
  "gpt-4o": DEFAULT_MODEL,
  "gpt-4o-mini": DEFAULT_MODEL,
  "gpt-4.1": DEFAULT_MODEL,
  "claude-3-5-sonnet": DEFAULT_MODEL,
  "claude-sonnet-4": DEFAULT_MODEL,
  "claude-3-haiku": DEFAULT_MODEL,
  "deepseek-chat": DEFAULT_MODEL,
  "glm-4-flash": DEFAULT_MODEL,
}

// 免费额度 0 被判为陈旧的时限（store.QuotaStaleAfter）
export const QUOTA_STALE_MS = 15 * 60 * 1000
// capacity 409 的 Retry-After 默认回退
export const RETRY_AFTER_FALLBACK_MS = 2000

export const SIGN_IN_HEADER = "X-Magpie-Sign-In"
