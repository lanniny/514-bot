# Wave A（P0 清零）执行报告：P0-1 边界交付 + P0-2 收口 + P0-3 闭路路径核实

- 执行者：Claude（Verdent 运行时，AEMEATH 面）
- 时间：2026-08-31 14:00 ~ 14:30（绝对时间 UTC+8）
- 依据：LO 已批准《514cc 项目经理终审与分阶段完善计划（v45）》Wave A
- 说明：本会话无 route-gate 注入 session marker，按契约省略该行。

## 一、P0-1 泄漏 token 轮换 — 边界如实交付（轮换本体待 LO）

**核实（当轮磁盘/配置证据）**：
- `git config core.hooksPath` = `.githooks` → 提交闸门在本机处于启用状态。
- `node scripts/secret-audit.mjs --scope=tracked` → **1024 文件、命中 0**，报告「干净」。
- `.ai-shared/context.md:170-175` 仍如实记录：`lanniny/514-bot` 为公开仓库，CC-Switch 代理 token（`tEP1_` 前缀）自 2026-08-13 起暴露于远端历史，清理提交 `1876bf9` **尚未推送**。

**边界**：token 轮换 = 凭据操作（安全红线），history 重写 + force push = 不可逆危险操作。二者按红线必须 LO 明确授权后执行，本轮不代做、不猜测执行。

**LO 可执行 runbook（按序，全程约 10 分钟）**：
1. **轮换（先做，约 2 分钟）**：打开 CC-Switch 本地代理设置 → 重新生成 proxy token（旧 `tEP1_…` 即作废）→ 本地 `ccswitch-proxy.json` 会随之更新。轮换后远端历史里的旧 token 变成无害死串。
2. **推送清理提交（约 1 分钟）**：`git push origin main`（推 `1876bf9` 及后续，停止扩散）。
3. **历史重写（可选、独立决策，约 5 分钟 + 强推）**：`git filter-repo --path .ai-shared/control-center-preview/data/ccswitch-proxy.json --invert-paths` → `git push --force origin main`。**注意：强推会改写全部协作者的历史，若仓库无其他协作者才建议做**；不轮换只重写是无效防护。
4. **收尾核验**：`node scripts/secret-audit.mjs --scope=tracked`（应仍为 0 命中）+ 远端 `git show origin/main:<旧路径>` 应报不存在。
5. 在 decisions.md 登记轮换完成时间与旧 token 失效证据。

## 二、P0-2 失败/恢复信息层级 — 复核确认主体已落地，本轮补最后一块

**复核结论（源码 + 测试双证）**：计划里 P0-2 的主体（原始错误折叠、失败分类、恢复确认闸门、错误卡并入恢复条）**已在 Wave 2/3 落地**，本轮逐项核实：
- `public/modules/failure-presentation.js`：7 类失败分类（origin-timeout / provider-error / budget-exhausted / content-block-error / recovery-blocked / long-error / error），`tests/failure-presentation.test.mjs` **5/5 通过**。
- `public/app.js:23219` `failureReasonMarkup`：技术详情默认收进 `<details>` 折叠区，对话流不再直排原文。
- `public/app.js:23149-23161` 恢复条：原因（分类后）+ 恢复提示 + 确认按钮合在单一组件，Bot 与 Workbench 共用。
- `public/app.js:24759-24781` `agent.turn_failed`：事件文案走 `failurePresentation`，超长原文只进 `errorDetail` 折叠通道。

**本轮增量（app.js:23153）**：恢复条原来没有明确回答「工作是否还在跑/已做的会不会丢」。未确认态文案改为：
「本轮已停止、不会重复执行；已产生的部分产出与证据均已保留。」
至此恢复条完整回答三问：发生了什么（分类原因）/ 是否还在跑（已停止+证据保留）/ 需要做什么（恢复提示+确认按钮）。

**验证**：`node --test tests/bot-shell-ui.test.mjs tests/failure-presentation.test.mjs tests/ui-lint.test.mjs` → **50/50 通过**。旧文案「自动重放已阻止」无任何测试断言依赖（仅 `agent.turn_checkpoint` 注记使用，语义不同，未动）。

## 三、P0-3 formal release — 闭路路径核实到位，闸门卡在「提交授权」

**核实**：
- `npm run qa:delivery` → cut `v42-r0`、`formalRelease: no`、status **drift**、strict fail。
- drift 根因：**13 个未跟踪新文件**（Wave 2/3 产物：density.css、placeholders.css、async-action.js、placeholders.js、ui-audit-report/lint/tokens/baseline、static-assets.mjs 及 4 个配套测试）——全部为 `??` 未跟踪状态，非归属规则缺口（glob 规则本就覆盖它们）。
- 这 13 个文件配套测试当轮全部复跑：`async-action` + `static-assets` + `ui-design-system`（**28/28**）+ `ui-lint`（并入上面 50 项）→ **提交即达标**。

**闭路路径（按 release-record.mjs:311-344 的闸门语义）**：
1. Wave A/B 改动一并提交（**待 LO 授权 commit**）→ drift 清零；
2. `npm run qa:delivery` 确认 status 干净；
3. 启动服务实例做 release-truth 对账（sourceCommit + diffDigest + consistency=consistent）；
4. `formalRelease` 置 true 属发布授权决策，**待 LO 拍板**（闸门文案原文：「工程门已齐，正式发布仍未授权」）。

## 四、交接给下一波次

- Wave B（app.js 按视图抽取 / innerHTML 清单 / exceljs 决策）未开始，可直接接手。
- P0-1 与 P0-3 的剩余步骤都只在等 LO 两个授权：**轮换+推送授权**、**正式发布授权**。
- 本轮改动仅 1 处（app.js:23153 文案），无新增文件，无删除。

__DELTA__: Claude(Verdent) | 1 | 证据：apps/control-center/public/app.js:23153 恢复条补齐「工作已停止+证据保留」应答；public/app.js 复核确认失败分类/折叠/恢复条主体已落地，tests 50/50 + 28/28 双证
