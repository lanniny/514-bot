<!-- 514cc-session-id: 01a03a0d-a777-7020-81df-868c3c5efa58 -->
# Codex 实现与复核：任意 Conversation 可发现、可进入、可回看

- **时间**：2026-08-26 06:00 +08:00
- **目标**：让任意仍存在的 Conversation 都能从 514 Bot 被找到、区分、精确进入，并访问仍存在的历史 Run。
- **范围**：会话树、通讯录多会话选择、短 ID 搜索、Conversation 深链、单 Run 读取、归档/隐藏/删除状态、Playwright 验收。

## 致命问题

1. **已修复：同一成员多条 direct Conversation 显示同名且通讯录静默打开第一条。** 会话行现在使用持久化 `conversation.title`，展示成员名、8 位短 ID 和活动时间；通讯录显示会话数，存在多条时弹出按 Conversation ID 区分的选择菜单，见 `apps/control-center/public/app.js:14841`、`:14997`、`:15325`。
2. **已修复：历史 Run 加载调用不存在的 `API.run()`，服务端也没有普通单 Run GET。** 新增 `API.run(id)` 与 `GET /api/runs/:id`；存在的 Run 返回公共投影，不存在稳定返回 `404/RUN_NOT_FOUND`。已清理 Run 只显示“仅保留 Conversation 审计引用”，不重建、不重放，见 `public/api.js:18`、`server.mjs:2011`、`public/app.js:16777`。
3. **已修复：隐藏、归档和删除状态混淆。** 隐藏行显示“已隐藏”，归档行显示所属项目，删除墓碑只保留复制 ID/链接；归档项目会话进入后文本、附件按钮、粘贴、拖放和发送入口均 fail-closed，见 `public/app.js:14807`、`:15160`、`:15325`、`:17994`、`:18006`、`:18380`。

## 建议改进

1. Conversation Store 当前最多 2,000 条，前端一次加载并本地筛选。数据规模继续增长时，应补服务端 query/cursor/limit，不要把 localStorage 升格为历史真源。
2. 历史 Run 主体可被 `clearFinished()` 删除，Conversation 只保留 bounded `runIds` 引用。这是诚实审计语义；若以后需要长期回放，应新增独立归档投影，而不是从 localStorage 或 prompt 伪造 Run。
3. `qa:bot-p0` 为 Conversation 导航隔离了 `/api/workbench/environment`，因为环境舱存在独立的 `EVENT_INDEX_BUSY` 竞态且有自己的专项 QA。该 stub 不覆盖 Conversation、Project、Run、SSE 或消息接口。
4. **DELIVERY_BLOCKED**：strict delivery 仍为 `clean=false / strictFailure=true / 25 untracked source-or-test`。未暂存、commit、push 或正式 reload。

## 可保留

1. `Project -> Conversation -> Run -> native CLI session` 四层身份不变；导航索引继续来自服务端 ConversationStore/ProjectRegistry。
2. 隐藏会话点击后恢复并打开；归档项目仍为可查看但不可发送的只读封存；删除仍是不可进入的墓碑。
3. 树键盘 Arrow/Home/End/Enter 与 Conversation ID 精确打开逻辑继续沿用；新增真实浏览器验证，没有创建第二套导航组件。
4. URL 采用 `#conversation=<id>` 稳定深链；旧 `#run/#project/#session` 对象形状保持兼容。

## 总评

- focused：`39 tests / 39 pass / 0 fail`。
- full：`1649 tests / 1647 pass / 0 fail / 2 skipped`；`clean-exit:resource/exit/childexit=ok`。
- validate：`13/13 valid`。
- Playwright：`shortIdSearchMatched=true`、`contactConversationPickerVerified=true`、`keyboardConversationEntryVerified=true`、`historyRunLoaded=true`、`messageEndpointStatus=202`、`mobileHorizontalOverflow=0`、`lateResponseIgnored=true`，且 `pageErrors=[] / consoleErrors=[] / failedResponses=[]`。
- 独立复核新增三个缺口：缺失 Run 未稳定 404、归档附件入口绕过只读、删除墓碑右键仍暴露写操作；三项均已修复并回归。
- 当前结论：`SOURCE_AND_ISOLATED_RUNTIME_VERIFIED / DELIVERY_BLOCKED / FORMAL_RUNTIME_UNVERIFIED`。正式版本仍为 v3.5.0。

__DELTA__: 烛(Codex) | 1 | 证据：apps/control-center/server.mjs:2011、public/app.js:15160,18006；独立复核补出缺失 Run 404、归档附件入口和删除墓碑菜单三个边界并完成修复
