# handoff：全部隐藏聚合项目 + 恢复入口

- 时间：2026-07-20
- 范围：`apps/control-center`（public/app.js、public/index.html、public/styles.css、scripts/qa-ui.mjs、tests/social-orchestration.test.mjs）
- 触发：LO「全部隐藏（不动文件，视图清零，随时可恢复）」

## 交付

1. **批量隐藏**：79 个聚合项目 prefs hidden:true（normalizePathKey 同前端口径，PUT /api/projects/prefs）——磁盘文件零触碰。
2. **恢复入口**（此前隐藏是 UI 单行道，只能手改 project-prefs.json=隐性坑）：团队区头部「已隐藏」开关（sessionStorage 记忆）——开启后隐藏项目压暗回树+「已隐藏」徽标；右键菜单对 hidden 项目出「取消隐藏」项。
3. **qa 环境自洽**：qa-ui workbench 用例原硬依赖项目树非空，视图清零后必超时——改为树空时先开「已隐藏」开关，用例与侧栏偏好状态解耦。
4. **负载敏感测试**：「ask raised near the round cap」高压期 15s 超时一次（Cursor 记录的同类环境抖动，本轮纯前端改动非回归）——断言埋相位 dump，下次一次定位。

## 验证

- 156/156 × 3（含负载敏感用例）+ qa:ui --suite=all ok:true。
- 双截图：清零态（0 项目）/ 恢复态（32 项目压暗标注，32<79=「近期」过滤仍生效，正确）。

__DELTA__: 主驾(Kimi) | 1 | 证据：隐藏功能此前无 UI 恢复路径（只能手改 project-prefs.json）——「随时可恢复」若只做批量隐藏会变成新坑，恢复入口必须同轮补齐
