# 团队配置便利层波：预设模板 + 团队包导入导出（Kimi → all）

> 时间：2026-08-02 · 主驾：Kimi · 范围：apps/control-center 团队配置面（team-config-kit.js / app.js / index.html）
> 触发：LO「检查团队配置模式我需要方便配置并且需要能够高度自定义请你继续优化和完善」

## 一、深查结论（为什么只做这两个增量）

- 团队存储在运行时 `teams.json`/`team-members.json`，游离于 schema/配置图谱/validate 之外；teams.mjs/team-members.mjs CRUD 内核已经过多轮评审冻结，不动。
- 前端其实已有表单/成员库/席位管理，但缺：①快速起步路径（从空白手填几十个控件）②迁移/备份/分享手段。
- 按团队路由权重覆盖、任意 CLI 纯配置接入属内核/adapter 层改动，本波不碰（前者是冻结面，后者受 adapter manifest 接线约束，decisions.md D-2026-07-28-001 有账）。

## 二、落地内容

- **预设模板**：`public/modules/team-config-kit.js` 纯函数模块——研发攻坚团/评审团/研究写作团/全栈混编团，成员配比+主脑+协作风格提示词；`resolvePreset` 按本机目录过滤缺席席位、主脑回退、gemini 禁用席位零引用；skills/mcp 留空不臆造。头部「预设」下拉套用成草稿，可改后保存。
- **导出**：`buildTeamPack` → `514cc-team-pack` v1 JSON；自定义成员带完整定义，内置席位只带引用，幽灵席位不背包；有草稿时如实提示导出的是已保存版本。
- **导入**：`parseTeamPack` 中文逐条报错；`planMemberResolution` 同 id → 孪生复用 → 新建（逐成员失败如实跳过）→ 内置缺席报告；`remappedTeamPayload` 失败关闭（全灭 null 中止）；重名加「（导入）」。
- **目录竞态守卫**：预设套用时席位目录未就绪（见三）则轮询至多 12s 自动套用，超时才放弃——绝不套空目录假草稿。

## 三、顺带发现的既有系统性现象（未修，记账）

`/api/bootstrap` 在启动期被长连接（SSE/PTY/run bus 流）挤占浏览器连接池，实测迟到 6.6s（预览实例）~8s（隔离实例）才完成；期间团队表单成员区是禁用占位（"成员目录加载中"），席位目录、能力目录、模型联动全部推迟。这是全局面问题（不只团队面），修复方向在 SSE 合流/请求优先级，建议立项。另观测到一次隔离实例下目录就绪后短暂回落（未复现机制，idle 与 live  timeline 均稳定），预设守卫已能吸收。

## 四、验证证据

- `npm test`：656 pass / 0 fail / 1 skipped（新增 tests/team-config-kit.test.mjs 6 项纯函数测试）。
- `npm run validate`：13 valid。
- `scripts/qa-team-config-kit-probe.mjs`（隔离实例）：预设套用 3 成员+Codex 主脑 → 保存 → 导出 builtinRefs=3 → 导入全员复用+重名避让 → 坏包诚实报错；明暗截图 `.qa-v4/team-kit-*.png` 亲查；0 控制台错误。
- 自修两处实现 bug（探针当场抓获）：unwrapList 字符串键误用（utils 契约是数组）致导出恒空；编辑误删 payload 声明行。

## 五、边界与回退

- 未动 teams.mjs/team-members.mjs/server.mjs 任何逻辑；导入走既有 POST 端点，逐成员失败如实上报。
- 预览实例 :5520 保留；桌面端 Ctrl+R 生效；未做 runtime sync/桌面重启。
- 回退 = 删 modules/team-config-kit.js + app.js 接线段 + index.html 四处控件 + tests/team-config-kit.test.mjs。

__DELTA__: Kimi | 1 | performance | 证据：team-config-kit.js + app.js:4457-4600 预设/导入导出落地，探针实测导出 builtinRefs=3、导入全员复用零新建、坏包中文报错；另实证 bootstrap 启动期被长连接挤占 6.6-8s 的既有系统性降级并记入债务
