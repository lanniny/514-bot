<!-- 514cc-session-id: 01a0331e-cdc0-7330-80ec-8d4c95705443 -->
# Bot direct/group 对话与图片附件收口

## 状态

`partial`：目标功能源码、Conversation HTTP、Orchestrator 聚焦测试和真实浏览器三视口验收已通过；正式桌面实例与真实 provider 尚未刷新/调用，因此不宣称正式激活。

## 改动文件

- `apps/control-center/src/conversations.mjs`：direct / workspace_group / legacy_pipeline 身份、规范化 cwd、CAS、原子 JSON、墓碑删除、run 绑定。
- `apps/control-center/server.mjs`：`/api/conversations` CRUD、duplicate 与 revision 错误回包。
- `apps/control-center/src/app.mjs`：ConversationStore 生命周期、TeamMember 引用保护、Orchestrator 装配。
- `apps/control-center/src/orchestrator.mjs`：`conversationKind` 校验与持久化；direct 只对 `executionOwnerId` 执行一次 `turn()`；workspace group 强制 social/cwd/member snapshot。
- `apps/control-center/public/app.js`：Conversation 选择、群聊工作目录/成员、右键菜单、direct/group 发送分流、Bot 图片 paste/drop/file 选择与上下文隔离、上传中禁发。
- `apps/control-center/public/app.js`：Bot 对话索引改为在 `initializeAccessToken()` 完成后加载，避免首屏未认证请求 `/api/conversations` 产生 401。
- `apps/control-center/public/forge/bot-shell.css`、`public/index.html`：对话分区、群聊行、菜单相关样式、Bot 附件 chips 和隐藏 file input。
- `apps/control-center/tests/bot-shell-ui.test.mjs`：更新 pending ask composer 契约，新增菜单、direct/group topology 和通讯录右键静态契约。
- `apps/control-center/tests/clipboard-attachments-ui.test.mjs`：新增 Bot paste/drop/file/context isolation 契约。

## 核心不变量

- direct Conversation 的 `directMemberId`、run 的 `executionOwnerId` 和一次 provider turn 必须一致；direct 不进入 coordinator/verifier/final synthesis，也不发送 social。
- workspace group 的 `cwd` 是唯一群聊身份；成员变更轮换 active run；social run 只绑定同一 Conversation。
- `bot:conversation:<id>` 是附件分柜键，不能跨 direct/group/workbench 泄漏；图片-only prompt 只作为内部 transport，不替换 UI 显示文本。
- 迟到 HTTP 回包由 pending submission token/状态闸门丢弃；terminal run 后不会错误续接旧 provider session。

## 验证证据

```text
node --test --test-force-exit tests/bot-shell-ui.test.mjs tests/clipboard-attachments-ui.test.mjs tests/orchestrator.test.mjs
156 pass / 0 fail

node --test --test-force-exit tests/conversations.test.mjs tests/conversations-http.test.mjs tests/mission-control.test.mjs tests/mission-control-http.test.mjs
23 pass / 0 fail

npm run validate
13/13 valid

node --check public/app.js tests/bot-shell-ui.test.mjs tests/clipboard-attachments-ui.test.mjs
exit 0
```

真实浏览器（隔离 Control Center，Playwright）:

```text
1440x900 / 1024x768 / 390x844：Bot 页面加载，bodyScrollWidth == viewportWidth，无 pageerror。
认证后 `/api/conversations` 无 401；通讯录右键自动 POST kind=direct、directMemberId=claude-fable。
右键菜单实际显示：置顶、移至 ›、标为未读、编辑资料、创建副本、复制对话 ID、从侧边栏隐藏、删除。
置顶与未读实际 PATCH；群聊表单实际 POST kind=workspace_group、cwd、memberIds=[claude-fable,codex-technical]。
图片输入监听已挂载：paste、drop、file selection；真实 1x1 PNG paste 在 Bot 输入框生成 1 个附件 chip；隔离数据根回读 direct 与 workspace_group 分开保存。
同一 cwd 第二次建群返回 409 WORKSPACE_CONVERSATION_CONFLICT。
```

## 未闭环

1. 正式桌面实例未刷新，真实 provider 未调用；当前证据是隔离本地 Control Center，不能替代正式激活证明。
2. 浏览器隔离运行会让 Channels/Office/Market/SSH 等非本轮面返回 501；这些不是 direct/group/附件链路失败，但需在环境 QA 中另行收口。
3. 全量 `npm test` 本轮出现既有 reduced-motion canvas 契约失败、workbench rail 静态契约漂移；长尾 teardown 无新输出，不能宣称 full-suite clean。本轮复跑的 Bot/附件 UI 为 47 pass / 0 fail，Conversation/HTTP/Mission 为 23 pass / 0 fail；交接前 Bot+附件+Orchestrator 组合记录为 156 pass / 0 fail。

__DELTA__: 烛(Codex) | 2 | 证据：`apps/control-center/public/app.js:14983`、`:17809`、`:17221`；独立收口将旧 Bot 每条消息新 run 语义改为 Conversation 级 direct/group 拓扑，并补齐通讯录右键与附件分柜。
__DELTA__: 烛(Codex) | 1 | 证据：`apps/control-center/public/app.js:17768`、`:26965`；真实浏览器回读发现并修复 Bot 首屏认证竞态，三视口与 direct/group/菜单/附件交互证据已补齐。

