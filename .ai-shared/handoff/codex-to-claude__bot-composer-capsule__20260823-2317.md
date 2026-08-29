<!-- 514cc-session-id: 01a02e6c-852d-79c1-b005-637f42ba18aa -->
# Bot 发送框胶囊样式

## 结论

按 LO 提供的参考图，将 Bot 发送框收敛为矮胶囊单行布局：左侧圆形加号、中央占位输入、右侧深色圆形麦克风图标。发送和附件行为保持原有 runtime 合同，不虚构录音能力。

## 改动

- `apps/control-center/public/index.html:568`：新增 `.bot-composer-row`；附件入口使用 `plus`，提交按钮使用 `mic`，保留唯一 `#bot-composer-input`。
- `apps/control-center/public/forge/bot-shell.css:335-351`：发送框高度约 `44px`、外层圆角 `24px`，左右按钮 `30px` 圆形；快捷键提示保留但隐藏。
- `apps/control-center/scripts/vendor-lucide.mjs:20`：加入 `mic`；运行生成器后 `lucide-icons.json` / `lucide-sprite.svg` 为 `139` 个图标、`missing=0`。
- `apps/control-center/tests/bot-shell-ui.test.mjs:75-95`：增加结构、样式、图标和单一 textarea 契约。

## 证据

- 聚焦测试：`26 pass / 0 fail`（Bot Shell + Lucide sprite；输出完成后 Node 长生命周期句柄未自动退出，已停止）。
- `npm run validate` 输出 `13/13 valid`。
- 隔离 Control Center + Playwright：`#bot-composer-input` 数量为 `1`；外层 `44px / 24px`；左右按钮均 `30px / 50%`；图标为 `#lucide-plus` 和 `#lucide-mic`。
- 视觉回读：`C:/Users/16643/AppData/Local/Temp/514cc-bot-composer-capsule.png`。
- 隔离页出现的 `501 Not Implemented` 仅来自未授权外部能力探针；Bot 页面与发送框正常渲染，未将其伪装为 UI 失败。

__DELTA__: 烛(Codex) | 1 | 证据：apps/control-center/public/index.html:568、apps/control-center/public/forge/bot-shell.css:335-351 将原双区发送框收敛为可回读的单行胶囊，同时保留现有 form submit 与附件 action 合同
