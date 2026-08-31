# 人文风换血 + 侧栏主流 GUI 化（Kimi → all）

> 时间：2026-07-26 · 主驾：Kimi · 范围：apps/control-center 前端视觉层（tokens/bridge/shell）
> 触发：LO 走查桌面端后两条定性反馈——①不要玫瑰红，要 Claude 人文风格 ②左侧侧栏不紧凑、不像主流 GUI

## 一、改动清单

### 1. Palette 换血（`public/forge/tokens.css` 亮暗双主题）

- primary：玫瑰 #b4234d → **Claude 铜橙 #D97757**（oklch(0.672 0.131 38.7)，与既有 --agent-claude 同值；暗态 oklch(0.72 0.12 40)）。
- 亮色：底 #faf9f5 暖米白 / 字 #2a2620 深棕 / 卡 oklch(0.995) / border 暖灰棕。
- 暗色：底 #1e1c17 暖棕黑 / 字 oklch(0.93 0.008 85) 暖白（弃冷灰蓝黑）。
- 语义色（success/warning/danger/info）与 agent 品牌色不动——身份色不是 UI 主色。

### 2. Legacy bridge（tokens.css 末尾新增段）

- styles.css 一万行零改动：tokens.css 后加载，`:root` / `[data-theme="dark"]` 同特覆盖旧变量族。
- `--rose` 族变量名保留、值换铜橙（--rose/#d97757、--rose-bright/#e8916f、--rose-deep/#b85c3e、rgba 族同步）。
- **`--statusbar` 玫瑰红底 → 深棕墨底**（亮 #2a2620 / 暗 #14120e）。
- `--bg/--void/--surface*/--text*` 族换暖米白/暖棕黑。

### 3. 侧栏主流 GUI 化（`public/forge/shell.css` nav 段重写）

- **弃全圆药丸**：border-radius 999px → var(--radius-md, 8px) 方圆角——这是"不像一般 GUI"的核心症结。
- 紧凑：行高 34→30px、nav padding 8→6、组距 16→12、gap 2→1、图标 16→15px。
- hover：primary 8% → 中性 muted-foreground 9%（Claude 式克制）。
- 选中态：浅铜底（primary 12%）+ 深棕字（--foreground）+ 图标点铜（--primary），弃玫瑰字。

### 4. 顺手收口

- `hero-starmap.js` primary fallback #b4234d → #d97757（死值，仅为正确性）。
- `forge/highlight.css` 暗态 `--hljs-keyword` hue 10.3（玫瑰向）→ oklch(0.74 0.12 40) 铜族。
- `forge/README.md` tokens 文档口径同步（"514 rose" → "Claude humanist copper"）。

## 二、验证

- `npm test` 480 pass / 0 fail / 1 skipped（481 总）。
- `npm run validate` valid（12/12）。
- Playwright 21 站全量 + 协作星图补拍 2 站（脚本未覆盖 `#/hero`），明暗双主题亲眼走查：亮态暖米白+铜橙点缀、暗态暖棕黑、状态栏深棕墨、星图中心核与巨字描边均为铜、明态暖白终端与整体协调、暗态选中态对比可读；控制台 0 错误。
- 残留硬编码玫瑰 hex 全仓扫描：styles.css 原始定义（被 bridge 覆盖）与 forge/*.css 的 var() fallback 死值，均不参与渲染，已确认无害。

## 三、注意

- 桌面端无需重启：CSS/JS 为静态资产，窗口内刷新即生效。
- 冒烟实例 :5520 已回收。

__DELTA__: Kimi（前） | 1 | security | 证据：forge/tokens.css:149-220 bridge 段 + forge/shell.css nav 段重写，23 站截图亲查 0 控制台错误
