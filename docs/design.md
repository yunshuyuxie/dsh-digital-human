# 数字人设计文档 — 本机监控 · 离线可装 · 桌面浮窗宠物

| 项 | 值 |
|---|---|
| 文档版本 | v1（M0 评审稿） |
| 目标 DSH | `@deepseek-ai/dsh` ≥ 0.1.5-rc.1（实测基线 0.1.5-rc.1 / 包 0.1.5-rc.2） |
| 目标平台 | Windows 优先（POSIX socket 代码路径保留，不承诺） |
| 协议版本 | `PROTOCOL_VERSION = 1` |
| 状态 | 待评审 → 通过后进入 M1 |

> 本文档是 M0 的唯一交付物。每个待定项都写了默认值；不改即按默认执行。
> 编码从 M1 开始，评审通过前不写实现代码。

---

## 1. 目标与成功标准

### 1.1 目标

数字人 = **一个本机桌面宠物应用** + **一个可离线安装的 dsh 插件包**。

- 宠物监控**本机** dsh 的任务运行状态（会话、轮次、工具调用、后台任务）；
- 宠物承担**权限确认**（沙箱升级等敏感操作）；
- 宠物可**下发任务与取消**；
- 全程**不产生任何网络监听或外联**；
- 插件通过**独立安装包**扩展 dsh，且**完全离线可用**。

### 1.2 成功标准（逐条可手工验收）

| # | 验收动作 | 通过判据 |
|---|---|---|
| 1 | **断网**环境下用安装包把桥接插件装进本机 `web` profile，运行 `verify.ps1` | 全部检查通过；安装过程无 registry / pnpm / 网络调用 |
| 2 | 断网安装并启动 App | 启动成功，**零配置**自动发现本机桥接（显示主机名、版本、活动 profile） |
| 3 | 在 Web GUI 里跑一个会话 | App 在 1s 内看到会话、运行状态、后台任务、当前工具调用 |
| 4 | 触发一次权限请求 | 宠物弹卡并显示**工具名 + 参数**；点「允许一次」后工具继续执行；会话日志出现 `approval/asked` + `approval/decided: allowed-once` |
| 5 | 退出 App 后再触发权限请求 | 请求回落到 GUI 的 composer 审批面板（委托生效）；重开 App 恢复接管 |
| 6 | 在 App 里对会话下发 prompt / 点取消 | 该会话开新轮次 / 当前轮次被取消 |
| 7 | `netstat -ano` 对照安装前后 | **无新增监听端口**；桥接仅有一个命名管道 |
| 8 | 同时跑两个 profile | 各自独立 endpoint 文件与管道，互不抢占 |

---

## 2. 调研结论（决定设计的事实）

以下均为阅读本机安装的 DSH 源码后确认的事实，不是推测。

| # | 事实 | 出处 | 对设计的影响 |
|---|---|---|---|
| F1 | `dsh web --host 0.0.0.0` 被显式拒绝：*"it would expose remote code execution to the network"* | `dsh-web-app/lib/startup.js:40` | 跨机/远程复用 Web API 直接否决——与"只监控本机"一致 |
| F2 | `/api` 只认 `GET /?token=` 换来的签名 cookie；**不接受** query token 或 Authorization header；另有 Host/Origin 信任栅栏 | `dsh-client-connection/README.zh.md` §浏览器认证与请求信任 | 第三方客户端复用 `/api` = 依赖内部线协议，否决 |
| F3 | ACP 是 stdio 且只能驱动自己 spawn 的 agent；另有 `request.callId === undefined → next()` 缺口 | `dsh-acp/README.zh.md`、`dsh-acp/lib/index.js:1115` | ACP 适合"本机操作端"，无法监控 GUI 既有会话 → 本期不用 |
| F4 | 审批转发在**无客户端连接时** `queue.push()` 返回 false → `next()` 委托 | `dsh-api-remotes/lib/index.js:198` | 宠物接管、GUI 兜底天然可行 |
| F5 | `ctx.sessionController` 提供 `list/inspect/create/prompt/cancel/selectModel/rename/fork/updateQueue/modelCatalog/resolveAgent`；`control(signal)` 给**含 jobs 的全量实时基线** + 增量帧；`follow()` 给持久事件流 | `dsh-api-session-controller/lib/types/index.d.ts` | 桥接是薄适配层，不重造会话语义 |
| F6 | host 事件名：`session/event`、`turn/start`、`turn/end`、`tool/call`、`tool/result`、`assistant/message`、`user/message`、`agent/error`、`approval/asked`、`approval/decided`、`session/title` | `dsh-session/lib/types/known-event-types.js` | 活动流来源 |
| F7 | `ctx.credentials` 提供 `readRecord/modifyRecord/listRecords`（grant record） | `dsh-credentials/lib/types/index.d.ts:159-174` | 本地 token 的存储思路参照 `client-connection` |
| F8 | `dsh-host-webserver` 是单例服务，`host` 只接受 `127.0.0.1` 或 `0.0.0.0` | `dsh-host-webserver/README.zh.md` | 桥接**不复用**它，自建本机 IPC，避免任何监听端口 |
| F9 | `link:` 安装不会安装目标包依赖 | pnpm 语义（本会话已实测） | 桥接必须**零运行时依赖**，否则离线装不上 |
| F10 | 实测：`dsh plugin --profile web add link:…` 后，profile 里出现的是 **Junction**，并写入 profile `package.json` 依赖项与 `pnpm-lock.yaml` | 本会话安装记录 | 离线安装可手工复现这三步（junction + 依赖项 + patch 行），绕开 pnpm |
| F11 | 同一 profile 的 patch 文件为 `patchReload: live`，改动后无需重启 dsh 即可重组（本会话已验证：写入 patch 行 + 刷新页面即出现插件） | `$DSH_HOME/profiles/web/package.json` + 本会话实测 | 安装后无需重启 dsh，仅需刷新 GUI 页面 |
| F12 | React 19 移除了 UMD 构建 | 公开事实 | 渲染层锁 `react@18`，走零打包路径 |

