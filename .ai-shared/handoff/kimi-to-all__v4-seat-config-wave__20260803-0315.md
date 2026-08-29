# 席位配置面完善波（Kimi → all）

> 时间：2026-08-03 · 主驾：Kimi · 范围：apps/control-center 运行席位编辑器（adapters/manifest.mjs / runtime-seat-manager.js / index.html / app.js / forge/data.css）+ proposals/multi-cli-adapter-eval.md + scripts/qa-team-workspace.mjs
> 触发：LO「运行席位设计不合理——新建席位职责默认 team-executor 可以不用；Adapter 模板混入 Grok Search MCP，正常应只有 CLI 后端（claude code / codex / grok build / kimi code / pi / opencode / openclaw / hermes / CodeBuddy / cursor）；其他配置继续完善」

## 一、需求拆解

逆序从「LO 新建席位的第一键」往回推：①职责预填 team-executor 是臆造默认值，去掉；②Adapter 下拉混入 MCP 通道（Grok Search MCP 不是 CLI 执行后端），清出可选项；③LO 点名的 5 个 CLI（opencode/openclaw/hermes/CodeBuddy/cursor）本机全部 NOT FOUND 且无 adapter 实现——不伪造假模板，诚实落评估文档 + 编辑器边界注记。

## 二、落地内容

- **职责不再预填**：blankSeat role 默认空 + placeholder 明示必填；既有席位 distinct roles 灌 datalist，建议不抢键。
- **Adapter 下拉只列 CLI 执行后端**：manifest 给 grok-mcp-via-codex-app-server 加 `selectable: false` + controlNote；catalog 全量返回（详情渲染需要），服务端写路径 selectable 校验不破；新建下拉 6 项（claude/codex/gemini/grok-build/kimi/pi），系统席位绑非可选通道时追加「（内置席位专用）」标记项。编辑器底部边界注记如实说明 5 CLI 现状，指向 `proposals/multi-cli-adapter-eval.md`（逐家协议调研带出处 + 四步接入路径 + 落地顺序 OpenCode→Cursor→OpenClaw/Hermes→CodeBuddy）。
- **席位品牌徽标**：席位目录行换品牌 SVG logo（seatBrand 前缀映射 + data-brand 走全局 --agent-accent），与成员库同一视觉语言。
- **绑定成员区块**：编辑器新增绑定条——chip 直达成员库编辑器，空态区分「保存后才会出现/未被绑定可安全删除」，删除确认与 title 点名绑定成员（对称服务端 MEMBER_IN_USE 拦截）。

## 三、探针挖出的深层真问题（已修）

- **绑定区块旧空态不自愈**：bootstrap 慢聚合，编辑器先于目录打开时「未被任何成员绑定」一直撒谎。新增 `refreshBindings()`，extractBootstrapData + member-library onCatalogChanged 双接线自愈。
- **隔离 QA 环境 jsonschema 瘫痪**：createIsolatedQaRepo 重定向 APPDATA 后 python 用户站点丢失，配置写路径 schema 校验必崩（保存席位 422）。QA 脚手架新增 seedIsolatedPythonUserSite 补种校验必需包——校验真实可用而非绕开；既有 qa:team 隔离流同步受益。真实桌面环境（APPDATA 正常）本就不受影响。
- **顺手**：runtime-seat-id-input pattern 在 Chrome /v 正则模式非法（控制台噪音）→ 转义修复。

## 四、验证证据

- `npm test`：656 pass / 0 fail / 1 skipped；`npm run validate`：13 valid。
- `scripts/qa-seat-wave-probe.mjs`（隔离实例）：7 席位全品牌 logo；新建下拉 6 项无 Grok Search MCP、职责空默认、datalist 7 建议、边界注记含 CodeBuddy；codex-technical 绑定 chip「Codex 技术执行（内置）」；grok-search 选中项「（内置席位专用）」；新建探针席位保存 201 激活、空绑定态+删除 title 如实；明暗截图 `.qa-v4/seat-wave-*.png` 亲查；控制台 0 错误。

## 五、边界与回退

- 未给 5 个未验证 CLI 伪造 Adapter 模板——接入走评估文档路径，过本机验证后再进 manifest。
- gemini-stream-json 模板保留（gemini-research 内置席位仍绑定，LO 未要求删除）。
- 桌面端 Ctrl+R 生效；预览实例 :5520 已停（桌面端占实例锁）。
- 回退 = 还原 manifest.mjs selectable / runtime-seat-manager.js 本波段 / index.html 绑定区块与 datalist / app.js refreshBindings 接线 / forge/data.css 席位波段 / qa-team-workspace.mjs 补种函数 / 删 qa-seat-wave-probe.mjs 与评估文档。

## 六、追记：Adapter 模板 CLI 命名 + 品牌图标（2026-08-03，LO「模板名字很变扭，直接用后端 CLI 名字命名比如 claude code，并且配备图标」）

- **label 全改 CLI 本体名**（id/协议锚点不动）：Claude Code / Codex / Codex（exec 回退）/ Gemini CLI / Grok Build / Kimi Code / Pi；Grok Search MCP 保留（MCP 通道如实命名）。协议细节留 description。label 经 bootstrap/adapterLabel 全链传播——席位目录副标题、下拉、成员库详情、斜杠目录同步换新；全仓无 label 断言，测试原样通过。
- **编辑器 Adapter 字段配官方徽标**：select 左侧品牌 icon chip + 详情卡「执行后端」内联 logo 品牌色；renderTemplateDetails 单点同步，新建/切换/编辑全跟随（实测切 Kimi Code 图标跟随）。
- 验证：qa-seat-wave-probe 重跑全断言通过 0 控制台错误；`.qa-v4/seat-adapter-field-light.png` 亲查；`npm test` 656 pass / 0 fail。回退 = 还原 manifest.mjs 8 条 label + renderTemplateDetails 图标段 + index.html adapter-picker 包裹 + forge/data.css 命名波段。

__DELTA__: Kimi | 1 | correctness | 证据：manifest.mjs selectable:false 清出 MCP 通道 + 8 条 label 改 CLI 本体名 + runtime-seat-manager.js refreshBindings 自愈绑定旧空态与 Adapter 字段品牌徽标 + qa-team-workspace.mjs seedIsolatedPythonUserSite 修复隔离环境 schema 校验瘫痪，探针实证新建下拉 6 项纯 CLI、绑定 chip 自愈、席位保存 201，0 控制台错误
