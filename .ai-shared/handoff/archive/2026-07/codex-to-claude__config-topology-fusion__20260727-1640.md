<!-- 514cc-session-id: 019fa017-874a-7602-9799-c53d29bf9e38 -->
# 配置图谱与配置界面融合收口

- 日期：2026-07-27 16:40 +08:00
- 范围：`apps/control-center` 配置入口、Provider/Capability/Source 三工作面、CC-Switch 深链与刷新、浏览器 QA
- 决策：`D-2026-07-27-002`

## 致命问题

1. 原“能力图谱”和“配置界面”是两个入口与两套页面语义，用户需要在观察与修改之间跳转。现由 `apps/control-center/public/index.html:661` 建立唯一“配置图谱”入口，并在 `index.html:667` 下收敛为互斥的 `供应商与应用 / Agent·Skill·MCP / 真源与运行时` 三工作面；`apps/control-center/public/app.js:74` 保留旧 `#capabilities` 兼容别名。
2. Skill/MCP 跳真源曾依赖路径后缀猜测，同名 repo/runtime 配置可能跳错。现由 `apps/control-center/src/config-manager.mjs:190` 只按绝对完整路径返回唯一 `sourceId`，经 `src/app.mjs:125` 注入能力聚合；前端只消费后端 ID，不再猜路径。
3. 第一轮全量绿色仍漏了 CC-Switch 假成功：局部刷新在部分失败后无条件提示“已刷新”，Tauri native invoke 失败也不进入 Forge 聚合。现由 `apps/control-center/public/modules/ccswitch-panel.js:44` 共享在途加载并返回显式结果，`ccswitch-panel.js:73` 把 native 错误记为 `tauri:native`，`ccswitch-panel.js:286` 按结果显示成功或 warning。
4. 原生深链主路径曾只触发 `.click()` 而未等待解析，面板缺失降级路径也会并发。现 `ccswitch-panel.js:165` 的预览 Promise 由按钮和 `openDeeplink()` 共用；`apps/control-center/public/app.js:4328` 的 Provider 对话框降级入口同样 await，`app.js:4338` 的队列在两条路径都维持 FIFO。

## 建议改进

1. 当前仓库源与隔离 QA 已验证；正在运行的桌面内核启动于后端改动之前，未在本轮重启或 runtime sync。若要把后端 `sourceId`/刷新契约切入现有桌面进程，应单独做受控重启与 readback，不能把源码态冒充激活态。
2. 保留 3 个 updater `blocked_external_trust`，直到 514cc 有自有签名公钥与更新端点；配置融合不改变该信任边界。
3. `exceljs@4.4.0` 的既有 11 high + 1 moderate 传递依赖债未因本轮改变；禁止无评估运行 `npm audit fix --force`。

## 可保留

1. 三工作面是同一配置对象的三个观察/操作尺度，不是卡片堆叠；`#config/providers`、`#config/capabilities`、`#config/sources` 互斥显示，并支持方向键、Home/End 和旧链接兼容。
2. MCP 与 Skill 保持独立故障域。`apps/control-center/scripts/qa-config-topology.mjs:312` 用隔离磁盘夹具真实损坏两类配置、调用 HTTP、执行反向允许操作并读回磁盘：MCP 坏时 Skill 仍可写，Skill 坏时 MCP 隔离事务仍可写。
3. 移动端在 `apps/control-center/public/forge/data.css:948` 将拓扑外扩对齐 8px 主容器；QA 同时检查 body 和 `.main-content`，390px 明暗三工作面均无横向溢出。
4. QA 服务使用随机本地 token、受控 shutdown 并等待退出，见 `apps/control-center/scripts/qa-config-topology.mjs:65`、`:129`；当轮读回测试端口未监听且 `control-center.lock` 已释放。

## 总评

结论：**能力图谱与配置界面已在当前仓库源中完成融合**。融合不仅是入口改名，还统一了路由、状态所有权、真源身份、错误传播、并发顺序、键盘与移动布局；Provider、CC-Switch、Skill/MCP 和事务化真源编辑均保留。

当轮机械证据：

- 定向融合回归：51 pass / 0 fail。
- `npm test`：572 tests，571 pass，0 fail，1 opt-in skip。
- `npm run validate`：13/13；CC-Switch 288 入口仍为 157 equivalent + 128 adapted + 3 blocked_external_trust。
- `npm run qa:config-topology`：`ok=true`；桌面/390px、明暗、三工作面 12 张 + 双故障态 2 张，共 14 张截图。
- Node syntax：9/9；`git diff --check` 通过。
- QA 报告：`apps/control-center/.qa-output/config-topology/report.json`。

边界：未 commit、push、runtime sync 或重启现有桌面进程；PTY 测试仍打印既有 `AttachConsole failed` helper 噪声，但对应测试与总退出码均为 0。

__DELTA__: 烛(Codex) | 2 | observability | 证据：独立审计两次推翻“全量绿色即可收口”，定位 public/modules/ccswitch-panel.js:286 的局部假成功与 :73 的 native 错误漏聚合，并促成真实点击/原生失败/并发加载回归
