# 预算功能深度完善：unlimited 真无限（硬上限门槛已废）+ Composer 预算 pill UI

**作者**：烛（Claude 主驾自评） · 2026-08-30 04:06 GMT+8（04:4x 修订：按 LO 指示移除硬上限门槛）
**范围**：`apps/control-center/src/orchestrator.mjs`、`src/app.mjs`、`src/social-contract.mjs`、`src/adapters/claude-cli.mjs`、`schemas/control-center/contracts.schema.json`、`public/index.html`、`public/app.js`、`public/forge/console-form.css`、`public/forge/workbench.css`、`public/styles.css`、`tests/orchestrator.test.mjs`、`tests/social-contract.test.mjs`

---

## 一、语义定案（修订版）

LO 需求：预算可设"无限" + 深度完善 + UI 美化；**中期指示：不要再设置硬上限**——第一版"单轮无限需先把安全硬上限设为无限"的治理序被否，硬上限门槛整体拆除。

- wire/持久化哨兵 = 字符串 `"unlimited"`（JSON 存不了 Infinity；`null` 已被"取默认"语义占用）。
- **"无限"就是真无限**：单轮预算、席位默认二者任一设 `unlimited` → `resolveBudgetUsdPerTurn` 返回 `Infinity`，美元止损关闭；步数上限、上下文压缩预算、超时全部保留兜底。
- **安全硬上限（`limits.maxBudgetUsdPerTurn`）废弃**：resolve 不再读取与钳制、运行图校验（`app.mjs`）不再检查、席位默认面板 UI 删除该字段；schema 从 `required` 移除但保留属性 anyOf（number|"unlimited"）以容忍旧配置文件残留键；前端保存预算策略时顺手 `delete` 该键并在确认弹窗注明"移除"。
- 数字预算保留 `0.05..50` 防手滑天花板（前后端同值，composer 自定义输入 >50 拒绝并提示"不限额请选「无限」"）；低于 0.05 回 legacy 默认 0.75（既有行为不变）。
- social 协作仍显式拒绝无限预算（`SOCIAL_UNLIMITED_BUDGET_REJECTED`）：多 agent 往复成本不可失控，这是独立于硬上限的安全轨。
- adapter 透传：解析非有限 → `maxBudgetUsd: null`，claude-cli 省略 `--max-budget-usd` 旗标（不假装 `--max-budget-usd Infinity`）；orchestrator 结算层成本记账照跑。`budgetExhausted` 在 cap=Infinity 时恒假——自然关闭。

## 二、实现落点（证据）

| 层 | 落点 |
|---|---|
| 解析核心 | `orchestrator.mjs:35-71`：`UNLIMITED_BUDGET`、`isUnlimitedBudgetValue`、`BUDGET_NUMERIC_CEILING=50`、`resolveBudgetUsdPerTurn`（无硬上限；+Infinity 直通修复：`Number.isFinite` 守卫曾把无限默认误杀回 0.75） |
| 创建/热改 | `orchestrator.mjs` `#createOnce`（run 原样存哨兵；social 契约吃解析值）、`updateRunControls`（PATCH 接受哨兵/`∞` 别名归一，非法值仍 `VALIDATION_FAILED`） |
| 真源校验 | `app.mjs` 运行图：只校验 `defaultBudgetUsdPerTurn`（null \| "unlimited" \| 0.05..50）；`contracts.schema.json` limits 去掉 `maxBudgetUsdPerTurn` 必填、属性保留 anyOf |
| 止损 | `budgetExhausted` cap=Infinity 恒假；`markBudgetAttention` 非有限值显式落 null（不靠 JSON.stringify 静默变 null） |
| UI | `index.html` composer 预算控件 = pill+菜单（模型/Effort 同款交互）；席位默认面板只余"默认单轮预算"+∞ 切换；`app.js` 预算三态 helper（`""`=默认/数字/`"unlimited"`）+ `syncBudgetPickMenu`（∞ 行"真无限：不按美元止损（步数上限仍兜底）"、全局默认行、快捷档 0.25–10 全量展示、自定义金额编辑器 Enter/按钮均可） |
| 样式 | `console-form.css`（菜单 note/glyph/编辑器/∞ 高亮）、`workbench.css`（`.budget-field` 复合体 + `.budget-infinite-toggle`）、`styles.css` 清掉死掉的 `.budget-pick input` 规则 |

## 三、测试证据

- 新增：`tests/orchestrator.test.mjs` 2 条（新语义解析矩阵：无限→∞、数字 80→50、legacy 回退不变；fixture 全链路：哨兵落 run、adapter 收 null、热改 `1 → ∞ → unlimited` 往返、0.01 仍拒）；`tests/social-contract.test.mjs` 1 条（无限拒绝专用码 + 有限路径回归）。
- 回归：orchestrator+social-contract+adapters 三套 **197/198**，唯一失败 `known primary failure cost reaches the interaction cap before fallback dispatch` 已用 HEAD worktree 复跑确认**为存量红**（与本次改动无关，`.workbuddy/memory/2026-08-30.md` 已有台账）；app/bootstrap/runtime-reload/config 五套 **37/37**；composer/UI 契约五套 **40/40**。
- 真源兼容：`config/control-center/permissions.json` 实际不含任何预算键——schema 收窄零影响。
- 视觉：Playwright 静态 harness（真实 CSS + 菜单标记）截图核对（菜单展开/席位默认面板无硬上限字段布局），harness 已清理。

## 四、已知边界（如实）

- composer 菜单与模型/Effort 菜单同为 `left:0` 锚定，composer 极窄时可能溢出右缘——与既有 pill 菜单行为一致，未单独开刀。
- 预算耗尽提示条的"下一轮预算"仍是数字输入（该场景必然由有限预算触发，无需 ∞）。
- 数字预算的 50 天花板是防手滑护栏而非治理门槛；真要大额请用「无限」。
- 工作树里另有并行 agent 的 event-store 变更（F-048 哈希链，已单独提交）与本次无关，未触碰。