---

## 3. 总体架构

```
┌─ 本机（唯一一台机器） ──────────────────────────────────────────┐
│  dsh --profile web                                             │
│   ├─ 既有行：web GUI / sessionController / credentials / …      │
│   └─ 新增行：dsh-digital-human-bridge（离线安装包装入）          │
│        · \\.\pipe\dsh-digital-human-web     仅本机、无 TCP 端口  │
│        · NDJSON 双向：RPC 请求/应答 + 事件推送                   │
│        · approval/request 应答者（默认 primary，App 离线即让位）  │
│        · 写 $DSH_HOME/digital-human/endpoints/web.json          │
└───────────────────────┬────────────────────────────────────────┘
                        │ 命名管道（Windows）/ Unix domain socket（POSIX）
                        │ 本机 IPC：零监听端口、零外联
┌───────────────────────┴────────────────────────────────────────┐
│  Electron App（桌面浮窗宠物，随包自带运行时）                    │
│   main    ：端点发现 / 管道连接 / 窗口 / 托盘 / 配置             │
│   preload ：contextBridge 白名单 API                            │
│   renderer：化身浮窗 + 监控面板 + 审批卡 + 输入框                 │
└────────────────────────────────────────────────────────────────┘
```

### 3.1 关键决策与理由

| 决策 | 理由 |
|---|---|
| 只监控本机，不做任何跨机通道 | 网络面归零。按 F1/F2，唯一"远程"路径要么被安全策略拒绝，要么依赖内部线协议 |
| 本机 IPC 用命名管道，不用 TCP loopback | 管道默认 DACL 只对创建者用户（+管理员）开放；不会有端口冲突、不会被防火墙或其它机器触及，也不会因将来某次绑定改动而意外暴露 |
| NDJSON 单连接双工 | 与 DSH 自身 stdio JSON-RPC 风格一致；零依赖（`node:net` + `node:fs` 足够） |
| 桥接零运行时依赖 | F9：`link:` 不装依赖；零依赖才能在离线机器上直接可用 |
| 安装走纯文件系统（junction + 依赖项 + patch 行） | F10：这三步正是 pnpm 安装后实际产生的状态；绕开 pnpm/registry 即天然离线 |
| 复用 `ctx.sessionController` | F5：行为与 Web GUI 天然一致，DSH 升级时不会走偏 |
| 审批默认 `primary` | 若默认 `fallback`，本机 GUI 常开时宠物永远收不到审批 → 核心功能失效。`primary` 且"App 未连接立即委托"两头都不误 |

---

## 4. 仓库结构

```
D:\ywl\dsh-plugins\
├─ pnpm-workspace.yaml
├─ package.json                              # 根脚本：build / test / pack
├─ docs\
│  └─ design.md                              # ★ 本文档（M0 交付物）
├─ packages\
│  ├─ protocol\   dsh-digital-human-protocol
│  │   ├─ package.json                       # private，零依赖，ESM
│  │   └─ src\{index.js,messages.js,guards.js,codec.js}
│  ├─ bridge\     dsh-digital-human-bridge
│  │   ├─ package.json                       # private，零运行时依赖，ESM
│  │   ├─ src\
│  │   │   ├─ index.js                       # 插件入口：apply + 配置校验
│  │   │   ├─ config.js                      # 手工校验 + 默认值
│  │   │   ├─ ipc.js                         # node:net 服务端 + NDJSON 编解码
│  │   │   ├─ handshake.js                   # token 双向 HMAC 证明
│  │   │   ├─ projector.js                   # sessionController → 协议消息
│  │   │   ├─ approvals.js                   # approval/request 应答者
│  │   │   ├─ commands.js                    # prompt / cancel / create / selectModel
│  │   │   ├─ endpoint.js                    # endpoints/*.json + secrets.json
│  │   │   ├─ audit.js                       # audit.jsonl
│  │   │   └─ vendor\protocol\               # sync-protocol 生成（自包含）
│  │   ├─ tools\probe.mjs                    # 无 GUI 的连接探针（M1 验收用）
│  │   ├─ scripts\{install.ps1,uninstall.ps1,verify.ps1,pack.ps1}
│  │   └─ README.md                          # 含离线安装说明
│  └─ app\        dsh-digital-human-app
│      ├─ package.json                       # electron + react@18 + react-dom@18
│      ├─ electron-builder.yml
│      ├─ src\main\{index.js,windows.js,tray.js,endpoint.js,connection.js,config.js,ipc-api.js}
│      ├─ src\preload\index.js
│      ├─ src\renderer\{index.html,app.js,state.js,avatar.js,panel.js,approval.js,
│      │               sessions.js,activity.js,composer.js,locales.js,styles.css}
│      ├─ src\vendor\protocol\               # sync-protocol 生成（自包含）
│      └─ build\{icon.ico,icon.png}
├─ tools\
│  └─ sync-protocol.mjs                      # protocol → 两个产物的 vendor/
└─ archive\
   └─ dsh-digital-human-web-plugin\          # 下线的 Web 插件原文（不删，可回滚）
```

