# dsh-digital-human · 数字人

一个**桌面数字人浮窗**，用于监控本机 [DeepSeek Harness](https://github.com/deepseek-ai) 的任务运行状态、
确认权限请求，以及下发/取消任务。

它由三部分组成，各自可独立使用：

| 部分 | 目录 | 作用 |
|---|---|---|
| **协议包** | `packages/protocol` | 零依赖 ESM：帧编解码、校验、方法名常量 |
| **桥接插件** | `packages/bridge` | 装在 dsh 内部，把会话/活动/审批经**本机命名管道**暴露出来 |
| **桌面应用** | `packages/app` | Electron 双窗口：化身胸章 + 功能面板 |

## 设计要点

- **只监控本机**：App 与桥接通过本机命名管道（Windows `\\.\pipe\…`）通信，**不开任何 TCP 端口、不联网**。
- **权限确认是核心**：待确认的权限请求会以审批卡呈现（工具名、原因、参数、倒计时），并弹系统通知。
- **化身即状态**：七态差分图（离线/空闲/思考/执行/待确认/出错/完成）交叉淡入，优先级
  `waiting > error > working > thinking > done > idle > offline`。
- **可离线安装**：桥接插件用离线包安装，不依赖 npm registry。

## 快速开始

### 1. 安装桥接插件（在装有 dsh 的机器上）

从 Releases 下载 `dsh-digital-human-bridge-<ver>.zip`，解压后：

```powershell
pwsh -File install.ps1 -Profile web
```

安装脚本做的事：把包链接进 profile 的 `node_modules`、写依赖项、在 `cordis.patch.yml` 里插入托管行块（含备份）。

> **升级插件后请重启 dsh**，再读 `$DSH_HOME/digital-human/endpoints/<profile>.json` 的 `bridgeVersion` / `startedAt` 确认真的换了代码。
> 详见 [`docs/dev-notes.md`](docs/dev-notes.md) 第 6 节（含一次把"重启"误判为"热加载"的教训）。

### 2. 安装桌面应用

从 Releases 下载 `dsh-digital-human-<ver>-setup.exe`（安装向导）或 `-portable.exe`（免安装）。
首次启动会进入向导：体检本机环境、必要时从离线包安装桥接、设置偏好。

## 从源码构建

```powershell
# 应用（需要联网装 Electron；pnpm 10 默认阻止 postinstall，需补一步）
cd packages/app
pnpm install
node node_modules\electron\install.js
pnpm start          # 开发运行
pnpm run dist       # 产出 NSIS 安装包 + portable
```

自检工具（无需 GUI）：

```powershell
node tools/headless-check.mjs --profile web   # 真桥接：发现→握手→基线→订阅→派生状态
node tools/cross-check-handshake.mjs          # App 与桥接的握手实现是否仍一致
node tools/cold-start-check.mjs --profile <p> # 冷启动：从离线包安装桥接的全路径
```

## 仓库结构

```
packages/protocol/   协议（零依赖）
packages/bridge/     桥接插件 + 离线安装脚本 + 测试
packages/app/        Electron 应用（主进程 / preload / 渲染层 / 素材）
tools/               素材流水线（抠图、对齐、预览）、协议内联同步
docs/                设计文档、化身规格、开发环境注意事项、UI 调整计划
dsh-digital-human/   已下线的 Web 插件（保留状态机与文案的出处）
```

## 素材流水线

七态差分图由生成器产出后，经**抠底 → 轮廓对齐 → 导出**三步处理：

```powershell
node tools/cutout.mjs <源图> <输出.png> --tolerance 15 --protect-chroma 16 --min-component 620 --seal 1 --feather 0.8 --trim --pad 8 --max 640 --clear <水印矩形> --fade-bottom 16
node tools/prepare-variants.mjs --reference <基准.png> --out <目录> --export-out <WebP目录> --export-width 420 <各状态图>
```

细节（含三个踩过的坑：色度护栏、按体积去碎块、按主体底部渐隐）见 [`docs/avatar-spec.md`](docs/avatar-spec.md)。

## 安全

- App 不监听端口、不发起网络请求；渲染层 `contextIsolation: true` + `sandbox: true`，无远程资源、CSP 限定 `default-src 'none'`。
- 令牌来自 `$DSH_HOME/digital-human/secrets.json`，且**双向校验**：客户端须证明自己持有令牌，服务器也必须回证（防管道抢注）。
- 每次权限请求与决定都追加到 `$DSH_HOME/digital-human/audit.jsonl`。
- **真正的边界是操作系统用户账户**：令牌、互证 HMAC 与管道 ACL 都是纵深防御，不是账户隔离的替代。

## 许可

MIT
