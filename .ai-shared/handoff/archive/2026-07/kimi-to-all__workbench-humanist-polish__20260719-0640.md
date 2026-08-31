# handoff：协作台人文美化波次（kimi → all）

- 时间：2026-07-19 06:40
- 范围：`apps/control-center/public/styles.css`（末尾追加两个美化区块）、`public/app.js`（2 处结构类名）、`DESIGN-NOTES.md`（追加本轮记录）
- 触发：LO「总体对协作台页面进行前端完善，尽量美观」

## 做了什么

1. **消息流分层**：LO 头像 rose-soft 暖底 + 暖纸便签气泡（新 `is-user` 类）；头像统一 9px 圆角无框；正文 12.5px/1.7；时间戳等宽化；轮次分隔线改细实线。
2. **空态仪式化**：衬线大标题 + 赤陶 ◆ 装饰点（原 sprite 图标渲不出，纯 CSS 替代）。
3. **会话头衬线化** + run 元信息等宽柔灰。
4. **右栏**：分组标签统一小灰字宽字距；路由模型 ◆ 前缀；拓扑节点卡片化；时间线等宽化；失败/拒绝/丢弃事件圆点标红（新 `is-alert` 类，app.js 按事件名正则 `/fail|error|denied|dropped|blocked/i` 判定）。
5. **左栏选中态**：2px 赤陶 inset 竖条（rail-run-button / team-option / session-link）。
6. **已归档灰盒修复（真 bug）**：`.archived-toggle` 是 `<button>` 且全局无 button 边框/背景重置 → UA 默认灰盒外露；补无框重置 + hover + chevron 旋转。
7. **全局**：焦点环冷蓝→赤陶；协作台容器细暖滚动条；暗色 `--text-soft/--border` 提亮半档；暗色 composer 阴影改纯黑。

## 验证

- `qa:ui --suite=all`：0 错误（layout + workbench 状态机）。
- `node --test`：113/113 通过。
- Playwright 实拍：亮/暗 × 桌面 1440/移动 390 + 空态（含 ◆ 点）复核通过。

## 注意

- styles.css 全部为**末尾追加覆盖**（同优先级后声明生效），未改旧规则本体；如需回退删末尾「协作台人文美化波次」起的追加区块即可。
- app.js 两个类名是新增修饰类，不改逻辑；无 `is-user`/`is-alert` 样式时表现与之前一致。

__DELTA__: 烛面(kimi) | 1补强 | 协作台整体美化：消息气泡/空态/右栏/左栏选中条/已归档灰盒修复（styles.css 末尾追加区块；app.js:2531 messageMarkup is-user、app.js:2587 timeline is-alert；qa:ui 0 错误 + 113/113 测试 + 亮暗实拍）
