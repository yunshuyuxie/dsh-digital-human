# 已下线（RETIRED）

这个 Web GUI 插件已完成使命，**已从 live profile 卸载**。

## 为什么下线

它的职责（监控任务状态 + 权限确认）由两类新产物承接：

| 原职责 | 现在由谁承担 |
|---|---|
| 数字人形象与状态 | `packages/app`（Electron 桌面浮窗，七态差分图交叉淡入） |
| 权限确认 | 同上（审批卡）+ `packages/bridge`（宿主侧桥接） |
| 任务/会话监控 | 同上（会话列表、活动流、模型选择） |

它作为**浏览器内插件**无法满足"装到别的电脑上、监控本机"的需求，而且它还把 `ui-approval` 关掉了（`disabled: true`），
让权限确认与形象强绑定。桌面 App 与桥接的组合既恢复了原生的权限面板，又提供了跨机器的安装形态。

## 状态机是资产，代码不是

七态优先级 `waiting > error > working > thinking > done > idle > offline` 已被 App **原样复用**（见 `packages/app/main/state.js`）。
其余 React 组件不再使用（App 是无框架的原生 DOM，形象改为位图状态图）。

## 卸载

```powershell
pwsh -File scripts/uninstall.ps1 -Profile web -PassThru
```

做的事：删依赖项、删 `node_modules` junction（只删链接，不动本目录）、删 `cordis.patch.yml` 里的托管块
（**连带移除 `ui-approval: disabled: true`**），并备份被改动的两个文件。**幂等**，重复执行是 no-op。

卸载后刷新 Web GUI 页面，内置的权限确认面板即恢复。

## 目录里还留着什么

- 本目录源码：保留作为设计参考与迁移记录（App 复用了它的状态机与中英文案）。
- `scripts/uninstall.ps1`：唯一还在用的脚本，可随时重跑确认清理干净。
