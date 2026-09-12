# dsh-digital-human

DeepSeek Harness 的**数字人**插件：一个常驻 Web GUI 的化身，负责**任务状态监控**与**权限确认**。

它长在 Web 客户端的全局浮层里（`shell.overlay`，右下角常驻），不占用会话输入区，也不需要改动 DSH 本体：

- **表情即状态**：空闲 / 思考中 / 执行中 / 待确认 / 出错 / 完成 六种表情，配呼吸、眨眼、旋转光环、抖动等动效。
- **气泡播报**：一句话说明当前在做什么（「正在执行 2 个后台任务」「有 1 项权限请求等你确认」）。
- **监控面板**：点化身展开——当前会话状态与错误、后台任务（种类/标签/状态/耗时）、并行运行的其他会话。
- **权限确认**：Host 转发上来的 `approval/request` 被数字人接住，直接在卡片上「允许一次 / 拒绝」，决定原路返回等待中的工具调用。
- **语音播报**（可选，默认关闭）：状态跃迁时用浏览器 `speechSynthesis` 念一句中文。

> 当前版本是**只读监控 + 人工决策**：数字人不会自作主张批准权限，也不会修改任何模型可见的提示词。

## 架构：它接在哪三条缝上

| 缝 | 用法 | 说明 |
|---|---|---|
| `shell.overlay` 插槽 | `ctx.slots.inject('shell.overlay', …)` | 布局包声明的 root 作用域 **list** 插槽，渲染在 `overlayLayer`，是唯一的全局浮层位置 |
| `ctx.sessions.list` | `getSnapshot()` / `subscribe()` | SnapshotStore，给出 `byId`（`running`/`lastAgentError`/标题）、`current`、`jobsBySession` |
| `ctx.remote.$on('approval/request')` | 返回 `allowed-once` 或 `rejected` | 与 `dsh-client-ui-approval` 同一条 waterfall；见下方「谁来做决定」 |

客户端 bundle 走 Web 客户端的模块系统：`lib/client.js` 以 `window.__ModuleLoader__.load({ id, factory })` 注册，只 `require` 平台种子模块（本插件仅用 `react`），自己的 8 个源文件由构建脚本内联进同一个 factory。

## 目录结构

```
dsh-digital-human/
├── package.json                    # dsh.client = { platform: "web" }
├── src/
│   ├── index.js                    # host 半边：空 apply（只为在 Cordis 树里占一行）
│   └── client/                     # 浏览器半边（8 个 CJS 源文件，构建时内联）
│       ├── plugin.js               # 入口：三条缝的接线
│       ├── store.js                # 状态投影：把会话镜像折成一份化身快照
│       ├── approval.js             # PendingApproval：持有一次权限请求
│       ├── overlay.js              # React 组件：气泡 / 面板 / 审批卡
│       ├── avatar.js               # SVG 表情
│       ├── styles.js               # 样式与动效
│       ├── locales.js              # zh / en 字典（键集一致）
│       └── runtime.js              # 组件与插件体之间的单例交接
├── lib/                            # 构建产物（client.js 为 loader bundle）
├── tools/
│   ├── build.mjs                   # 构建：内联 + 包装成 __ModuleLoader__ bundle
│   ├── smoke.mjs                   # Node 冒烟测试（36 项断言，含渲染树遍历）
│   ├── preflight.mjs               # 安装后校验 profile 接线（文件层面）
│   └── compose-check.mjs           # 用 dsh 自己的 composeEntries 复算组合树（组合层面）
├── scripts/
│   ├── install.ps1                 # link 安装 + 合并 patch（幂等）
│   └── merge-patch.ps1             # 只做 patch 合并（可 -DryRun）
└── profile/cordis.patch.yml        # 需要合并进 profile 的行（安装脚本会写）
```

## 当前验证状态

| 层面 | 怎么验的 | 结果 |
|---|---|---|
| bundle 结构 | `node tools/smoke.mjs`（`window.__ModuleLoader__` 影身 + react 桩 + 渲染树遍历） | 36/36 |
| 状态投影 | 冒烟测试覆盖六种表情、任务计数、并行会话、错误文本 | 通过 |
| 审批语义 | 冒烟测试覆盖 `allow()` / `reject()` / `delegate()` 三种回传 | 通过 |
| profile 接线 | `node tools/preflight.mjs` | 15/15 |
| 组合树 | `node tools/compose-check.mjs`（真实 `loadProfile` + `composeEntries`） | `ui-approval: disabled=true` |
| 浏览器渲染 | 用户刷新页面肉眼确认右下角化身 | 通过 |
| **权限确认端到端** | 本会话内发起真实沙箱升级请求 → 数字人卡片弹出 → 点「允许一次」→ 命令执行成功 | **通过** |

## 安装

```powershell
# 只做监控：权限确认仍由自带的 composer 审批面板负责
pwsh -File scripts/install.ps1 -Profile web

# 让数字人接管权限确认（会禁用自带 ui-approval 行）
pwsh -File scripts/install.ps1 -Profile web -OwnApprovals

# 把权限确认还给自带面板
pwsh -File scripts/install.ps1 -Profile web -NoOwnApprovals
```

