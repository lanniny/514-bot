<!-- 514cc-session-id: 01a025bc-6dfd-7b00-9f68-cbc352f36c6c -->
# Codex -> Claude：514 Bot 产品重塑基线

## 结果

已完成 Bot Shell v0 第二轮视觉/交互收口，默认入口切为 `bot`，旧 `#/workbench` 保留为高级控制台兼容入口。独立视觉审查发现上一轮仍暴露 Forge 控制台 chrome，本轮已移除默认 Bot 表面的全局导航与状态栏。

核心路线仍是“现有 Node/SSE control-center 内核 + Tauri 2 薄桌面壳 + Bot chat-first 表面”。本轮只重塑默认交互表面，不复制第二套 runtime，也未改动 `apps/desktop` 的 Tauri 壳。

## 关键证据

- 产品规格：`proposals/v43-514-bot-product-reframe.md`
- 工作流：`.workflow/ultracode/514-bot-reframe-20260822/`
- 现有聊天/运行结构：`apps/control-center/public/index.html`、`public/app.js`、`public/state.js`
- 桌面生命周期：`apps/desktop/README.md`、`apps/desktop/src-tauri/src/main.rs`
- 本地参考快照：`.scratch/codeg/README.md`、`.scratch/LiveAgent/README.zh-CN.md`
- 可信闭环边界：`proposals/v42-control-center-product-roadmap.md`

## 采用的产品形态

1. 左栏是代理通讯录，不是项目/功能导航。
2. 中栏是持续聊天，普通消息与 question/approval/connector/computer/artifact/attention 卡片分离。
3. 右栏是代理信息面板，包含电脑预览、Routines、Channels、Members 和代理子设置。
4. 全局设置严格五个 tab：General、Plugins、Team Setup、Appearance、Updates。
5. 代理电脑用 `not-provisioned`、`local-runtime`、`remote-attested` 三态；没有运行态证据不伪装云端电脑。
6. 状态必须显式显示 queued/running/waiting for you/blocked/complete，解决“隐藏思考导致像卡死”的体验缺口。

## 本轮实现

- `apps/control-center/public/index.html`：Bot 代理通讯录、聊天流、question/running/connector/approval 卡片、代理信息面板、电脑预览占位、Routines/Channels/Members、五页设置。
- `apps/control-center/public/app.js`：默认路由、代理切换、输入发送桥、question 确认、面板焦点恢复、快捷键、Plugins 搜索/分类、主题切换和既有 run 真源接线。
- `apps/control-center/public/forge/bot-shell.css`：桌面、平板、移动布局及 Bot 表面溢出修复。
- `apps/control-center/public/forge/art-direction.css`：最终加载层的 Bot 全屏覆盖，阻止 Forge editorial inset 重新出现。
- `apps/control-center/tests/bot-shell-ui.test.mjs`：Bot Shell 静态契约与结构化控件测试。
- 修复 `index.html` 中 8 个离线 Lucide sprite 引用，保持现有 sprite 契约。
- Bot 默认表面隐藏 Forge 顶部导航、侧栏、移动底栏和全局状态栏；主区现在是 260px 通讯录 + 弹性聊天 + 可开关 320px 代理信息面板。
- 代理行支持右键确认删除，并调用既有 `/api/team-members/:id` 删除链；删除不放入设置。
- 电脑预览已接入全屏 `bot-computer-view`，提供 `not-provisioned` 诚实状态、用户交接提示和「交还给代理」闭环。
- 电脑视图从代理信息面板打开时，关闭/交还会先恢复面板，再把焦点还给预览按钮；避免隐藏祖先导致浏览器焦点落到文档。
- 首屏只保留普通短消息与 question 卡；running/connector/approval 保留为可接线结构但不再堆在默认首屏。

## 外部事实边界

LO 的 Grok Bot 体验文字和截图被作为设计输入。MCP Grok Search 在本轮没有拿到可稳定回读的官方 Grok Bot 独立桌面、Team/电脑或 weekly usage 页面；web_fetch 因缺少 `TAVILY_API_KEY`/`FIRECRAWL_API_KEY` 失败。没有把这些内容写成项目事实。

Codeg 与 LiveAgent 采用本仓固定 `.scratch` 快照，不整体 fork、不引入第二个 Gateway、不复制品牌资产。所谓“DeepSeek harness”没有在当前证据中收敛成单一官方产品名，暂不作为架构依赖。

## 验证状态

- `npm run validate`：13/13 通过。
- 聚焦测试：`npm test -- tests/lucide-sprite-contract.test.mjs tests/bot-shell-ui.test.mjs tests/art-direction-contract.test.mjs`，10/10 通过。
- 全量测试：`npm test`，1550 pass / 0 fail / 2 skipped。
- 真实 Playwright 浏览器验证覆盖 1440x900、1024x768、390x844：默认路由、代理切换、question 确认、Bot 发送桥、信息面板焦点恢复、电脑视图打开/交还、电脑交还后关闭面板的焦点恢复、五页设置、Plugins 搜索/分类、主题切换和三视口零横向溢出均通过，console/pageerror 为空。最新证据目录：`apps/control-center/.scratch/bot-shell-live-25444`。
- 501 远程门闸响应为测试实例预期状态，已过滤，不计为 Bot 错误。

## 未闭环边界

- Tauri 桌面壳、真实 provider、真实 SSH/远程电脑均未验收。
- 电脑仍诚实显示 `not-provisioned`；没有远程桌面运行态证据。
- Plugins 安装/认证、Update/Reset 仍是结构化壳层；question/running 尚未接入真实后端实时状态映射。
- 未执行 `git commit` 或 `git push`；工作区仍有并发脏改动和 `.scratch` 产物，禁止 reset/checkout/clean。

__DELTA__: 烛(Codex) | 1 | 证据：`public/forge/art-direction.css` 最终层覆盖 `main-content` 留白；`public/app.js` 的 `computerReturnPanel` 修复电脑交还与随后关闭面板的焦点生命周期；最新三视口真实回归见 `apps/control-center/.scratch/bot-shell-live-25444`。