### 4.1 自包含约束

桥接安装包与 App 安装包**各自内联一份协议代码**（`tools/sync-protocol.mjs` 拷入 `src/vendor/protocol/`），确保任一产物单独拷到离线机器都能跑。测试用例逐字节比对三份（`packages/protocol` 与两个 vendor）是否一致。

---

## 5. 子系统设计

### 5.1 协议 `packages/protocol`

- **帧格式**：NDJSON。一行一个 JSON 对象，`\n` 结尾；单帧上限 `maxFrameBytes`（默认 262144），超限截断并置 `truncated: true`；非法 UTF-8 / 非法 JSON → 记录并关闭该连接。
- **版本**：`PROTOCOL_VERSION = 1`。握手双向校验，不匹配即拒绝并给出可操作错误（提示升级哪一侧）。
- **消息目录**（新增公开接口面）：

#### 握手

```jsonc
// C→S
{ "type": "hello", "protocol": 1, "clientId": "app-<uuid>", "clientName": "DESKTOP-01",
  "token": "<base32>", "clientNonce": "<base64 16B>" }

// S→C
{ "type": "welcome", "protocol": 1, "host": "DESKTOP-01", "profile": "web",
  "pid": 12345, "bridgeVersion": "0.1.0", "dshVersion": "0.1.5-rc.1",
  "capabilities": ["control","activity","approvals","prompt","cancel","create","selectModel"],
  "serverNonce": "<base64 16B>",
  "proof": "<base64 HMAC-SHA256(token, clientNonce ‖ serverNonce)>" }

// C→S（校验 proof 通过后）
{ "type": "ready" }
```

`proof` 是**双向证明**的服务器半边：客户端验证它，确保对面真的持有 token（防管道抢注与误连）。此后服务器推送 `baseline`。

#### RPC

| method | params | result |
|---|---|---|
| `sessions.list` | `{}` | `{ sessions: SessionSummaryMirror[] }` |
| `session.subscribe` | `{ sessionId, fromSeq? }` | `{ subscribed: true }` |
| `session.unsubscribe` | `{ sessionId }` | `{ unsubscribed: true }` |
| `command.create` | `{ cwd }` | `{ sessionId }` |
| `command.prompt` | `{ sessionId, content: [{type:'text',text}], requestId }` | `{ accepted: true }` |
| `command.cancel` | `{ sessionId }` | `{ cancelled: true }` |
| `command.selectModel` | `{ sessionId, provider, model }` | `{ provider, model }` |
| `approval.decide` | `{ approvalId, decision: 'allow-once' \| 'reject' }` | `{ outcome }` |
| `ping` | `{}` | `{ pong: true, serverTime }` |

```jsonc
// 请求 / 应答
{ "type": "rpc", "id": "c1", "method": "sessions.list", "params": {} }
{ "type": "result", "id": "c1", "value": { "sessions": [ /* … */ ] } }
{ "type": "error",  "id": "c1", "code": "session-not-found", "message": "会话不存在或已删除" }
```

#### 事件（服务器主动推送）

| event | data 要点 |
|---|---|
| `baseline` | `{ sessions, control: SessionControlFrame, approvals: ApprovalMirror[] }`——**重连后整体覆盖本地状态** |
| `sessions.changed` | `{ upsert?: SessionSummaryMirror[], removed?: string[] }` |
| `control.frame` | `SessionControlFrame` 原样转发（queue / jobs / projection 增量） |
| `activity` | `{ sessionId, seq, kind, tool?, args?, status?, text?, truncated? }`，`kind ∈ turn/start ∪ turn/end ∪ tool/call ∪ tool/result ∪ assistant/message ∪ agent/error` |
| `approval.request` | `{ approvalId, sessionId, toolName, callId?, reason?, args?, deadlineAt }` |
| `approval.settled` | `{ approvalId, outcome }`——多实例时让其它实例收卡 |
| `bridge.notice` | `{ level: 'info' \| 'warn', code, message }`——如"某 profile 的 token 缺失，已临时生成" |

`SessionSummaryMirror` 字段：`{ id, displayTitle, cwd?, running, blank, updatedAt, lastAgentError? }`。

- **镜像类型原因**：不让 App 依赖 DSH 包的类型；协议包自带最小镜像类型 + 手写 guard，DSH 侧只做一次性投影。

### 5.2 桥接插件 `packages/bridge`

