# dsh-digital-human-bridge

数字人的 **host 半边**：一个 DSH 插件，把本机会话状态、权限请求与会话命令暴露给桌面 App。

- 只监听**本机 IPC**（Windows 命名管道 / POSIX unix socket），**不开任何 TCP 端口**、不做任何外联；
- 零运行时依赖（`link:` 安装不会装依赖，这是硬约束）；
- **没接 App 时行为完全不变**：所有权限请求原样委托回 host 链，由 Web GUI 继续应答。

App（Electron 桌面宠物）是 M2 的产物；本包在 M1 已可用探针独立验证。

## 架构

```
dsh 进程
 ├─ 既有行：sessionController / credentials / web GUI …
 └─ 本插件（一行）
      ├─ ctx.sessionController.list()            → 会话列表（冷读，不激活 Agent）
      ├─ ctx.sessionController.control(signal)   → 队列 / 后台任务 / projection 实时流
      ├─ ctx.sessionController.follow(addr,sig)  → 每会话活动流（投影为 tool/call 等）
      ├─ ctx.on('approval/request', …, prepend)  → 权限确认应答者
      ├─ ctx.sessionController.{create,prompt,cancel,selectModel}
      └─ \\.\pipe\dsh-digital-human-<profile>    → NDJSON 双工协议
```

文件：`src/index.js`（接线）、`config.js`（校验）、`ipc.js`（管道 + 帧 + 背压）、`handshake.js`（token 双向证明）、`projector.js`（状态投影）、`approvals.js`（应答者）、`commands.js`、`endpoint.js`（端点文件 + token 存储）、`audit.js`、`vendor/protocol/`（内联的协议副本）。

## 安装（离线）

```powershell
# 从仓库直接装（开发）
pwsh -File scripts/install.ps1 -Profile web

# 或先打包，再从发布产物装（推荐）
pwsh -File scripts/pack.ps1
#   → dist/dsh-digital-human-bridge-0.2.1.zip
Expand-Archive dist\dsh-digital-human-bridge-0.2.1.zip -DestinationPath dist\release
pwsh -File dist\release\dsh-digital-human-bridge-0.2.1\install.ps1 -Profile web
```

安装做四件事，全部是文件系统操作，**不调用 pnpm、不访问 registry**：

1. 离线兼容门：读本机 `@deepseek-ai/dsh/package.json` 的版本，比对 `compat.json` 的区间；
2. 建 junction：`<profile>/node_modules/dsh-digital-human-bridge` → 包目录；
3. 写依赖项：profile `package.json` 增加 `"dsh-digital-human-bridge": "link:<包目录>"`（外科式文本编辑，保留其余格式）；
4. 合并 patch 行：把 `rows.yml`（其中 `__PROFILE__` 被替换为实际 profile 名）写入带标记块的位置。

第 1 步的 `@deepseek-ai/dsh` 位置按下面的顺序离线发现，不需要 `dsh` 在 PATH 上：解析 PATH 里 `dsh.cmd` / `dsh.bat` / `dsh.ps1` / `dsh` 的**自身内容**（npm / pnpm / nvm 生成的 shim 都写明了自己启动的入口路径）→ npm 用户前缀、nvm-windows 各版本目录、pnpm 全局 store → `npm prefix -g` / `pnpm root -g`（只读本地配置）。都不成立时用 `-DshInstall` 显式指定。


`patchReload: live` 的 profile 会**立即热挂载**该行，无需重启 dsh；只有浏览器页面需要刷新。

自检与卸载：

```powershell
pwsh -File scripts/verify.ps1 -Profile web        # 四层：文件 / 组合树 / 载荷校验和 / 运行时探针
pwsh -File scripts/uninstall.ps1 -Profile web     # 反向移除，保留用户自己的 patch 行
pwsh -File scripts/uninstall.ps1 -Profile web -PurgeState   # 额外清理端点文件与 token
```

`@deepseek-ai/dsh` 发现逻辑（安装脚本与组合自检各一份实现）的回归测试，用 fixture 覆盖 npm 前缀 / 本地 `.bin` / pnpm store / nvm / `%VAR%` 引用等布局：

```powershell
pwsh -File test/resolve-dshinstall.test.ps1   # PowerShell 侧（Windows PowerShell 5.1 亦可）
node test/run.mjs                             # 全量单进程测试，含 tools/find-install.mjs 的发现用例
```

## 无 GUI 探针

`tools/probe.mjs` 直接说客户端协议，可在没有 App 的情况下验证整条链路：

```powershell
node tools/probe.mjs --profile web --check
# probe: connected to LAPTOP-737BRQ6Q profile=web bridge=0.1.0
# probe: capabilities control, activity, approvals, prompt, cancel, create, selectModel
# probe: baseline sessions=5 approvals=0 jobs=2
#   session session-85cd175c… running=true title=…
# probe: CHECK OK

node tools/probe.mjs --profile web --subscribe <sessionId> --watch 30
# probe: activity tool/call session=… tool=pwsh status=in_progress
# probe: activity tool/result session=… tool=pwsh status=completed

node tools/probe.mjs --profile web --watch 120 --approve allow   # 自动允许到达的权限请求
node tools/probe.mjs --profile web --prompt <sessionId> "run the tests"
node tools/probe.mjs --profile web --cancel <sessionId>
```

