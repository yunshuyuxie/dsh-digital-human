# dsh-digital-human-app

数字人桌面浮窗：监控**本机** DSH 的任务运行状态、确认权限、下发与取消任务。

- 数据通道是**本机 IPC**（命名管道），App 自身**不开任何网络端口**；
- 只与装了 `dsh-digital-human-bridge` 插件的本机 DSH 通信；
- 零运行时依赖（Electron 之外），渲染层是原生 DOM，无打包器。

## 前置

1. 本机已装 dsh，并且**桥接插件已安装**：
   ```powershell
   pwsh -File ..\bridge\scripts\install.ps1 -Profile web
   ```
2. 本目录已装 Electron：
   ```powershell
   pnpm install
   # 若 pnpm 阻止了 postinstall，二进制不会被下载，需要补一步：
   node node_modules\electron\install.js
   ```

## 运行

```powershell
pnpm start          # 等价于 electron .
```

窗口形态：360×560 无边框透明置顶窗，默认落在主屏右下角；关闭按钮只会隐藏，退出请用托盘菜单。

## 自检工具（无需 GUI）

```powershell
node tools/headless-check.mjs --profile web --seconds 9   # 真桥接：发现→握手→基线→订阅→派生状态
node tools/cross-check-handshake.mjs                      # App 与桥接的握手实现是否仍然一致
node tools/make-icons.mjs                                 # 从化身素材重新生成 tray.png / icon.png
```

`headless-check` 退出码：`0` 成功、`1` 无基线、`2` 没找到端点（dsh 未运行或插件未安装）。

## 目录

```
main/       主进程：endpoint 发现 / connection 协议客户端 / state 投影 / config / tray / index
preload/    contextBridge 白名单 API（.cjs，因为 sandbox 下 preload 必须是 CommonJS）
renderer/   原生 DOM 界面：化身交叉淡入 / 面板 / 审批卡
assets/     icon.png、tray.png、avatar/（source → states → states-app 三级素材）
src/vendor/ 内联的协议副本（tools/sync-protocol.mjs 生成，勿手改）
tools/      headless-check / cross-check-handshake / make-icons
```

## 化身状态映射

| `face` | 触发 |
|---|---|
| `offline` | 未连接 / 未发现端点 |
| `waiting` | 有未决审批（最高优先级） |
| `error` | 代理失败或后台任务失败 |
| `working` | 有活跃工具调用或运行中的后台任务 |
| `thinking` | 有会话在跑，但无活跃工具/任务 |
| `done` | 数秒内完成 |
| `idle` | 已连接、无运行中任务 |

优先级 `waiting > error > working > thinking > done > idle > offline`，与已下线的 Web 插件一致（状态机复用）。
素材流水线见 [`docs/avatar-spec.md`](../../docs/avatar-spec.md)。

## 首次运行向导

首次启动（配置里 `onboarded` 不为 true）直接进入向导，四步：

1. **环境检查** —— 现场诊断，不依赖桥接连接（首次运行时它本来就是断的）：dsh 目录、配置档案列表、桥接是否已装、harness 是否在运行及桥接版本；
   桥接已装但版本偏旧时会明确说明"新功能要等桥接更新后才出现"；`重新检查` 可重跑。
2. **安装桥接** —— 仅在缺桥接时出现（已装则折叠为一行绿色"已安装"，步骤指示器里也跳过）：
   选择离线包（`.zip` 或已解压目录）→ 选配置档案 → 安装，安装脚本输出**逐行实时**显示在可滚动区域。
3. **偏好** —— 开机自动启动 / 窗口始终置顶 / 权限请求时通知（从当前配置预填）。
4. **完成** —— 概要 + `开始使用`，写入配置并标记 `onboarded`，随后重连并切回正常面板。

安装逻辑在 `main/onboarding.js`：`diagnose()` 只读地体检，`installBridge()` 负责解压（`.zip` 时用 PowerShell `Expand-Archive` 到临时目录）、
定位 `install.ps1`、以 `DSH_HOME` 为环境变量执行，并在**结束后校验** profile 里真的出现了桥接链接——脚本"假成功"不算成功。

## 打包

```powershell
pnpm add -D electron-builder          # 首次
node node_modules\electron\install.js # 若 pnpm 阻止了 electron 的 postinstall
pnpm run dist                          # 产出 NSIS 安装包 + portable 免安装版
```

产物落在 `dist/app/`：

