# handoff：codeg 对标续轮——P1 顺手项 + P2 只读面 + Cursor 会话源

- 时间：2026-07-20
- 范围：`apps/control-center`（server.mjs、public/app.js、public/index.html、public/styles.css、src/capabilities.mjs、src/run-diff.mjs、src/sessions.mjs、tests/）
- 触发：LO「继续对标 codeg 完善整个协作台」——清 proposals/v37-codeg-parity-design.md 剩余项

## 交付清单

1. **诊断日志级别过滤**（P1 顺手①）：安全诊断页日志区级别 select（全部/信息/警告/错误），按 `[LEVEL]` 前缀解析。
2. **欢迎空态快捷任务模板**（P1 顺手②，codeg Quick Actions 对标）：新任务空态三模板卡（深度评审/调研问路/隔离构建），点击填 composer 不自动提交；模板措辞焊体系纪律（四节评审/必附来源/先计划后写码）。
3. **能力图谱新页**（P2：Skills+MCP 只读管理面）：`GET /api/capabilities`——Agent 花名册 + Skill 矩阵（文件系统×注册表×团队声明，幽灵注册如实单列）+ MCP 三源扫描（~/.claude.json/~/.claude/settings.json/~/.codex/config.toml）+ 514cc 能力映射。**MCP 白名单字段出网**（名称/传输/命令基名/URL host/来源/范围），env/args/headers 密钥面不出 API。
4. **run 产物 diff**（P2：worktree×run 产物视图）：`GET /api/runs/:id/diff`（src/run-diff.mjs）——worktree 路径命名形态纵深校验（防记录篡改指路）、scrub 脱敏、200KB 截断标注、无 worktree 422 人话；前端完成/失败卡按钮 + 流内面板（三态如实、换 run 收起、迟到响应丢弃）。
5. **会话聚合扩源 Cursor**（P2，子代理实施主驾复验）：globalStorage state.vscdb 只读（node:sqlite，immutable 回退），composerHeaders 出列表、bubbleId 参数化点查出预览，archived/draft 过滤，cwd 归并同一折叠管线，key 缺失/损坏 fail-closed unavailable。

## 验证（全部实机/实测）

- `node --test` **156/156**（新增 6：run-diff×4 真 git worktree + cursor×2 fake vscdb e2e/fail-closed）。
- Cursor 源实机对账：真库 80 live → 39 条进树 8 项目，标题/时间/cwd 与权威列表 **0 mismatch**；泄密扫描零命中。
- 产物 diff：422（无 worktree）实机 + 真 git worktree 脏/净双态单测。
- 能力图谱：API 实机（21 skill/5 agent/39 MCP 声明）；页面截图复核；泄密扫描 clean。
- qa:ui --suite=all **ok:true**，3 套件 0 JS 错误。

## 边界与待拍板（如实）

- Office 文档 / Chat Channels / Project Boot / Docker：按 v37 文档判定需 LO 单独拍板（凭据/出网面）或低优先，本轮未做。
- MCP 市场安装、Skills 启停：涉及供应链信任与写操作，只做只读面，未做。
- codeg 17 项对照至此：6 已有或更强 / 1 核心缺口（Automations）已补 / 2 低成本（扩源+日志过滤）已补 / 5 候选中 Skills 页+MCP 页+会话扩源已落地，Office/Chat Channels 待拍板 / 3 架构性不做维持。

__DELTA__: 主驾(Kimi) | 1 | 证据：codeg Quick Actions 对标时首版 emoji 用双码点 ZWJ 在主题字体下塌成 ◆（截图实证），修正为单码点稳定字形——补强「视觉复核不可省」的既有纪律