## 图片缩略图补强（2026-08-25）

### 状态

`implemented / isolated-runtime-verified / formal-desktop-partial`：Bot 输入框内的图片附件已从文字 chip 改为受控 `blob:` 缩略图卡片；提交协议仍使用服务端返回的本地路径，预览 URL 只存在于当前浏览器上下文。

### 实现

- `public/modules/clipboard-attachments.js`：上传队列可透传可选 `previewUrl`，不改变 `path`、claim 或附件提交契约。
- `public/app.js`：Bot context 增加 `previews` / `previewUploads` 两张 Map；粘贴、拖放、文件选择在上传前生成 `URL.createObjectURL(file)`，成功后绑定到服务端路径；失败态继续显示缩略图；移除、提交消费、上下文迁移时回收 `blob:` URL。
- `public/forge/bot-shell.css`：预览位于 composer 内部，固定方形裁剪、圆角、右上角圆形移除按钮；桌面卡片 116px，移动端 88px，附件条横向滚动且不撑破输入框。
- `tests/clipboard-attachments-ui.test.mjs`：新增 preview URL 透传和图片 DOM/CSS 契约。

### 验证

```text
node --check public/app.js public/modules/clipboard-attachments.js：通过
npm run validate：13/13 valid
node --test --test-force-exit tests/bot-shell-ui.test.mjs tests/clipboard-attachments-ui.test.mjs tests/orchestrator.test.mjs：158 pass / 0 fail
隔离 Playwright 真实 PNG paste：1440x900、1024x768、390x844 均生成可见 blob: <img>；naturalWidth=1；预览框 114/86px；移除按钮 24/22px；body/root 横向溢出均为 0；console/pageerror 为空。
截图：apps/control-center/.scratch-attachment-preview-1440.png、.scratch-attachment-preview-1024.png、.scratch-attachment-preview-390.png
```

### 边界

- 服务端 clipboard API 只返回本地存储路径，浏览器不能直接把该路径当 `img.src`；因此刷新页面或切换到没有该浏览器 File 对象的上下文时，历史附件只保留路径 fallback，不伪造预览。
- 正式桌面实例未刷新，真实 provider 未调用；正式激活继续为 `partial`。

__DELTA__: 烛(Codex) | 1 | 证据：`apps/control-center/public/app.js:17246-17360`、`public/forge/bot-shell.css:401-438`、`tests/clipboard-attachments-ui.test.mjs:200-345`；把已验证的附件 chip 视觉升级为输入框内真实缩略图，并保留路径提交、失败可见、移除回收和三视口无溢出边界。

## 图片大图预览补强（2026-08-25）

### 状态

`implemented / isolated-runtime-verified / formal-desktop-partial`：点击 Bot 输入框内的图片缩略图可打开原生 modal 大图预览；关闭按钮、Esc、遮罩关闭均可用，关闭后焦点回到当前缩略图。上传状态重绘替换旧 DOM 节点时，会按受控 `blob:` URL 找回新节点并恢复焦点。

### 实现

- `public/index.html:658-663`：新增 `#bot-image-preview-dialog`、标题、预览图片和关闭按钮。
- `public/app.js:17283-17300`：只接受受控 `blob:` / 图片 data URL，写入预览图并保存 opener 与 URL。
- `public/app.js:17317-17329`、`:17989-18044`：已保存、上传中、失败图片均提供点击与 Enter/Space 预览；关闭后同步 + 下一任务队列双阶段恢复焦点。
- `public/forge/bot-shell.css:440-446`、`:782-787`：桌面与移动端 dialog、遮罩、contain 预览和视口约束。
- `tests/clipboard-attachments-ui.test.mjs:330-353`：静态契约明确锁定预览触发器、dialog 和 contain 样式；修正原有 `img src` 属性顺序假设。

### 验证

```text
node --check public/app.js
node --test --test-force-exit tests/clipboard-attachments-ui.test.mjs tests/bot-shell-ui.test.mjs
49 pass / 0 fail

npm run validate
13/13 valid

隔离 Playwright（CONTROL_CENTER_PORT=4519，未调用 provider）：
1440x900 与 390x844 均打开 dialog；预览图 src 与缩略图保持同一 blob: URL；关闭按钮、Escape、遮罩关闭通过；点击主体保持打开；关闭后焦点恢复；document/body 横向溢出均为 0；pageerror 为空。
隔离环境仅产生非本轮 Channels/Office 等接口的预期 501，已从判定中排除；未发现其他 console error。
```

### 边界

- 预览依赖当前浏览器 File 生命周期；刷新后历史附件没有原始 File 时仍只显示路径 fallback，不伪造大图。
- 预览不新增服务端协议，服务端仍只接收本地保存路径；正式桌面实例未刷新，真实 provider 未调用，正式激活继续为 `partial`。
- 未执行 `git commit` / `git push`。

__DELTA__: 烛(Codex) | 1 | 证据：`apps/control-center/public/app.js:17283-17295`、`:18029-18044`；独立浏览器验证发现原生 dialog 关闭时桌面焦点可能被同步恢复时序覆盖，补充按 blob URL 找回重绘后的缩略图并延迟一拍恢复焦点，完成按钮/Esc/遮罩三条关闭路径的可访问性闭环。
