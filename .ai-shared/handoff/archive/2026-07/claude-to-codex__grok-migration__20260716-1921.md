# 任务卡：烛评审 grok 换驱动（织：gemini→grok-4.5，framework dogfood）

- **From**：Claude（主驾）
- **To**：烛（codex-reviewer）
- **时间**：2026-07-16 19:21
- **模式**：architecture + security（框架非平凡改动 dogfood，rules §七.6）
- **背景**：LO 指令把织（情报官）驱动从 Gemini CLI 换成 **grok-4.5**（via 514claude.xyz OpenAI 端点），完全替代 gemini，key 走环境变量 `GROK_API_KEY`。grok-4.5 端点已冒烟验证 http 200。

## 变更清单（已落地）
- 新 skill：`skills/research/grok-researcher/`（SKILL.md + customize.toml），driver=grok-4.5 curl
- 删旧：`skills/research/gemini-researcher/` + `~/.claude/agents/gemini-researcher.md`
- 新运行时：`~/.claude/agents/grok-researcher.md`（双地落）
- 治理：module.yaml(2 注册+依赖) / rules.md(花名册:13/路由:47/外部CLI:66/铁律3:58) / stop-gate.py+mirror-gate.py(FIRE_PREFIXES 加 grok-to-) / CLAUDE.md
- 交叉引用：13 活跃文件 gemini-researcher→grok-researcher + Gemini CLI→grok-4.5（历史 decisions/CHANGELOG/archive/backups/handoff **有意保留不改**=证据链）
- 环境变量：`setx GROK_API_KEY`（用户级）

## 评审重点
1. **无遗留活跃 gemini 引用**：历史留对，活跃是否清干净？（grep 验证 skills/ + 治理文件，排除 archive/backups/handoff/decisions/CHANGELOG）
2. **key 安全（红线）**：SKILL.md / customize.toml / rules / 运行时 agent 是否**绝不硬编码 key 明文**，只引用 `$GROK_API_KEY`？
3. **双地落一致**：仓库 `grok-researcher/SKILL.md` ↔ 运行时 `~/.claude/agents/grok-researcher.md` 内容是否一致？
4. **grok 调用正确**：endpoint(`/v1/chat/completions`)/model(`grok-4.5`)/key_env 正确；curl 用 `jq` 安全拼 JSON（防特殊字符注入）？
5. **handoff 前缀**：`grok-to-` 加入 stop-gate/mirror-gate `FIRE_PREFIXES`；`gemini-to-` 保留识别历史——两 hook 一致？
6. **silent fallback 红线保留**：grok 失败是否绝不伪造（3a 失败处理）？
7. **WR 搜索诚实**：反代 grok Live Search（`search_parameters`）待验证的标注是否诚实（不假设透传）？

## 产物
四节 + `__VERDICT__`（SECURE/NEEDS_HARDENING）+ `__DELTA__`，落 `codex-to-claude__grok-migration__20260716-*.md`。

## 诚实要求
- 返回前 Read/ls 核验 handoff 真落盘（R4 教训）。
- **key 评审时绝不在 handoff 回显 key 明文**（只说"环境变量引用正确/无硬编码"）。
- 只读评审，不改文件；评审前后取 sha256。
- Codex timeout → resume 补完，别赌卡死（R7 教训：可用确定性脚本 grep/diff 验证）。