#### 5.2.1 配置（手工校验，零依赖）

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 关闭则不建立 IPC |
| `pipeName` | `dsh-digital-human-<profile>` | Windows 命名管道名；POSIX 下为 socket 文件名 |
| `approvalRouting` | `'primary'` | `primary`：抢在 GUI 前应答，**App 未连接立即委托**；`fallback`：仅无浏览器连接时应答；`off`：只监控不参与审批 |
| `approvalTimeoutMs` | `120000` | 超时即 `next()` 委托，**绝不扣住请求** |
| `approvalToolAllowlist` | `[]`（空 = 全部） | 仅允许这些工具被 App 批准；**拒绝永不限流** |
| `activityBufferPerSession` | `200` | 每会话活动环形缓冲长度 |
| `activityMaxTextBytes` | `2048` | 单条活动文本上限，超出截断 |
| `maxClients` | `4` | 并发 App 连接上限 |
| `maxFrameBytes` | `262144` | 单帧上限 |
| `writeBufferLimitBytes` | `4194304` | 单连接写缓冲上限，超出断开该客户端（保护 host） |
| `auditFile` | `$DSH_HOME/digital-human/audit.jsonl` | 审计落盘路径 |

配置校验失败**即抛错**（fail loud，与 DSH 既有插件一致），错误信息指出字段与期望。

#### 5.2.2 挂载骨架

```js
// packages/bridge/src/index.js
export const name = 'digital-human-bridge'

export function apply(ctx, rawConfig) {
  const config = parseConfig(rawConfig, ctx)          // 手工校验；失败 throw
  if (!config.enabled) return
  ctx.inject(['sessionController'], (scoped) => {     // 控制器就绪后再挂 IPC
    const ipc = createIpcServer(scoped, config)       // node:net + node:fs
    scoped.effect(() => () => ipc.close(), 'digital-human-bridge: ipc')
    if (config.approvalRouting !== 'off') installAnswerer(scoped, ipc, config)
  })
}
```

- 插件**不导出 `Config` schema**（避免依赖 `@deepseek-ai/schemastery`）；改用 `config.js` 手工校验。这一条是"零依赖"约束的直接后果。
- 不导出 `dsh.client`（纯 host 插件）。

#### 5.2.3 数据源映射

| 协议输出 | DSH 来源 | 说明 |
|---|---|---|
| `baseline.sessions` / `sessions.changed` | `sessionController.list()` + `session/created`/`session/disposed`/`session/title` 事件 | 冷读，**不激活 Agent** |
| `baseline.control` / `control.frame` | `sessionController.control(signal)` | 原样转发（queue / jobs / projection），天然带重连基线 |
| `activity` | `sessionController.follow({sessionId, lastSeq}, signal)` 按订阅过滤投影 | 只发面事件；剥离 assistant 流式增量细节 |
| `approval.request` | `ctx.on('approval/request')` 应答者 | 见 5.2.4 |
| 命令 | `sessionController.create/prompt/cancel/selectModel` | `prompt` 带幂等 `requestId`（DSH 已有该语义） |

#### 5.2.4 审批应答者（安全关键）

**路由模式**

| 模式 | 注册方式 | 行为 |
|---|---|---|
| `primary`（默认） | `ctx.on('approval/request', handler, { prepend: true })` | 抢在 `dsh-api-remotes` 前；**无已认证 App 连接 → 立即 `next()`**；有连接 → 推 `approval.request` 等决策 |
| `fallback` | `ctx.on('approval/request', handler)` | 落在转发器之后；浏览器在线时浏览器赢，无浏览器连接时（F4）转发器会 `next()`，由宠物接管 |
| `off` | 不注册 | 纯监控 |

**结果词表**：严格使用 Host 封闭集 `allowed-once` / `rejected` / `cancelled` / `unavailable`。

**必守规则**

1. `request.callId === undefined` → 直接 `next()`。这类请求**无法由数字人批准**（DSH 既定缺口），只会在无处应答时 fail closed。
2. `approvalToolAllowlist` 非空时，允许仅对名单内工具生效；**拒绝永远放行**。
3. 超时（`approvalTimeoutMs`）或 App 断开 → `next()` 委托，绝不擅自判拒绝。
4. 插件被释放（dsh 关闭 / 热重载）时，所有未决审批**逐一 `next()` 委托**，不允许悬空。
5. 每次请求与决策写 `audit.jsonl`：`{ ts, profile, sessionId, toolName, callId, reason, decision, outcome, clientId, routing, latencyMs }`。
6. DSH 自身的 `approval/asked` / `approval/decided` 照常落会话日志（无需我们干预，天然审计）。

#### 5.2.5 端点发现与 token

**endpoint 文件**（不含任何密钥，供 App 零配置发现）

`$DSH_HOME/digital-human/endpoints/<profile>.json`

```json
{
  "version": 1,
  "protocol": 1,
  "transport": "pipe",
  "path": "\\\\.\\pipe\\dsh-digital-human-web",
  "profile": "web",
  "pid": 12345,
  "host": "DESKTOP-01",
  "dshVersion": "0.1.5-rc.1",
  "bridgeVersion": "0.1.0",
  "startedAt": "2026-09-12T12:00:00.000Z",
  "capabilities": ["control", "activity", "approvals", "prompt", "cancel", "create", "selectModel"]
}
```

