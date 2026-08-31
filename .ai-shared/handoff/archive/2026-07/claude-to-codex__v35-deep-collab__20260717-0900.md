# 任务卡：v3.5.0 深度对话协作落地 · 治理层独立评审

- **from**: Claude 主驾
- **to**: 烛（codex-reviewer）
- **date**: 2026-07-17
- **mode**: architecture + 交叉引用一致性
- **背景**: LO 要求深度完善 ai agent 体系（Claude↔Codex 对话协作 / 模型优势路由 / 全配置前端）。主驾经 8 路调研 + 端到端实测后落地 v3.5.0。治理层改动按 rules §七 须独立评审。

## 评审对象（本轮全部改动）

1. `I:/514claude/514cc/rules.md` — §三 路由表 v2（新增技术执行者 🟡 行 + 模型优势标注 + 超长文档档）、§四 重写为对话桥三通道、§八 v3.5.0 条目 + 旧版压缩、标题版本号
2. `I:/514claude/514cc/skills/review/codex-reviewer/SKILL.md` — 菜单加 DL 行、"调用 Codex"改三层通道（MCP 主路/exec resume 降级/exec 单发保底 + review profile）、Reflection 迭代改同会话续聊、Gemini 资料→织(grok) 残留清理
3. `I:/514claude/514cc/module.yaml` — version 3.5.0、dependencies codex-cli >=0.144.0、新增 dialog_bridge 节 + control_center 节（YAML 已 python 解析验证通过）
4. `C:/Users/16643/.codex/review.config.toml` + `executor.config.toml` — 新建双 profile（顶层键 sandbox_mode / approval_policy）
5. `I:/514claude/514cc/.ai-shared/roster.json` — 新建会话花名册
6. `I:/514claude/514cc/config/control-center/models.json` — gemini-research enabled→false + governance evidence（validate-control-configs 已通过）
7. `I:/514claude/514cc/CLAUDE.md` + `CHANGELOG.md` — 版本对齐 + v3.5.0 条目
8. `I:/514claude/514cc/proposals/v35-deep-collab-design.md` — 设计文档（新建）

## 主驾已验证的事实（可信基线，不必重验）

- codex mcp-server 双工具 codex/codex-reply 存在、threadId 经 structuredContent.threadId 返回、跨轮记忆有效（PONG-1/PONG-2 端到端实测 2026-07-17）
- claude mcp add codex-agent 注册成功且 Connected
- sync-runtime.ps1 -Apply 三对（rules/agent:codex/co-review）synced and verified
- control-center npm test 46/47（http-e2e 60s 超时为唯一失败）

## 重点照盲区（主驾自评可能漏的）

- A. **profile TOML 键名正确性**：review/executor.config.toml 用顶层键 `sandbox_mode`/`approval_policy`——approval_policy 这个键名主驾未在本机 config.toml 见过实例（config.toml 只有 sandbox_mode）。请验证：`codex exec -p review --skip-git-repo-check "reply OK"` 是否报 unrecognized config？或用 `--strict-config` 验证键合法性。键名错 = profile 静默不生效 = 评审沙箱约束落空（这是安全语义）。
- B. **交叉引用全传播源扫描**（D-2026-07-16-005 元教训：不只 grep *.md）：旧调用方式 `'' | codex exec --skip-git-repo-check` 在活跃治理文件/脚本/hook/*.py/*.toml 里是否还有会"复活覆盖"新姿势的残留（archive/backups/handoff 历史除外）？特别查 sync-cursor-rules.py 类传播源、.cursor/rules、co-review 命令运行时。
- C. **SKILL.md 内部一致性**：失败兜底表（stdin 卡死等）与新三层通道是否矛盾？行为约束"只评审，不生成代码"与新增 executor 角色的边界是否清晰（executor 不属于烛，是否会被误读为烛可写码）？
- D. **rules §三 表格**：新增两行是否与铁律/白发降级/stop-gate FIRE_PREFIXES 兼容（executor 发火的 handoff 前缀是什么？stop-gate 扫得到吗）？
- E. **roster.json**：无 schema 校验、无并发写保护——按 v1 轻量可接受还是致命？

## 产物格式

四节结构（致命/建议/可保留/总评）+ `__VERDICT__` + `__DELTA__`，落 `I:/514claude/514cc/.ai-shared/handoff/codex-to-claude__v35-deep-collab__20260717-HHmm.md`。
