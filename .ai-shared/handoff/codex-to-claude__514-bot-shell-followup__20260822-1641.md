<!-- 514cc-session-id: 01a025bc-6dfd-7b00-9f68-cbc352f36c6c -->
# Codex -> Claude：514 Bot Shell follow-up

## 结果

继续完善 Bot Shell v0，保持“代理通讯录 + 持续聊天 + 代理电脑”的默认表面和现有 Node/SSE control-center 唯一运行真源。本轮没有引入第二套 runtime，也没有执行 commit/push、Tauri 发布或远程操作。

## 本轮修复

1. `apps/control-center/public/app.js`
   - 新增 `botSyncRosterRow()`：代理子设置保存后，即使 bootstrap 仍使用 HTML fallback，通讯录行也会同步头像、名字、descriptor 和状态。
   - `setView()` 离开 Bot 时统一收拢代理子设置、电脑视图、代理信息面板和全局设置，避免返回 `#bot` 后隐藏 dialog 继续拦截点击或保留错误焦点。
   - 保持 Bot 每条消息独立创建 run、有限 `run -> agent` 本地索引、optimistic 快照和迟到 POST `late-detached` 语义。

2. `apps/control-center/tests/bot-shell-ui.test.mjs`
   - 增加离开 Bot 时覆盖层收拢契约，保留代理设置、插件库、五 tab、事件历史和迟到回包断言。

3. `.scratch/bot-shell-live-qa-v3.mjs`
   - 将 POST body 记录移动到 `route.fulfill()` 完成之后，并等待队列 DOM 出现，修正拦截器写入时刻早于页面 `fetch` 回包处理的探针竞态。
   - 实际覆盖代理齿轮保存名称/Title/Description、通讯录/顶栏/输入目标同步、Cursor 登录入口往返、五个设置页、Plugins 市场/Installed/Private skills 编辑保存、危险删除确认、主题、电脑视图和刷新后历史。

## 验证

- `node --check public/app.js`：通过。
- `npm test -- tests/bot-shell-ui.test.mjs`：11 pass / 0 fail。
- `node .scratch/bot-shell-live-qa-v3.mjs`：1440x900、1024x768、390x844 全部通过；`console` / `pageerror` 为空，body/root 横向溢出均为 0。截图与 JSON 证据目录：`apps/control-center/.scratch/bot-shell-live-v3-43068`。
- 浏览器回归确认：发送后队列可见；刷新后 run 与历史仍归属原代理；代理设置保存后通讯录、顶栏和 composer 目标一致；Cursor 入口进入既有连接配置；Private skill 删除出现危险确认卡。

## 仍为 partial 的边界

- 真实远程代理电脑和 `remote-attested` 运行态未接入；当前电脑视图保持 `not-provisioned`。
- Tauri 正式桌面壳、真实 provider/SSH 端到端验收未执行。
- Plugins 安装/认证、Update/Reset、ask/answer 完整事件生命周期仍未接真实后端。
- Bot 的 run 归属仍是客户端有界索引，不是后端协议字段；事件历史仍由既有 `/api/runs/:id/events` 真源提供。
- 工作树含其他协作者修改和 `.scratch` 产物，未做清理或回滚。

__DELTA__: 烛(Codex) | 2 | correctness | 证据：`apps/control-center/public/app.js` 的 fallback 通讯录行同步与离开 Bot 覆盖层收拢修复；`apps/control-center/.scratch/bot-shell-live-qa-v3.mjs` 三视口真实交互回归通过，并修正过早队列断言。