| 文件 | 说明 |
|---|---|
| `dsh-digital-human-<ver>-setup.exe` | NSIS 安装向导（可选安装目录、桌面/开始菜单快捷方式、含卸载器） |
| `dsh-digital-human-<ver>-portable.exe` | 免安装单文件版 |
| `win-unpacked/数字人.exe` | 未打包目录，便于调试 |

**打包内容**由 `electron-builder.yml` 的 `files` 白名单严格控制：`main/`、`preload/`、`renderer/`、`src/vendor/`、
两个图标，以及 `assets/avatar/states-app/*.webp`。

素材流水线的**中间产物不进安装包**：`assets/avatar/source/`（生成器原图 ~5MB）与 `assets/avatar/states/`（无损 PNG ~2.5MB）
都被排除，因此 `app.asar` 只有 **0.68 MB**（含 408KB 的 WebP 状态图）；两个 exe 各约 107MB，主要是 Electron 运行时。

## 当前范围（M3）

- 单窗口：化身在面板顶部，面板内含状态行、会话列表、活动流、输入框、审批卡。
- 审批卡是核心：显示工具名、原因、参数与倒计时，提供「允许一次 / 拒绝」。
- **子会话折叠**：`parentId` 非空的会话属于 subagent，默认折叠；有子会话时列表头出现「子会话 N」开关。
- **模型选择**：按会话选模型（`sessions.models` 目录 + `command.selectModel`），当前模型来自 `modelSelection` 投影。
- **新建 / 重命名会话**：新建会弹出原生目录选择器再创建并自动跟随；重命名使用原生输入框。
- **权限通知**：新的权限请求到达时弹 Windows 通知（点击通知显示浮窗），可在托盘关闭。
- **开机自启**：托盘菜单可开关；每次启动都会核对登录项，因此换目录后会自动修正注册。
- **托盘菜单**：显示/隐藏浮窗、重新连接、始终置顶、权限请求时通知、开机自动启动、退出。
- **断连提示本地化**：主进程上报 `{ code, params }`，由渲染层翻译；截断时悬停看全（`title`）。
- 尚未包含：NSIS 安装包（M4）、多主机/多 profile 切换、语音。

### 桥接版本与 App 版本可以不同

**升级桥接后读端点文件核对，不要假设它会热生效。** 实测：重装 0.2.0（patch 内容与原来一致）后端点仍报 `0.1.0`；
之后端点变成 `0.2.0`，但事后核对进程发现那一刻 **dsh 本体整体重启了**——所以"改 patch 就能热加载"的说法**没有证据支持**，详见 `docs/dev-notes.md` 第 6 节。

**可靠做法**：升级插件后**重启 dsh**，再读 `$DSH_HOME/digital-human/endpoints/<profile>.json` 的 `bridgeVersion`/`startedAt` 确认。

App 为此**按能力降级**而不是报错：

| 情况 | App 行为 |
|---|---|
| 桥接没有 `sessions.models` | `modelsSupported: false`，模型选择处显示「桥接插件版本较旧，重启 dsh 后可选模型」 |
| 镜像里没有 `parentId` | 所有会话都当根会话显示（不折叠、不隐藏） |
| 镜像里没有 `model` | 模型显示为「未设置」 |

自检可确认当前处于哪种状态（下面第二行是运行中桥接已支持新 RPC 时的输出）：

```powershell
node tools/headless-check.mjs --profile web --seconds 5
# check: bridge=0.2.0 ... subagent children in the list: 4
# check: model catalog supported — 6 model(s) in 2 provider group(s)
```

### 配置文件

`%APPDATA%/dsh-digital-human/config.json`

```jsonc
{
  "version": 1,
  "dshHome": null,            // 覆盖 $DSH_HOME，用于非默认安装位置
  "activeProfile": null,      // 指定 profile；null = 取最新发布的端点
  "alwaysOnTop": true,
  "startWithWindows": false,
  "notifyOnApproval": true,
  "notifySound": true,
  "window": { "x": 0, "y": 0 } // 拖动后自动保存
}
```

### 诊断

主进程把渲染层控制台、加载失败、渲染进程崩溃、未捕获异常、未处理拒绝、退出码全部写到 stderr——
浮窗没有标题栏，出问题时这行日志是唯一的线索（曾经出现过一次静默退出，当时没有任何痕迹可查）。

## 安全

- 渲染层 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，只能通过 preload 暴露的固定方法操作；
- 不加载任何远程内容，无 webfont、无 CDN，CSP 限定 `default-src 'none'`；
- 令牌来自 `$DSH_HOME/digital-human/secrets.json`，并且**双向校验**：客户端证明自己持有 token，服务器也必须回证（防管道抢注）。