两个开关是**三态**语义：都不传时保持 profile 里既有的选择，所以重复执行安装脚本
不会把「数字人接管审批」这个已做的决定悄悄回退。（曾经不是——见「故障排查」。）

安装脚本做两件幂等的事：

1. `dsh plugin --profile web add link:<本包>` —— 用 **link:**（junction）而不是拷贝，
   这样构建产物改动对运行中的 Web 进程立即可见；
2. 把带 `# >>> dsh-digital-human (managed) >>>` 标记的行块合并进
   `$DSH_HOME/profiles/web/cordis.patch.yml`，你自己的 patch 行原样保留。

然后**刷新一次浏览器页面**：客户端启动图需要重新组合才会带上这个插件，并且让
`ui-approval` 从图中消失。权限请求到达时监控面板会**自动弹出**并显示审批卡。

卸载：

```powershell
dsh plugin --profile web remove dsh-digital-human
# 再删掉 cordis.patch.yml 里标记块内的行（或直接删掉整块）
```

### 谁来做决定：为什么需要 `-OwnApprovals`

`approval/request` 是**瀑布式**事件：监听器按注册顺序执行，先回答的那个说了算，而
`dsh-client-ui-approval`（自带审批面板）注册得比本插件早，且会一直 await 到用户在 composer 上作答。
所以只要它还在，数字人的监听器就永远轮不到 —— 这也是 `-OwnApprovals` 会把它 `disabled: true` 的原因。

不装 `-OwnApprovals` 时，数字人只是**少一个审批卡**，其余监控功能完全正常，不会有副作用。

## 开发循环

```powershell
node tools/build.mjs         # 重新生成 lib/client.js（经 junction 直接落到 profile 里）
node tools/smoke.mjs         # 36 项断言：投影 / 审批流 / 渲染树
node tools/preflight.mjs     # 文件层面：link、两个入口、patch 标记块
node tools/compose-check.mjs # 组合层面：用 dsh 的 loadProfile + composeEntries 复算
```

`client-hmr` 行在 web profile 里是**常驻挂载**的：它轮询每个客户端 bundle 的 revision，
一旦 `lib/client.js` 变了就原地热替换该插件。因此改完源文件跑一次 `build.mjs` 即可在浏览器里看到变化，
**不需要刷新页面**（只有首次把插件组合进启动图、或改动插件清单/patch 行时才需要刷新一次；
热替换会丢失插件内 React 状态，会话状态不受影响）。

`compose-check.mjs` 是最有价值的一道自检：`preflight` 只能证明文件写对了，
它才能证明 patch 行真的**参与组合**（`ui-approval: disabled=true`）。改任何 patch 行后都应先跑它，
再去打扰浏览器。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 刷新后右下角没有化身 | 跑 `node tools/preflight.mjs`；再跑 `node tools/compose-check.mjs` 看 `digital-human` 是否在组合树里。不在 → patch 行没生效。 |
| 启用了 `-OwnApprovals`，审批仍弹在 composer 面板 | 先跑 `compose-check` 确认 `ui-approval: disabled=true`；确认后**刷新页面**（客户端启动图只在页面加载时重组）。两项都做了还在 → 重启 `dsh web` 让 host 侧重跑一次 patch 应用链。 |
| 审批卡出现了但按钮点了没反应 | 卡片按钮走的是 `pending.result`，只在请求仍活着时才结算；请求被取消（工具已超时/中断）后按不动是预期行为。 |
| 权限请求没人应答、工具直接失败关闭 | 说明 `next()` 一路委托到了尽头（无应答者 → `unavailable`）。通常是把 `ui-approval` 禁用了、但数字人插件没挂上——先确认化身在。 |

**踩过的坑（已修）**：早期 `merge-patch.ps1` 只要不带 `-OwnApprovals` 就会把 `ui-approval`
禁用行删掉。一次「顺手重写 patch」的端到端测试因此把审批接管悄悄回退了，
表现为「组合树里 `ui-approval` 没有 `disabled`」。现在开关是三态的，重跑不再改变既有选择。

## 已知限制

- **不自动批准**：数字人是人工决策界面。要「数字人替你把关」（规则或 LLM 判定自动应答）需要加 host 侧应答者，
  属于下一阶段——host 答案者比客户端更快、且天然早于任何浏览器监听器。
- **审批卡只显示工具名与原因**：Host 的请求事件本身不携带工具参数（这是审批 seam 的既定设计），
  所以卡片无法展示完整命令。需要细节时请配合 composer 面板或会话轨迹。
- **只认识会话级状态**：表情来自会话镜像与后台任务，不含更细的「正在调用哪个工具」。
- **`shell.overlay` 层级**：浮层用 `position: fixed`，若将来外壳给祖先元素加了 `transform`，定位会相对该祖先偏移。

## 回滚

1. `dsh plugin --profile web remove dsh-digital-human`；
2. 删除 `cordis.patch.yml` 中标记块之间的行（`merge-patch.ps1` 重跑时会自动替换自己的块）；
3. 刷新页面。

删除后不会留下任何状态：插件不写 `localStorage`（只有语音开关一项），不注册 host 服务，不改模型上下文。