插件释放时删除该文件（崩溃残留由 App 侧 "握手失败 → 视为陈旧" 处理，并在 M1 探针里覆盖该分支）。

**token 文件**（纵深防御，非安全边界）

`$DSH_HOME/digital-human/secrets.json`

```json
{ "version": 1, "profiles": { "web": { "token": "<base32 32B>", "createdAt": "…", "rotatedAt": null } } }
```

- 首次挂载生成并持久化；同时**镜像写入 `ctx.credentials`**（record key `digital-human/bridge/<profile>`），保持与 DSH 既有密钥管理一致。
- 选择 JSON 而非 `.credentials.yaml` 的原因：App 是零依赖，需要能直接解析；该文件与 DSH 自己的 `.credentials.yaml` 同级同敏感度（都在 `$DSH_HOME`）。

**威胁模型（写清边界，不夸大）**

> **真正的安全边界是操作系统用户账户。** 同用户下的任何进程本就能读会话日志、DSH 家目录（含 API 密钥）与本次 token，因此 token + 双向 HMAC + 管道 DACL 是**纵深防御**，用于挡"不同用户、管道抢注、误连"，而不是挡同用户恶意软件。
>
> Node 的 `net.createServer` 不提供自定义管道 DACL 的接口；如需更严的同用户隔离需原生模块——**明确列为非目标**。

**其他边界**：不监听任何 TCP 端口；不做任何外联（无遥测、无更新检查、无 CDN 资源）。

#### 5.2.6 失败模式

| 情况 | 行为 |
|---|---|
| 管道名占用 | 记录 warning，**不阻断 profile 加载**（其它 profile 仍可服务）；endpoint 文件不写 |
| `sessionController` 缺失 | 不建立 IPC，warn 说明缺少哪个服务 |
| `credentials` 缺失 | 退化为进程内临时 token，写 `bridge.notice` 显著警告（App 侧重启后需重读） |
| 慢客户端 | 写缓冲超 `writeBufferLimitBytes` → 断开该客户端，不影响 host |
| 超大帧 | 截断 + `truncated: true` |
| 非法 JSON / 非法 UTF-8 | 记录并关闭该连接 |
| 未认证连接洪泛 | 每连接握手超时 5s；同一进程内超过 10 次失败握手则暂停接受 60s |

### 5.3 桌面 App `packages/app`

#### 5.3.1 主进程模块

| 模块 | 职责 |
|---|---|
| `endpoint.js` | 扫描 `$DSH_HOME/digital-human/endpoints/*.json`（**零配置发现**）；无 dsh / 无插件时返回空态而非报错 |
| `connection.js` | `net.connect({path})` + NDJSON 行解析（零依赖）；退避 0.5/1/2/4/8/10s + 抖动（照抄 `dsh-client-connection` 档位）；重连后以 `baseline` 整体重建并**丢弃旧待审批卡** |
| `windows.js` | 化身窗：`frameless + transparent + alwaysOnTop + skipTaskbar + resizable:false`；面板窗：常规窗；`setIgnoreMouseEvents(true,{forward:true})` 穿透，悬停化身区切回可交互；`-webkit-app-region: drag` 拖动；位置用 `screen.getDisplayNearestPoint` 恢复 |
| `tray.js` | 托盘图标 + 未决审批角标 + 显示/隐藏/退出 |
| `config.js` | `%APPDATA%/dsh-digital-human/config.json` 读写 |
| `ipc-api.js` | 主进程 ↔ 渲染层 IPC 路由（与 preload 白名单一一对应） |

#### 5.3.2 安全硬化

`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；渲染层**无网络能力**；CSP 禁远程资源；不加载任何远程内容；`shell.openExternal` 仅对白名单协议开放（如需）。

#### 5.3.3 渲染层（零打包：React 18 UMD + `h()` 手写元素）

- **从下线的 Web 插件迁移**（迁移而非双份维护）：`avatar.js` 的 SVG 表情、表情判定优先级、文案键、`styles`。
- 状态机输入由"客户端 sessions 镜像"改为"桥接推送"（`baseline` / `control.frame` / `activity` / `approval.request`），输出同一套表情：

| 表情 | 触发 |
|---|---|
| `offline` | 未连接 / 未发现 endpoint |
| `idle` | 已连接、无运行中会话 |
| `thinking` | 当前会话 running，无活跃工具 |
| `working` | 有活跃工具调用或运行中的后台任务 |
| `waiting` | 有未决审批（最高优先级） |
| `error` | `lastAgentError` 或失败任务 |
| `done` | 轮次/任务在最近数秒内完成 |

- 面板内容：会话列表（状态/标题/工作区）、当前会话后台任务、活动流（最近 N 条，工具名 + 参数摘要）、审批卡（允许一次 / 拒绝 + 倒计时）、输入框（下发 prompt）与取消按钮。
- 通知：桌面通知 + 托盘闪烁/提示音（可关）；断连时化身进 `offline` 并在气泡说明原因。

#### 5.3.4 App 配置

```jsonc
// %APPDATA%/dsh-digital-human/config.json
{
  "version": 1,
  "dshHome": null,                 // null = 用 $DSH_HOME 或 ~/.dsh
  "activeProfile": "web",
  "autoConnect": true,
  "window": { "x": 1600, "y": 880 },
  "behavior": { "alwaysOnTop": true, "clickThrough": true, "startWithWindows": false },
  "notify": { "desktop": true, "sound": true, "approvalOnly": true }
}
```

#### 5.3.5 打包

`electron-builder` → NSIS 安装包 + portable zip；Electron 运行时随包；**关闭自动更新**；无遥测；图标内嵌。未签名说明（SmartScreen 处理与自签方案）写进 README。

### 5.4 离线安装包（硬要求）

#### 5.4.1 桥接插件包布局

```
dsh-digital-human-bridge-0.1.0.zip
├─ package\                 # 插件本体（零依赖，含 vendor\protocol）
├─ install.ps1              # 离线安装
├─ uninstall.ps1            # 离线卸载
├─ verify.ps1               # 离线自检
├─ compat.json              # 兼容矩阵
├─ CHECKSUMS.txt            # sha256
└─ 安装说明.md
```

```jsonc
// compat.json
{ "bridge": "0.1.0", "protocol": 1,
  "dsh": ">=0.1.5-rc.1 <0.2.0", "node": ">=20", "os": ["win32"] }
