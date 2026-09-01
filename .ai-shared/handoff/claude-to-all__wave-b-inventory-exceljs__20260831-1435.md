# Wave B 首批交付：innerHTML 高危路径清单（审计通过）+ exceljs 供应链决策记录

- 执行者：Claude（Verdent 运行时，AEMEATH 面）
- 时间：2026-08-31 14:25 ~ 14:35（绝对时间 UTC+8）
- 依据：LO 已批准《514cc 项目经理终审与分阶段完善计划（v45）》Wave B
- 说明：本会话无 route-gate 注入 session marker，按契约省略该行。

## 一、innerHTML 高危路径清单 — 审计结论：现存纪律成立，无需迁移

**方法**：脚本扫描 `public/app.js` 全部 innerHTML 赋值，按「动态插值 + 风险函数名（member/seat/approval/contact/run/team…）」两级过滤，逐站人工核验转义。原始数据：`.scratch/innerHTML-inventory-raw.json`（209 条）。

**结果**：

| 层级 | 数量 | 结论 |
|---|---|---|
| innerHTML 赋值总数 | 209 | 大多为纯静态模板/空串清理 |
| 含 `${}` 动态插值 | 35 | 逐条看 |
| 动态 + 风险函数名 | 7 | 全部核验通过（见下） |

**7 个风险站逐条核验（当轮源码证据）**：
- `app.js:19072` botRenderMemberRuntimeDetails：label 与 value 双 `escapeHtml` ✓
- `app.js:22752` renderTeamPulse：chips 构造于 22737-22742，全字段 `escapeHtml`，计数为数字 ✓
- `app.js:5802` runDriftCheck：错误文案经 `inlineEmpty()` → `placeholders.js:85` 内部 `escapeHtml` ✓
- `app.js:17726` botSetMemberAvatarNode：仅 status 类名拼接（受控枚举）✓
- `app.js:19421` botRenderMessageStore：文案 `escapeHtml` ✓
- `app.js:20161` renderBotRunQueue：插值为 `entries.length` 数字 ✓
- `app.js:21320` botAppendUserMessage：静态 "LO" + 空 bubble ✓

**结论**：`escapeHtml` 纪律在这 7 个高危站全部成立，**「优先迁移到模板 + sanitizer」的 P1 项可关闭**——没有发现未转义的用户数据插值点。后续治理继续靠 ui-lint 基线（新增动态 innerHTML 会被 lint 拦），不需要一次性大迁移。此前审计报告的「大量 innerHTML 渲染路径」风险经定量核验后降级：量大（209）但高危面小（7）且全数已防护。

## 二、exceljs 供应链决策记录（决策：保留 + 隔离，禁止 npm audit fix --force）

**使用面核实**：`exceljs@^4.4.0` 仅被 `src/office.mjs` 引用（`require("exceljs")`），2 处 `new ExcelJS.Workbook()`（office.mjs:142,226），经 `src/office/routes.mjs` 暴露为 xlsx 导出能力。前端零引用、无用户可控模板注入路径（数据来自 run 结算结构）。

**决策**：
1. **保留 exceljs，不替换**。替换（SheetJS/自写 zip+xlsx）的迁移成本 > 风险收益：使用面单一、输入非用户自由文本、出口为下载附件。
2. **中期加固（建议排入 Wave D 前的空档）**：把 xlsx 生成挪进 `worker_threads` 隔离——即使依赖爆出 RCE/崩溃类漏洞，也不在主服务进程里执行；worker 内可再套 `--disallow-code-generation-from-strings`。
3. **禁止 `npm audit fix --force`**（会跨大版本升级 exceljs，破坏既有 xlsx 契约）。
4. **审计证据边界（如实）**：本会话尝试 `npm audit --omit=dev` 复核最新漏洞面，**audit endpoint 返回错误（网络/代理问题），未获得新证据**；既有结论仍引用 2026-08-30 审计记录（transitive vulnerabilities 存在、无直接可利用路径）。下次网络可用时补跑并存档。

## 三、交接

- app.js 按视图抽取（Wave B 主项）未开始：需逐视图理依赖（state/elements/request/toast 注入面）+ 契约测试先行，建议单独立项会话执行，勿与其它改动混车。
- Wave A 结论见 `claude-to-all__wave-a-p0-closeout__20260831-1422.md`：P0-2 已收口，P0-1/P0-3 等待 LO 两个授权（token 轮换+推送、正式发布）。

__DELTA__: Claude(Verdent) | 1 | 证据：.scratch/innerHTML-inventory-raw.json 209 站全扫 + 7 个高危站逐条核验全转义（app.js:19072,22737-22752,5802 等）；exceljs 使用面钉死为 office.mjs:19,142,226 单点
