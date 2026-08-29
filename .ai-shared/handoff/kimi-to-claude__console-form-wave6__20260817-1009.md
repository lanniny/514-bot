<!-- 514cc-session-id: 122f11cb-a2b3-4792-b0e4-ec0a1abb256a -->
# handoff：协作台控制台形态收敛层·第六轮（会话头单行 slim 标题栏）

## 需求

LO 供图（Codex 桌面顶栏红圈：图标+标题单行 + 下发丝分隔线）+ 本机实拍（标题两行、
meta pill 横贯顶栏），指令"关注红色标记的视觉处理，重点修改图中所示"。

## 落地清单

- `index.html`：标题前加 `conversation-title-glyph`（messages-square）——class-only 无 id，
  不进 elements 清单（第七波漏登坑的主动规避），契约断言钉住。
- `forge/console-form.css` 第六轮区块：heading-main 纵向→行向 flex；标题单行
  nowrap+ellipsis（覆盖 styles.css 存量 line-clamp:2）；chips 随行可裁剪到只剩 …；
  参与 CLI 行 flex-basis:100% 才换行；meta pill max-width 46%→30%；窄屏（≤900px）
  禁 wrap + 隐藏参与 CLI 行（flex-wrap 换行判定用未收缩的 base size，长标题必挤 chips）。
- `app.js` renderSelectedRun：meta pill 可见文本只留「本次步骤 X/Y」（maxSteps 缺失回落
  「总轮次 N」），run id 全码/创建时间/总轮次/交互序号/worktree 全路径收进 tooltip。
- **存量暗伤修复**：`--line` token 从未定义——console-form 前四轮 9 处 + styles.css 2 处
  `border: 1px solid var(--line)` 全部静默失效（var() 未定义 → 整条 border shorthand 无效，
  实机 borderBottomWidth=0px）。全量改 `var(--border)`，契约加全局负向断言。

## 验证证据

- 契约：`tests/conversation-heading-slim.test.mjs` 4/4；旧断言同步改写
  （codex-process-visibility / approval-runbuild-card，口径不变：总轮次+本次步骤都必须说清）。
- 实机：`.scratch/verify-wave6-heading.mjs`（隔离实例 51483 + 种 run）——flexDir=row、
  glyph 可见、标题 17px 单行、chips 同行（中心线判定，盒高差≠换行）、meta=「本次步骤 4/6」
  + tooltip 四段全、发丝线 1px、窄屏 600px 标题省略且 heading 42px；亮/暗/窄截图
  `.qa-ui-wave6/heading-{light,dark,narrow}.png`，无 pageerror。
- 全量 `npm test`：**1356 tests / 1355 pass / 0 fail / 1 skipped**。

## 遗留

- 源码改动需重启/刷新运行态 Control Center 生效（未动 LO 实例）。
- 会话头 chips 的项目/分支数据来自 `/api/workbench/environment`，探针种的无 cwd run
  只渲染 … 溢出钮；真实 run 的双 chip 形态与第二轮实拍一致（本轮未改其数据源）。

__DELTA__: Kimi(514cc-cli) | 1 | correctness | 证据：console-form.css 第六轮区块 + --line 暗伤修复 11 处、app.js meta 压缩、实机三态截图 + 全量 1355/1356 绿
