# 开发环境注意事项（本机实测）

> **策略相关**：第 2、3 节描述的是**受限模式**（`workspace-write` + 审批开启）下的现象。
> 本会话后期策略改为 `danger-full-access` 且审批禁用后，`dsh`、`pnpm`、命名管道**都已可用**——
> 也就是说那两条限制来自沙箱策略，不是环境缺陷。保留原文是为了在受限模式下能快速认出这些症状。

本仓库在**这台 Windows 机器**上开发时踩到过几类坑。它们都不是猜测，是实际造成过损坏或误判的，照着做可以避免重演。

## 1. PowerShell 是 5.1，不是 7 —— 文本读写必须显式指定 UTF-8

宿主上的 `pwsh` 实际是 **Windows PowerShell 5.1**：

| 命令 | 实际行为 | 后果 |
|---|---|---|
| `Get-Content -Raw` | 按**当前 ANSI 代码页（GBK）**解码 | UTF-8 中文/符号变成乱码 |
| `Set-Content -Encoding UTF8` | 写入**带 BOM** 的 UTF-8 | `JSON.parse` 直接失败（BOM 不是合法 JSON 前缀） |

**实测两次损坏**：一次把三个 `.ps1` 脚本的中文注释双重编码；一次把 `renderer/panel.js` 的 `—`（U+2014）与 `·`（U+00B7）损坏，其中
`·`（UTF-8 `C2 B7`）恰好是合法 GBK 序列，**没有变成乱码，而是伪装成正常汉字 `路`**，逃过了按"是否乱码"的排查。

**规则**：

- 改任何含非 ASCII 的文件，用**文件编辑工具**，不要用 PowerShell 读改写。
- 非要在 PowerShell 里读写：用 .NET 显式无 BOM UTF-8。
  ```powershell
  $enc = [System.Text.UTF8Encoding]::new($false)
  $t = [System.IO.File]::ReadAllText($path, $enc)
  [System.IO.File]::WriteAllText($path, $changed, $enc)
  ```
- 只替换 ASCII 之外的字符时，**用码点构造**，别把乱码字面量写进命令：
  ```powershell
  $t.Replace([string][char]0x8DEF, [string][char]0x00B7)
  ```
- 修复后做**字符清点**（`ToCharArray() | Where { [int]$_ -gt 127 } | Group-Object`），逐个确认来源，不要只看"有没有乱码"。
- 相对路径对 .NET 无效：`[System.IO.File]::ReadAllText('renderer\x.js')` 会按**进程工作目录**解析，请用绝对路径。

## 2. 沙箱会静默拦截子进程

在会话沙箱里，外部程序启动可能**没有任何输出、退出码为 0**：

- `dsh ...`（其 bin shim 需要 spawn）→ 静默无输出；
- `pnpm add`（需要 spawn + 联网）→ 静默无输出，包**根本没装上**；
- `node ...` 的输出一旦进入**管道**（`node x.mjs | Select-Object`）→ `Access is denied`；直接运行（输出继承）正常。

**规则**：需要装包/联网/管道的命令，先按原样跑一次拿到真实拒绝，再用 `sandbox_permissions` 重试一次；不要因为"退出码 0"就认为成功——**看产物是否存在**。

## 3. 命名管道在本会话沙箱内不可用

沙箱禁止访问命名管道（`connect EPERM`）。因此：

- 桥接集成测试与 App 的无 GUI 自检必须提权运行；
- `packages/bridge/test/integration.test.mjs` 会**诚实 SKIP** 而不是假失败（探测到 `connect EPERM` 就跳过）。

## 4. 环境能力（已验证可用）

| 能力 | 用途 |
|---|---|
| `sharp`（从 harness 安装解析） | 抠图、变体对齐、渲染预览、截图裁切、图标生成 |
| `tools/preview-svg.mjs` | SVG → PNG，用于**自己看**渲染结果再迭代 |
| `tools/cutout.mjs` | 区域生长抠底 + 色度护栏 + 按体积去碎块 + 底部渐隐 |
| `tools/crop-image.mjs` | 截图裁切放大，用于审查 GUI |
| `System.Drawing` 截屏 | 验证 GUI 是否真的渲染（提权运行） |
| `Stop-Process -Id <pid>` | 定点停进程；**不要**按名字批量停（会误杀 harness 自身进程，已发生过一次） |

