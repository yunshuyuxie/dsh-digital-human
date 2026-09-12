# 化身形象规格（云舒与偕 · Q 版全身）

## 交付形态

化身的形象质量由**角色渲染图**决定，动效由**矢量/变换层**决定。二者分工：

| 层 | 载体 | 负责 |
|---|---|---|
| 角色形象 | 7 张**对齐好的位图状态图**（`states-app/*.webp`） | 面部表情、服装细节、渲染质感 |
| 状态氛围 | CSS/SVG（光环、告警、汗滴、闪光、进度环） | 让"正在做什么"一眼可辨，且颜色随状态变化 |
| 微动作 | CSS 动画（呼吸、跳动、抖动、漂浮、眨眼不再需要） | 生命感 |

**为什么不用纯矢量**：曾按同一设计手绘 SVG 全身像，渲染结果不合格（刘海成黑斜块、挑染成大白带、手臂脱节）。矢量可作为特效层，但不是角色形象的正解。

## 状态 → 形象映射

| `data-face` | 状态图 | 触发 | 氛围层 |
|---|---|---|---|
| `offline` | `offline` | 未连接 / 未发现端点 | 灰调、光环熄灭 |
| `idle` | `idle` | 已连接、无运行中任务 | 青蓝光环呼吸 |
| `thinking` | `thinking` | 会话运行中、无活跃工具 | 蓝紫光环 + 省略号 |
| `working` | `working` | 有活跃工具调用或后台任务 | 青绿光环加速 + 进度环 |
| `waiting` | `waiting` | 有未决审批 | 琥珀告警脉冲 + 感叹号 + 轻跳 |
| `error` | `error` | 代理失败或任务失败 | 红色光环 + 汗滴 + 抖动 |
| `done` | `done` | 数秒内完成 | 绿色光环 + 闪光 + 腮红 |

优先级：`waiting > error > working > thinking > done > idle > offline`（状态机来自已下线的 Web 插件，原样复用）。

## 素材流水线

```powershell
# 1. 原图入库（同角色、同取景、只改表情的差分图）
packages\app\assets\avatar\source\{idle.png, done.jpg, error.jpg, offline.jpg, thinking.jpg, waiting.jpg, working.jpg}

# 2. 抠底：区域生长 + 色度护栏 + 按体积去碎块 + 补内部空洞 + 封边 + 定向清除水印 + 底部渐隐
node tools/cutout.mjs <src> packages\app\assets\avatar\cut\<state>.png `
  --tolerance 15 --protect-chroma 16 --min-component 620 --seal 1 `
  --feather 0.8 --trim --pad 8 --max 640 `
  --clear 488,581,152,59 --fade-bottom 16

# 3. 对齐 + 导出（基准取 cut\idle.png，保证 7 张画布与主体包围盒一致）
node tools/prepare-variants.mjs --reference packages\app\assets\avatar\cut\idle.png `
  --out packages\app\assets\avatar\states `
  --export-out packages\app\assets\avatar\states-app --export-width 420 `
  --sheet dist\states-sheet.png <cut\*.png>
```

对齐结果（每次运行都会打印，用于核对）：7 张的主体包围盒均为 **462×578**，落点 `(7~8, 8)`——差异 ≤1px，因此交叉淡入不会抖动。

## 抠图的三个坑（已解决，勿回退）

1. **纯容差填充会把发光云/光环/浮云一起抠掉**：它们比浅灰背景更亮，区域生长会"跨过"它们。
2. **只保留最大连通块会截掉举起的手臂**：手与身体仅通过发光云相连，抠掉光晕后它成为独立块——必须**按体积去碎块**而不是只留最大块。
3. **接地阴影与靴底连通**：用几何清除切下去会削平靴子，必须**按主体底部做透明度渐隐**（`--fade-bottom`）。

## 约束

- **透明背景**：RGBA，无底板/边框（PNG colour-type=6 已验证）。
- **同一画布**：7 张同为 478×594（`states/`）与 420×517（`states-app/`，2× 供约 210px 显示）。
- **体量**：`states-app/` 共 408 KB（WebP q92 + alpha）。
- **水印**：原图右下角"豆包AI生成"已按矩形清除，绝不进入产物。
- **可访问性**：状态由外层 `data-face` 表达，不依赖颜色单一通道。
- `packages/app/assets/avatar/avatar.svg` 是**被否决的矢量草稿**，仅保留其特效/光环图形供叠加层复用，不参与角色形象。