退出码：`0` 成功、`1` 协议/连接失败、`2` 前置条件缺失（无端点文件或 token）。

## 配置（`rows.yml` 的 `config:`）

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 关闭则不建立 IPC |
| `profile` | 安装时注入 | 决定管道名与端点文件名（避免依赖运行时探测） |
| `pipeName` | `dsh-digital-human-<profile>` | 管道名 |
| `approvalRouting` | `primary` | `primary` 抢在 GUI 前（App 未连接立即委托）／`fallback` 仅无浏览器连接时／`off` 只监控 |
| `approvalTimeoutMs` | `120000` | 超时即委托，**绝不替用户决定** |
| `approvalToolAllowlist` | `[]` | 仅这些工具可被 App **批准**；拒绝永不受限 |
| `activityBufferPerSession` / `activityMaxTextBytes` | `200` / `2048` | 活动缓冲与截断 |
| `maxClients` / `maxFrameBytes` / `writeBufferLimitBytes` | `4` / `256 KiB` / `4 MiB` | 连接与流控上限 |
| `auditFile` | `<stateDir>/audit.jsonl` | 审计落盘 |
| `debug` | `false` | 打开后把 info/warn 打到 stderr（**从不写 stdout**） |

## 安全姿态

- **边界是操作系统用户账户**：同用户下的任何进程本就能读会话日志与 `$DSH_HOME`。token + 双向 HMAC 是**认证边界**（挡不同用户、误连，以及抢注管道后的冒充），不是同用户恶意软件的屏障。
- **Windows 上管道对所有本机用户可连**：named pipe 套用的是创建进程令牌的**默认 DACL**，而提权（管理员）令牌的默认 DACL 只给 Administrators/SYSTEM —— 于是用管理员权限启动 dsh 时，普通权限双击启动的 App 会**完全连不上**（`connect EPERM`，可端点文件与 token 照旧可读，极易被误判成"装好了却连不上"）。所以监听时带 `readableAll`/`writableAll`（libuv 会调 `uv_pipe_chmod` 加一个 Everyone ACE）把管道放宽；认证仍靠 token 握手，而 token 只对**本账户、SYSTEM 与 Administrators** 可读（`$DSH_HOME/digital-human/secrets.json`），别的本机用户连上也过不了握手。POSIX 侧相反：socket 文件收紧到 `0600`。
- 管道名固定、token 32 字节随机（base32），客户端必须证明持有 token，服务器也用同一 token 回证（防抢注）；比较是常量时间的。
- 未认证连接 5s 内未握手即断开；认证失败只回 `unauthorized`，不透露任何细节。
- 每次权限请求与决策都写入 `audit.jsonl`（含 `clientId` 与 `routing`），DSH 自身的 `approval/asked|decided` 照常落会话日志。

## 已知限制

- **`dshVersion` 首次挂载可能为 `unknown`**：插件从自身位置解析不到 harness 包时，回退用启动器入口推导；由于 ESM 模块缓存，补丁内容未变时热重载不会重新导入模块，该修复要等**下次 dsh 重启**才生效。App 侧应容忍 `unknown`。
- **会话列表包含 subagent 子会话**：host 的 `list()` 返回所有可见会话，协议镜像目前不带父会话字段（M3 再补 `parentId` 与过滤）。
- **无 `callId` 的权限请求无法由数字人批准**：host 无法为它寻址一项决定，桥接直接委托（`dsh-acp` 有同样限制）。
- **受限 shell 不能跑组合/探针自检**：`verify.ps1 -SkipCompose` 可跳过需要 node 的两层；某些沙箱禁止访问命名管道（`connect EPERM`），此时集成测试会诚实 SKIP。
- **更新包内容需让 dsh 重新加载**：改写 patch 块内容（或重启 dsh）才会重新导入插件模块。

## 故障排查

| 现象 | 处理 |
|---|---|
| `cannot find the installed @deepseek-ai/dsh` | 自动发现没命中该机器的安装布局：`npm prefix -g` / `pnpm root -g` 拿到前缀，再把 `<前缀>/node_modules/@deepseek-ai/dsh/package.json` 传给 `-DshInstall` |
| `probe: no endpoint file …` | dsh 未运行，或插件未安装；跑 `verify.ps1` 看组合层 |
| App 一直"正在连接/连接断开"，而端点文件、token、版本都正常 | dsh 是**以管理员权限**启动的：提权进程建的管道，普通权限的 App 连不上（0.2.1 及更早）。0.2.2 起插件已自动放宽管道；或改用普通权限启动 dsh（别经过 gsudo / "以管理员身份运行"） |
| 探针连上但收不到审批 | `approvalRouting` 是否为 `off`；是否已有浏览器客户端抢答（`fallback` 模式下浏览器优先） |
| 权限请求无人应答、工具失败关闭 | App/探针都没连上，或 `callId` 缺失导致委托到链尾 |
| 管道被占用（EADDRINUSE） | 另一个 profile 已用同名管道；给它配不同的 `pipeName`（插件只警告，不影响该 profile 加载） |
| `secrets.json` 损坏 | 插件**不会**覆盖它，认证会失败；手工修复或删除该文件后重启 dsh 重新生成 |
