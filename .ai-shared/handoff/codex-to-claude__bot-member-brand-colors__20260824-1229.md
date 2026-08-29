<!-- 514cc-session-id: 01a02e6c-852d-79c1-b005-637f42ba18aa -->
# Bot 成员官方图标品牌色交接

## 根因

官方图标 sprite 只保存单色几何；`officialCliIconMarkup()` 没有输出品牌类，Bot 的 `.bot-avatar-icon` 也没有显式 `fill: currentColor`。同时 `botToneForMember()` 只区分 master/codex/grok，其余成员全部落黑色 master 头像底，导致 Claude、Gemini、Kimi、Pi 等看起来像统一黑白占位图。

## 改动

- `apps/control-center/public/modules/avatars.js:18`：统一 SVG 输出增加 `cli-brand-{brand}` 和 `data-cli-brand`，保持品牌 key 来自受限注册表。
- `apps/control-center/public/app.js:14504`：Bot tone 改用 `brandForMember()`，自定义成员仍按绑定席位获得正确品牌。
- `apps/control-center/public/styles.css:6485`：全局官方徽标品牌色；单色品牌在暗色主题下反转。
- `apps/control-center/public/forge/bot-shell.css:19`：增加亮/暗主题品牌 token；Claude/Codex/Gemini/Grok/Kimi/Pi/OpenCode 使用独立头像底。
- `apps/control-center/public/forge/bot-shell.css:879`：Bot SVG 明确 `fill: currentColor; stroke: none`。

## 验证

- `node --test --test-force-exit --test-isolation=none tests/avatars-ui.test.mjs tests/bot-shell-ui.test.mjs`：31 pass / 0 fail。
- `.qa-output/bot-communications-qa.mjs`：Playwright exit 0；Claude computed `color/fill = rgb(217, 119, 87)`，旧黑色头像底已消失；1440x900、1024x768、390x844 无横向溢出，`diagnostics=[]`，graceful shutdown。
- 截图：`C:/Users/16643/AppData/Local/Temp/514cc-bot-communications-qa/bot-contacts-desktop.png`。
- 正式 `51400` 的四个目标前端资源均 HTTP 200，并包含新品牌颜色链。

## 边界

- 官方原生单色品牌不伪造多色几何，只提升背景与主题对比。
- 当前 `cc-desktop` 无可见窗口句柄，未执行桌面刷新；重新打开窗口会从正式实例读取当前资源。
- 未执行 commit/push。

__DELTA__: 烛(Codex) | 1 | correctness | 证据：apps/control-center/public/modules/avatars.js:18、apps/control-center/public/styles.css:6485、apps/control-center/public/forge/bot-shell.css:161；统一修复官方 SVG 品牌标记、fill 与头像底色。