```

#### 5.4.2 `install.ps1` 流程（**不调用 pnpm、不访问 registry**）

1. 解析参数：`-Profile web`、`-DshHome`（默认 `$env:DSH_HOME` → `~/.dsh`）、`-DryRun`。
2. **兼容校验**：读取 `<dsh 安装>/package.json` 的 `version`，与 `compat.json.dsh` 比对；不兼容即中止并说明原因。
3. **备份**：profile 的 `package.json` 与 `cordis.patch.yml` 各存一份 `.bak-<yyyyMMddHHmmss>`。
4. **建 junction**：`<profile>\node_modules\<pkgName>` → `<安装根>\package`（已存在则先移除；实测 pnpm 也是建 Junction，见 F10）。
5. **写依赖项**：在 profile `package.json` 的 `dependencies` 中写入 `"dsh-digital-human-bridge": "file:<安装根>/package"`。
   > 说明：Loader 按**模块名**从 profile 目录做 node 解析（命中第 4 步的 junction），因此这条依赖项**不是加载的必要条件**，它的作用是让安装状态可被 `dsh plugin` 与卸载脚本识别。M1 需实测确认"仅手工 junction + 该依赖项"即可被解析（风险 R1）。
6. **合并 patch 行**：用带标记块的合并（沿用已验证的 `merge-patch.ps1` 模式与**三态开关语义**），插入桥接行与所需配置。
7. **自检**：直接调用 `verify.ps1`。
8. 输出后续动作：刷新 GUI 页面（F11：`patchReload: live`，无需重启 dsh）；若 dsh 未运行，提示启动后 App 才能发现 endpoint。

#### 5.4.3 `verify.ps1`（离线自检）

| 检查 | 判据 |
|---|---|
| 依赖项存在 | profile `package.json` 含该依赖且指向安装根 |
| junction 有效 | 解析到安装根，且 `package\lib\index.js`（或 `src/index.js`）存在 |
| 组合树包含该行 | 用 `@deepseek-ai/dsh-app-boot` 的 `loadProfile` + `composeEntries` 复算（沿用已验证的 `compose-check.mjs` 思路），断言 row 存在且未被禁用 |
| 协议自包含 | `package\src\vendor\protocol` 与安装包内 `protocol.sha256` 一致 |
| 运行期（dsh 在跑时） | endpoint 文件存在；管道可连接；`hello/welcome` 握手成功；`sessions.list` 返回 |

任一项失败即非零退出并给出可操作原因。

#### 5.4.4 `uninstall.ps1` 流程

1. 移除 junction；
2. 移除 profile `package.json` 中的依赖项；
3. 移除标记块内的行，并**恢复被我们改动的自带行**（例如 `ui-approval` 的 `disabled`）；
4. 可选 `-PurgeState`：清理该 profile 的 endpoint 文件与 `secrets.json` 条目；
5. 输出：刷新页面即可恢复原状。

**幂等与安全**：重复安装不重复插行、不回退已有选择；卸载后不残留任何桥接行为（会话日志里已产生的审计事件保留，属历史）。

#### 5.4.5 App 包与构建侧离线

- App：NSIS + portable zip，Electron 运行时随包，安装与运行全程无需网络。
- `pack.ps1 -Offline`：使用本地 Electron 缓存目录（不重新下载）；`electron-builder` 缓存路径写入 `安装说明.md`。
- 首次运行向导为纯本地向导：选择 dsh 家目录 → 显示扫描到的 endpoint → 完成。

### 5.5 下线现有 Web 插件

**时机：M2（App 能批权限）验收通过后**，避免出现"卸了插件却没人能批权限"的真空期。

1. `dsh plugin --profile web remove dsh-digital-human`（或离线等价的手工移除）；
2. 用 `merge-patch.ps1` 的标记块机制去掉插件行，并以 `-NoOwnApprovals` 恢复 `ui-approval`；
3. 包体移入 `archive/dsh-digital-human-web-plugin/`，附 README 说明"已被独立 App 取代"与回滚步骤；
4. **迁移清单**：`avatar.js` / `styles.js` / `locales.js` → App renderer；`store.js` 的判定优先级 → App 状态机；`tools/preflight.mjs` / `tools/compose-check.mjs` 的**思路**→ `verify.ps1`；其余（`plugin.js` / `overlay.js` / `approval.js` / 构建脚本）随包归档，不再维护；
5. 这些步骤需写 `$DSH_HOME`（工作区之外），沿用本会话已验证的"先取真实拒绝、再一次性提权重试"流程。

---

## 6. 数据流要点

### 6.1 启动与发现

```
dsh 启动 → 桥接行挂载 → 生成/读取 token → 建管道 → 写 endpoints\web.json
App 启动 → 扫 endpoints\*.json → net.connect(path) → hello/welcome（双向证明）
        → ready → 收到 baseline → 化身进入 idle
