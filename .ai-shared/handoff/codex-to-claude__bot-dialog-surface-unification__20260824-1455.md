<!-- 514cc-session-id: 01a02e6c-852d-79c1-b005-637f42ba18aa -->
# Bot 全局弹窗表面统一与路由生命周期修复

## 结论

LO 截图中的“移出通讯录”确认框仍继承旧 Claude/Forge 暖纸弹层。当前 Bot 的 9 个全局 `<dialog>` 已统一为中性聊天表面，并补齐离开 Bot 时的关闭、焦点、动态 class 与脏草稿保护；非 Bot 工作台继续保留原 Forge 视觉。

## 实现

- `apps/control-center/public/forge/bot-shell.css:974`：新增 Bot-only dialog token 和组件覆盖，统一白/深灰表面、6px 圆角、无 backdrop blur、同色操作栏、5px 控件与危险红色。
- `apps/control-center/public/forge/bot-shell.css:1166`：仅将 provider 普通 hint 中性化；删除全局 amber 灰化，让 live drift 保留 warning 语义。
- `apps/control-center/public/app.js:2294`：登记 9 个 Bot 全局 dialog；`app.js:2306` 按 cancel 协议关闭，并尊重 `defaultPrevented`。
- `apps/control-center/public/app.js:2357`：运行席位脏草稿进入可续接路由门；取消保留草稿，确认后继续 latest target，显式 Bot 选择取消 pending，原始 hash 可恢复。
- `apps/control-center/public/app.js:23056`：每次确认操作重设 `data-tone`，危险态不会污染后续普通确认。

## 验证

- 语法与差异：`node --check public/app.js`、`node --check .qa-output/bot-communications-qa.mjs`、`git diff --check` 通过。
- 静态聚焦：`tests/bot-shell-ui.test.mjs` 为 31 pass / 0 fail；通过汇总后仍有既有句柄，已主动终止，不能写成 clean exit。
- 配置校验：`npm run validate` 为 13/13 valid。
- Playwright：联系人确认框、8 类复杂 dialog、1440x900/1024x768/390x844、暗色移动端全部通过；`diagnostics=[]`，无横向溢出，隔离服务 graceful shutdown。
- 弹窗路由：`common-config-dialog` 离开 Bot 后 `open=false`、焦点离开、动态 class 撤销；返回 Bot 后 class 恢复。
- 草稿路由：自动化 dirty 取消保持原 dialog；运行席位 dirty 取消保留草稿，确认期间改选 Team 后最终进入最新 `#team`，配置 DOM 已归位。
- Provider 语义：hint 保持中性；live drift 浅色 `rgb(138, 91, 0)`、深色 `rgb(224, 168, 77)`。
- 截图：
  - `C:/Users/16643/AppData/Local/Temp/514cc-bot-communications-qa/bot-contact-remove-dialog-light.png`
  - `C:/Users/16643/AppData/Local/Temp/514cc-bot-communications-qa/bot-contact-remove-dialog-mobile-dark.png`
  - `C:/Users/16643/AppData/Local/Temp/514cc-bot-communications-qa/desktop-dialog-family-automation-dialog.png`
  - `C:/Users/16643/AppData/Local/Temp/514cc-bot-communications-qa/mobile-dark-dialog-family-provider-dialog.png`

## 独立复核增量

1. 首轮终审发现离开 Bot 不关闭全局 modal，以及 provider warning 被整体灰化；两项均已修复并补浏览器回归。
2. 后续复核推翻“cancel 后可无条件兜底 close”，因为会绕过自动化未保存守卫；现尊重 `cancelEvent.defaultPrevented`。
3. 再复核发现运行席位工作区仍可绕过 dirty guard；修复后又补 latest-target、Bot 取消 pending 与 hash 一致性。
4. 最终零缺口扫描对当前路由门返回无已证实 correctness/data-loss/hash/async reentry finding。

## 边界

- FastCtx 仍返回 `Transport closed`，本轮显式降级到只读 PowerShell；没有静默 fallback。
- 浏览器测试使用隔离数据根，不改正式成员、团队、席位或 operator profile。
- 正式资源激活与桌面窗口可见性分层记录；HTTP 静态资源命中不能替代正式窗口截图。
- 工作区有大量并发改动；未 reset/checkout/clean，未 commit/push。

__DELTA__: 烛(Codex) | 2 | 证据：apps/control-center/public/app.js:2306、apps/control-center/public/app.js:2357、apps/control-center/.qa-output/bot-communications-qa.mjs:605；独立复核连续推翻强制 close、席位工作区直关和 stale route 三项判断，最终形成可验证的弹窗与脏草稿路由生命周期。
