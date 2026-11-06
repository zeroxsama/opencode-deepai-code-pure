# opencode-deepai-code-pure

把 [DeepAICode2API](https://github.com/2951461586/DeepAICode2API) 的 Go 网关**整体复刻成 magpie / OpenCode 纯插件**：
插件跑在 magpie 的 Bun 宿主里，直接请求 `https://api.deepai.org`，**不需要启动 Go 进程**。

## 从 GitHub 安装（服务器上）

```bash
magpie plugin add zeroxsama/opencode-deepai-code-pure
# 或完整地址
magpie plugin add git+https://github.com/zeroxsama/opencode-deepai-code-pure.git
# 固定到某个提交
magpie plugin add zeroxsama/opencode-deepai-code-pure#<commit>
```

仓库根目录就是插件包（`package.json` 在此），magpie 用 Bun 直接拉取加载。

## 本地开发 / 推送

本仓库在 `D:/work/ai/opencode-deepai-code-pure`。改完文件后：

```bash
node scripts/push.mjs "fix: 描述改动"
```

> 该脚本用 GitHub Git Data API 上传当前工作区到 `main`（本环境 `git push`
> over HTTPS 会被 reset）。它基于远程当前 commit 生成新 commit，不依赖本地
> git 历史；token 从 git 凭据管理器读取，不落盘。`scripts/` 已被
> `.gitignore` 排除，不会进插件包。

本地自测：`node selftest.mjs` 或 `bun selftest.mjs`（18 项黑盒断言）。

## 架构

```text
Claude Code / Codex / pi / Cline
        │  (Anthropic / Responses / Chat / Gemini)
        ▼
   magpie 网关 ── 协议翻译 ──▶ 本插件 loader.fetch
                                  │  Api-Key / X-DeepAI-Code-Theos: 2
                                  │  X-DeepAI-Code-Machine / 指纹头
                                  │  号池轮询 / 换号 / 409 退避 / 用量
                                  ▼
                          https://api.deepai.org/deepai_code/*
```

## 覆盖矩阵（Go 功能 → 插件落点）

| Go 实现 | 插件模块 | 说明 |
| --- | --- | --- |
| `client.commonHeaders`（Api-Key / Theos 车道 / 机器指纹 / 浏览器指纹头） | `lib/upstream.mjs` `commonHeaders` | 逐头复刻，账号级指纹优先 |
| `machine.go` 指纹采集 / sha256 / 占位过滤 / 随机 UUID | `lib/machine.mjs` | Bun `$` 跑 powershell / ioreg / dmi |
| `helpers.go` 桌面端数据目录探测 | `lib/machine.mjs` `desktopSecretDirs` | `T3CODE_HOME` / `~/.deepai-code` |
| `import.go` 凭据导入 / 账号构造 / Key 校验 | `lib/account.mjs` `lib/oauth.mjs` | 4 种登录方式 |
| `store.go` 号池轮询 / 两轮配额筛选 / 失败换号 / 15min 陈旧判定 | `lib/pool.mjs` | `next` / `markResult` / `setAllowance` |
| `store.go` 状态持久化 + `state_seal.go` AES-256-GCM | `lib/state.mjs` | 落 `directory/deepai-pure-state.json`，可加密 |
| `client.FetchModels` + `registry.go` 别名 / 兜底 | `lib/catalog.mjs` | 精确→别名→包含→兜底，含 `free`/`rate`/Responses |
| `common.go openModel`（换号重试 / 409 + Retry-After / 错误映射） | `lib/upstream.mjs` `openModel` | capacity 不换号保持粘性 |
| `chat.go` `transformChatResponse/Chunk`、reasoning→reasoning_content | `lib/transform.mjs` | SSE 逐块改写，去掉 framing 头 |
| `common.go parseUsage` / 统计 | `lib/transform.mjs` `lib/state.mjs` | token / 成本 / 日志 |
| `client.Theos` / `UsageSummary` | `auth.usage` + `tool quota/usage` | Theos 钱包 + 订阅余额 |
| `client.WebSearch` / `FindService` / `Transcribe` | `lib/upstream.mjs` + `tool` | 联网能力给每个 agent |
| `login.go` 浏览器登录换 Key | `lib/oauth.mjs` + `auth.methods[2]` | 回环 `/auth-callback?code=` |
| `register/*` 注册 / 登录 / 取 Session / 验活 / 入池 | `lib/register.mjs` + `auth.methods[3]` | Cookie 会话、multipart、CF 邮箱 |
| `/admin/api/*` 账号 / 密钥 / 统计 / 设置 / 注册 | `lib/tools.mjs` + `page/` | MCP 工具 + 窗口页面/面板 |
| `X-Session-Affinity` / `prompt_cache_key` | `chat.headers` | sessionID 粘性 |
| 模型负载 / 路由 | `magpie.load` + `deepai.gateway.js` | 409 busy 上报 |

## 登录方式（`magpie plugin login deepai`）

1. **上游 API Key** — 直接填桌面端凭据里的 `apiKey`；多登录几次 = 号池多 Key。
2. **导入桌面端凭据** — 自动读 `~/.deepai-code/userdata/secrets/deepai-account.bin`。
3. **浏览器登录** — 打开桌面端登录页，回环回调换 Key（对齐 `login.go`）。
4. **注册新账号入池** — 复刻 `daily-time-sync/registration` 流水线。

所有方式产生的账号进入**同一个插件号池**；magpie 侧的「账号」映射到号池里的一个
`acctID`（存在 `auth.metadata`），`loader` 会优先用它发请求，其余账号作故障切换。

## 安装（沙箱）

```bash
magpie plugin add ./magpie-pure
magpie plugin login deepai        # 选一种登录方式
magpie plugin                     # deepai (DeepAI Code 纯插件, N models) signed in
magpie provider test deepai       # ✓ chat · glm-5.3-flash
magpie quota                      # Theos 余额 + 订阅
```

之后 agent 用 `deepai/glm-5.3-flash` 等模型。模型目录由上游动态下发，`provider.models`
每次登录刷新。

## 选项

```bash
magpie plugin options deepai '{
  "origin":"https://api.deepai.org",
  "domain":"your.mail.domain",
  "mailBackend":"cf",
  "tempMailBase":"https://your-worker",
  "tempMailAdminKey":"…",
  "verify":true,
  "group":"default",
  "importDesktop":true,
  "machineID":"",
  "masterKey":"<64 hex 或 base64 的 32 字节>"
}'
```

- `origin` / `DEEPAI_API_ORIGIN`：上游地址（自建测试可覆盖）。
- `machineID` / `DEEPAI_MACHINE_ID`：容器等无 SMBIOS 环境显式指定原始 UUID。
- `masterKey` / `DEEPAI2API_MASTER_KEY`：状态文件整体 AES-256-GCM 加密。
- `DEEPAI_API_KEY`：启动时直接注入一个账号。
- `importDesktop:false` 关闭自动导入桌面凭据。

## 双层账号语义

- **magpie 账号** = 号池里的一个 `acctID`（一次登录产生一个）。
- **号池账号** = 一个上游 API Key，带独立机器指纹（每日 Theos 各自发放）。

`loader` 优先用当前 magpie 账号对应的 Key；`openModel` 在失败 / 401 / 429 / 5xx 时
按 `Pool.next()` 换号，`409 session_busy` 按 `Retry-After` 等待后重试（不换号）。

## 工具（每个 agent 都能用）

插件提供 MCP 工具 `deepai-pure_*`：`quota`、`usage`、`web_search`、
`find_service`、`models`、`accounts`、`add_account`、`import_desktop`、
`stats`、`settings`、`register`。地址 `/mcp/magpie/tools`。

## 自测

```bash
bun ./magpie-pure/selftest.mjs     # 或 node ./magpie-pure/selftest.mjs
```

自测起一个 mock 上游（含 409 capacity、401 换号、模型目录、Theos、用量、注册），
黑盒验证私有头、号池换号、协议归一化、用量聚合、别名、状态加密等全链路。