```

### 6.2 权限确认

```
工具需要授权 → approval/request
  ├─ App 已连接（primary）：推 approval.request（含同一 callId 的 tool/call 参数）
  │    → 宠物弹卡 → 用户点「允许一次」→ approval.decide → 桥接 resolve waterfall
  │    → 工具继续 → approval.settled 广播 → 各实例收卡
  └─ App 未连接：立即 next() → dsh-api-remotes → GUI composer 面板 → 用户作答
会话日志：approval/asked + approval/decided（DSH 自身写入）
桥接审计：audit.jsonl（含 clientId 与 routing）
```

### 6.3 下发与取消

```
App 输入 → command.prompt {sessionId, content, requestId}
        → sessionController.prompt → turn/start 进活动流 → 表情转 thinking/working
App 点取消 → command.cancel → sessionController.cancel → turn/end(cancelled)
```

### 6.4 重连

```
管道断开 → 化身 offline → 退避重连 → hello/welcome → baseline 整体覆盖
        → 丢弃本地旧待审批卡（服务端仍挂起的审批会出现在 baseline.approvals 里）
```

---

## 7. 边界与失败模式（必须实现的行为）

| # | 情况 | 必须的行为 |
|---|---|---|
| 1 | App 未运行/未连接 | `primary` 立即委托 → GUI 面板接管（默认不干扰现有使用习惯） |
| 2 | 请求无 `callId` | 桥接 `next()`；App 不显示此类请求；文档写明无法由数字人批准 |
| 3 | 超大帧 / 超长活动文本 | 截断 + `truncated: true`，App 显示"内容已截断" |
| 4 | 慢客户端背压 | 写缓冲超阈值断开该客户端，保护 host |
| 5 | 多 App 实例 | 允许（`maxClients` 内）；`approval.settled` 广播收卡；先答者胜 |
| 6 | 宿主重启 | jobs 基线丢失（DSH 自身限制）→ App 显示"任务状态已重置"而非报错 |
| 7 | App 与 GUI 同时操作同一会话 | 由 `sessionController` 既有语义裁决，App 呈现结构化拒绝原因 |
| 8 | 管道名占用 / 无 credentials / 无 sessionController | 分别：warn 不阻断、临时 token + 显著警告、不建 IPC + warn |
| 9 | 多 profile 并行 | endpoint 按 profile 分文件、管道名带 profile 后缀，互不抢占 |
| 10 | 桥接释放时仍有未决审批 | 逐一 `next()` 委托，**不允许悬空** |
| 11 | endpoint 文件为崩溃残留 | App 握手失败 → 视为陈旧，提示"dsh 可能未运行"，不反复重试刷屏 |
| 12 | token 轮换后旧 App 会话 | 旧连接被拒（握手失败）→ App 提示重新读取本机 token |

---

## 8. 测试与验收

### 8.1 单元（`node --test`，零依赖）

- 协议 guard 正反例（缺字段、错类型、错枚举、超长帧）；
- 配置校验（非法 `approvalRouting`、负数超时、非法 `pipeName`）；
- 审批 outcome 映射：无 `callId`、allowlist 命中/未命中、超时、App 断开、插件释放；
- token 常量时间比较 + 双向证明（正确/错误 token、篡改 nonce）；
- 活动投影裁剪与截断；
- 表情判定优先级（waiting > error > working > thinking > done > idle > offline）；
- `sync-protocol` 三份一致性逐字节比对。

### 8.2 集成（真管道，不开 GUI）

内存假 host（stub `sessionController` + credentials）↔ 真 bridge（真命名管道）↔ 真 App 连接层（仅主进程模块）。

覆盖：握手失败分支、`baseline` 重建、断线重连、`primary`/`fallback` 两态、多客户端广播、`sockets` 关闭时未决审批委托、卸载后无残留。

### 8.3 端到端（本机双进程）

§1 的八条验收，在真 `dsh web` + 真 App 上逐条执行并记录结果。

### 8.4 离线验证

在禁用网卡（或临时把 registry 指向不可达地址）的环境下执行：`install.ps1` → `verify.ps1` → App 安装与启动；确认安装日志无网络调用，`netstat -ano` 无新增监听。

### 8.5 安全用例

错误 token / 缺失 token / 伪造 endpoint 文件 / 抢注管道 / 未认证连接洪泛 → 全部拒绝且不泄漏状态（响应中不含 token、路径以外的信息）。

---

## 9. 里程碑

| 期 | 内容 | 验收 |
|---|---|---|
| **M0** | 本文档 | 你评审确认（本轮结束） |
| M1 | `protocol` + `bridge` + 离线安装包（install/uninstall/verify/pack）+ 无 GUI 探针 | 断网装插件；§1-1、§1-7 通过；用 `probe.mjs` 驱动 §1-3、§1-4 |
| M2 | App 骨架：发现 + 连接 + 化身浮窗 + 审批卡 | §1-2、§1-3、§1-4、§1-5 通过 |
| M3 | 全操作端：会话列表 / 活动流 / 下发 / 取消 / 模型选择 | §1-6 通过 |
| M4 | 打包分发（NSIS + portable + 向导 + 文档）＋ 执行 Web 插件下线 | §1-8 + 断网装机演示 |
| M5 | 硬化与体验：多 profile 切换、allowlist 策略 UI、声音/语音、POSIX socket | 安全用例全绿 |

---

## 10. 风险与缓解

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 手工 junction 可能不被 Loader 正常解析 | **M1 首要验证项**（对应 F10 的复现）；失败则回退 `pnpm add --offline`，再不行用 `file:` 安装并接受无法热改 |
| R2 | 命名管道 DACL 无法从 Node 定制 | 文档明确"同用户即边界"；更强隔离（原生模块）列为非目标 |
| R3 | Electron 首次构建需下载运行时 | 构建机联网一次预热缓存；`pack.ps1 -Offline` 用缓存离线打包 |
| R4 | `primary` 模式下 App 卡住不答 | 120s 超时委托 + 断开委托，保证不死锁 |
| R5 | `follow()` 数据量大 | 投影 + 截断 + 环形缓冲（`activityBufferPerSession`） |
| R6 | DSH 版本升级导致服务/事件名变化 | 协议包与桥接对 `sessionController` 做能力探测（`capabilities` 上报可用方法）；`compat.json` 限定版本区间 |

---

## 11. 明确假设与非目标

**假设**
- 被监控机装有 dsh ≥ 0.1.5-rc.1 与 Node ≥ 20；App 与 dsh **同机同用户**；
- 一期 Windows；POSIX socket 代码路径保留但不承诺；
- 用户接受未签名安装包（SmartScreen 处理写进文档）。

**非目标（一期）**
- **任何跨机/网络监控**（明确排除，安全优先）；公网暴露；
- 完整会话转录渲染（只做活动流摘要）；
- 审批策略编辑 UI、语音指令、移动端；
- 自定义管道 DACL / 原生模块加固；
- 把包发布到公共 registry。

---

## 12. 请在评审时确认的 3 个默认值

| # | 默认值 | 若你想改 |
|---|---|---|
| 1 | `approvalRouting = 'primary'`：App 在运行时由宠物接管审批，App 退出自动回落 GUI 面板 | 改 `fallback` 则"GUI 常开时宠物永不弹卡" |
| 2 | 桥接**只建命名管道、不监听任何 TCP 端口** | — |
| 3 | 插件安装**完全绕开 pnpm/registry**（junction + 依赖项 + patch 合并） | 若接受联网，可在 M1 追加"在线安装"作为可选路径 |

---

## 附录 A：为什么不用这些方案（决策留痕）

| 方案 | 否决理由 |
|---|---|
| 跨机连接本机 dsh 的 Web API | F1：`--host 0.0.0.0` 被安全策略拒绝；F2：`/api` 只认浏览器 cookie，第三方客户端必须依赖内部线协议 |
| ACP（stdio） | F3：只能驱动自己 spawn 的 agent，无法监控 GUI 里正在跑的会话；且 stdio 仅同机 |
| TCP loopback + HTTP/SSE | 会多一个监听端口；管道在 DACL 与"不会意外暴露"两点上更优，且不需要 HTTP 语义 |
| 复用 `dsh-host-webserver` 注册路由 | F8：它是单例且 `host` 仅 loopback/0.0.0.0；复用会把 GUI 绑定与桥接绑定绑死 |
| 用 `ws` 做 WebSocket | F9：`link:` 不装依赖，引入 `ws` 会让离线安装变脆；NDJSON 已足够 |
| 文件邮箱（App 写决策文件、插件轮询） | 延迟与原子性差；审批是安全关键路径，不适合轮询 |

## 附录 B：安装后状态对照（供验证）

| 位置 | 安装后应存在 | 卸载后应消失 |
|---|---|---|
| `<profile>/package.json` | `dependencies["dsh-digital-human-bridge"]` | 该键 |
| `<profile>/node_modules/dsh-digital-human-bridge` | Junction → 安装根 `package` | 整个链接 |
| `<profile>/cordis.patch.yml` | 标记块内的桥接行 | 标记块内的行 |
| `$DSH_HOME/digital-human/endpoints/<profile>.json` | dsh 运行期间存在 | `-PurgeState` 时删除 |
| `$DSH_HOME/digital-human/secrets.json` | 该 profile 的 token 条目 | `-PurgeState` 时删除 |
| `$DSH_HOME/digital-human/audit.jsonl` | 审批审计追加 | 保留（历史） |
| 命名管道 | dsh 运行期间可连接 | 随进程释放 |
| 监听端口 | **无新增** | 无 |
