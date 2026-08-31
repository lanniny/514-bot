<!-- 514cc-session-id: 019f8514-65ba-7082-a21f-e60d6eccf620 -->
# Control Center 卡顿治理终审交接

## 致命问题

- 当前磁盘终审未发现剩余 P0/P1。此前已关闭的关键问题包括：无界会话 DOM、超大正文同步处理、后台页 timer 节流、历史解析/缓存缺少预算、乱序事件重建全量会话索引，以及 data-first 事件耗尽 UI 投影预算后丢失协议身份。
- `apps/control-center/src/event-view.mjs:26` 固定优先投影顶层协议字段；`apps/control-center/public/app.js:6629` 对乱序事件只增量维护必要索引，不再全量重建。

## 建议改进

- 性能阈值属于保护边界而非吞吐基准；未来若调整 160 条 DOM、5000 事件或 16 MiB 历史预算，必须同步更新内存模型、Playwright 反例和大载荷测试，不能只放大常量。
- 早期同条件 QA 曾出现一次 58 ms long task，随后原样复跑及本轮最终 `--suite=all` 均为 0。保留该抖动事实，后续可在低功耗或资源竞争环境补 P95/P99 长任务采样。

## 可保留

- `apps/control-center/public/app.js:3895` 的让步顺序为 `scheduler.yield()` → `MessageChannel` → timer；批量挂载恢复后重新检查 generation、ownership 与 render context。
- 事件面受 160 条/40 MiB 双预算约束；会话 DOM 以 160 条窗口分页；历史以 5000 条/16 MiB 约束并增量读取 NDJSON；超大正文仅呈现有界元数据。
- 最终浏览器 QA：`ok: true`；5000 事件场景 DOM 最大 160、阅读锚点位移 0、挂载期 SSE 可见；4,194,417 字符载荷无 secret、无 long task；MessageChannel 为 19 次总让步、12 次挂载期让步、96/96 消息、`busy=null`。
- 六张读盘截图位于 `apps/control-center/.qa-output/perf-all-final-r4/`：desktop、mobile、desktop-config、mobile-config、large-payload-guard、long-history-window。

## 总评

- 独立 performance review 结论为 APPROVED，无剩余 P0/P1；其最后一项 P2“单独证明 DOM 挂载期让步”已由 `apps/control-center/scripts/qa-ui.mjs:1391` 的 busy-period 计数关闭，本轮实测 12 次（门槛 11）。
- 当轮回归：Control Center `267` 项中 `266` 通过、`1` 个明确 opt-in 跳过；配置校验 `12/12`；全仓 JS/MJS 语法 `86/86`；治理测试 `15/15 + 4/4 + 21/21`。
- 正式版本仍为 `3.5.0`。未 commit、未 push、未 runtime sync；下一步只需关闭隔离 QA 实例并以默认 dataRoot 启动源码实例，向 LO 交付两分钟有效 bootstrap URL。

__DELTA__: 烛(Codex) | 2 | performance | 证据：apps/control-center/src/event-view.mjs:26 的 data-first 节点预算反例推翻了“UI 投影已完整保留协议身份”的收口判断
