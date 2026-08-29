---
topic: no-route-observability
date: 2026-08-19 15:13
author: 烛（ZCode 运行时，AEMEATH Codex 面）
scope: apps/control-center（路由错误可观测性）
status: 已实现并测试通过，未提交
session: zcode 会话（无 route-gate marker 注入，未凭空补造 session id）
---

# NO_ROUTE 可观测性补强（current-research 60 连发复盘修复）

## 背景

2026-08-19 06:36:22–06:37:00，控制中心账本连续落了 60 条 `server.error NO_ROUTE "no healthy provider can satisfy current-research"`（58 个独立 requestId）。复盘结论：

- 触发链：`classifyTask` 命中实时关键词或「实时来源」开关 → `current-grok` 规则硬约束 `allowedProviders: ["grok-search"]` → 其余席位全部结构性排除，唯一候选 grok-search 健康不可用 → fail-closed 抛错。
- grok-search 三凭据（`GROK_SEARCH_RS_COMPAT_*`）为 Windows 用户级环境变量，服务进程必然继承，故当时故障在「宿主已启动后清单探针失败（offline）」档而非「缺凭据（unconfigured）」档；健康缓存 TTL 30s，故障横跨多个探测周期。
- 当时真正的缺口：错误文案不带原因、账本 `server.error` 只落 message 不落 `error.candidates`，事后无法回答「每个席位被什么卡住」。

## 变更

1. `apps/control-center/src/router.mjs`
   - 新增 `routeBlockers()`：过滤结构性排除（特殊路由/白名单/显式指定/同供应商复核）后，把真正的健康/禁用原因拼进错误文案，上限 3 席位。
   - `NO_ROUTE` 与 `NO_INDEPENDENT_ROUTE` 文案从裸句变为 `... (grok-search: missing credential references: ...)` 形态。fail-closed 语义、路由策略、评分均未动。
2. `apps/control-center/server.mjs`（server.error 落盘处）
   - `error.candidates` 存在时，以 `{id, excluded, reasons}` 紧凑形态写入 `server.error` 事件；HTTP 响应此前已带 candidates（server.mjs:2658），本次只补账本侧。
3. 测试
   - `tests/router.test.mjs`：两个 fail-closed 用例加断言——文案必须含具体席位与原因。
   - `tests/no-route-ledger-http.test.mjs`（新增）：隔离仓 + 置空三凭据钉死 unconfigured 档，断言 422 响应文案、`payload.error.candidates`、账本 `events.jsonl` 中 `server.error.data.candidates` 三处齐全。

## 验证

- `node --test tests/router.test.mjs`：20/20 pass。
- `node --test tests/no-route-ledger-http.test.mjs`：1/1 pass（1.6s，含真实 server 拉起）。
- 回归：`tests/orchestrator.test.mjs tests/grok-image-routing-http.test.mjs tests/automations.test.mjs tests/team-members-http.test.mjs tests/api-request-body.test.mjs`：124/124 pass。
- 全仓 grep 确认无别处断言旧裸文案。

## 边界与未做

- **未改路由策略**：`current-grok` 硬约束与 `requireHealthyProvider` 是 LO 的 fail-closed 设计，保持原样；如需显式降级开关属策略变更，须 LO 拍板。
- 未追查 06:36 当时 grok-search offline 的深层宿主故障（需正式实例运行态才能复现）；本次修复保证下次发生时原因直接可见。
- 变更未提交；工作区还有本轮之前的未提交改动，未触碰。
- 前端无需改：`applyFailedRoutePreview` 已渲染 candidates，toast 直接展示更详细的 error.message。

__DELTA__: 烛(Codex) | 1 | observability | 证据：apps/control-center/src/router.mjs routeBlockers() 把排除原因带入 NO_ROUTE/NO_INDEPENDENT_ROUTE 文案；server.mjs server.error 事件补落 candidates 明细；tests/no-route-ledger-http.test.mjs 三处断言全过（20+1+124 pass）
