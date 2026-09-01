# Wave B 抽取首批：右键菜单展示层 → modules/context-menu.js（app.js 净减 66 行）

- 执行者：Claude（Verdent 运行时，AEMEATH 面）
- 时间：2026-08-31 15:25 ~ 15:55（绝对时间 UTC+8）
- 依据：LO 指令「继续」；v45 计划 Wave B 主项（app.js 按视图抽取）首个切片
- 说明：本会话无 route-gate 注入 session marker，按契约省略该行。

## 一、抽取内容

**新增** `public/modules/context-menu.js`（106 行）：右键菜单**展示层**工厂 `createContextMenu({ getMenuRoot, icons })`——显隐、视口钳位、键盘导航（Esc/↑↓）、焦点恢复、二级菜单原位重开状态（`lastPosition()`）、触发按钮标记 `triggerMarkup`。图标集 `MENU_ICONS` 保留在 app.js 以依赖注入传入（它与置顶标记等 4 处渲染共用）。

**app.js 改动**（32170 → 32104，净减 66 行）：
- 引入 `createContextMenu`，:7539-7540 创建实例；
- 4 个同名委托函数保留（`menuTriggerMarkup/hideContextMenu/showContextMenu/showContextMenuFromTrigger`）——**26 个调用点与 bot-shell-ui.test.mjs:858 的断言零改动**；
- 删除模块级 `lastMenuPos`/`contextMenuCleanup`（状态归工厂闭包），4 处 `lastMenuPos.x/y` 读取点改为 `contextMenu.lastPosition().x/y`（:7709、:8885、:8955、:18162）。
- 菜单**内容构建**（项目/会话/Bot 上下文条目）仍留在 app.js——它们强耦合 state/request/toast，属视图逻辑不属于展示层。

## 二、验证

- 新增 `tests/context-menu-module.test.mjs`（3 测试）：triggerMarkup 对 id/label 的转义注入防线、工厂 API 形状、app.js 接线契约（含旧全局状态必须已删除）。
- `node --test context-menu-module + chrome-menus-contract` → **9/9**；`bot-shell-ui + ui-lint + failure-presentation` → **50/50**。
- `node --input-type=module --check` app.js 语法通过；`lastMenuPos`/`contextMenuCleanup` 残留扫描 = 0。
- 交付清单 drift 13→15：新增的模块与测试 2 个文件未提交所致，与 P0-3 同根因（待 LO 授权提交），归属规则 `public/**`、`tests/**` 本就覆盖。

## 三、后续切片建议（未开始）

下一个低风险候选（按依赖面从小到大）：`置顶区+归档区渲染`（:7378-7456，78 行）→ `ccline 状态条`（:22757-22805，48 行）→ `输入对话框`（:7457-7495）。Bot Shell 5451 行仍是最大单体，需专项会话。

__DELTA__: Claude(Verdent) | 1 | 证据：public/modules/context-menu.js 新增 106 行展示层工厂；app.js 32170→32104 净减 66 行；tests 9/9 + 50/50 双绿；4 处 lastMenuPos 读取点迁移 contextMenu.lastPosition()