## 5. 离线相关

- 插件安装**不依赖 pnpm/registry**（`packages/bridge/scripts/install.ps1` 用 junction + 依赖项 + patch 行）。
- 但 App 的 Electron 安装**需要联网**（`pnpm add -D electron`），且 **pnpm 10 默认阻止 postinstall**，装完必须补一步：
  ```powershell
  node node_modules\electron\install.js
  ```
  否则 `dist/electron.exe` 不存在，`pnpm start` 无法启动。

## 6. 插件更新的生效时机（实测 —— 结论未定，勿当定论）

**别信"改 patch 就会热加载新代码"这种说法。** 目前的证据不足以下结论：

- 观察 1：把桥接 0.2.0 装进运行中的 profile，patch 块内容与原来**完全一致** → 端点文件仍是 `bridgeVersion=0.1.0`、`startedAt` 未变。
- 观察 2：随后删掉**另一个插件**的 patch 块，端点立刻变成 `bridgeVersion=0.2.0`、`startedAt` 更新，新 RPC 可用。
- **但事后核对进程发现**：那一刻 **dsh 本体整体重启了**（`dsh/lib/bin.js web` 的 pid 启动时间 14:17:37，端点写入 14:17:40，相差 3 秒），
  所以观察 2 完全可以由"重启"解释，**不能证明是 patch 变化触发了重新导入**。

**可靠的做法（不依赖机制推断）：**

1. 装完插件后**读端点文件核对**，而不是相信它已生效：
   ```powershell
   Get-Content "$env:DSH_HOME\digital-human\endpoints\<profile>.json"   # 看 bridgeVersion / startedAt
   ```
2. 要确保新代码生效，**直接重启 dsh**；
3. 若想验证"热加载是否可行"，必须**先记下 dsh 本体的 pid 与启动时间**（`Get-CimInstance Win32_Process -Filter "Name='node.exe'"`，
   过滤命令行含 `dsh/lib/bin.js` 的那一个），再看重启前后 pid 是否改变——否则会把重启误判成热加载。

**顺带一个排查教训**：`node.exe ... dsh-subprocesses` 这类进程是**执行命令的子进程运行器**，不是 dsh 本体。
本会话曾把它（pid 3080）误认为 dsh 本体，从而在核对时得出过错误的时间线。

## 7. 协议顺序：`ready` 必须先于任何 RPC（踩过的坑）

App 曾在收到 `welcome` 的同一 tick 里**先发 RPC、后发 `ready`**，桥接按契约拒绝（`expected a ready frame after welcome`）并关闭管道，
表现为 **250–500ms 一次的重连风暴**，日志只有一句 `could not read the model catalog: the bridge connection closed`。

根因是 App 的连接层：`setStatus('connected')` 写在 `sock.write(ready)` **之前**，而状态监听器会同步发起 RPC。
修法是**先写 `ready` 再广播状态**；桥接侧新增契约测试「首个 post-welcome 帧不是 ready 就必须断开」。

教训：**"把 RPC 延后一拍"能绕过症状，但那是掩盖；顺序错了就要修顺序。**

## 8. 其他环境事实

- **单实例锁**：App 已在运行时再启动一次，新进程会在 `whenReady` 之前直接退出，**连一行日志都没有**。排查"启动即退出、无输出"时先看是不是重复启动。
- **两个 harness 共用一个 `$DSH_HOME` 不能正常启动**：第二个进程会静默驻留，不输出、不挂载插件、不写端点。需要在独立 home 下验证（尚未查到确切机制，遇到时按此处理）。
- **不要按进程名批量 `Stop-Process`**：本会话已两次因此把自己所在的工具进程打死（`Get-Process -Name node/electron | Stop-Process`）。
  要停 App 就按可执行文件路径过滤（`$_.Path -like '*packages\app\node_modules\electron\dist*'`），或者只按精确 pid。
