# 烛·评审：grok 换驱动（织 gemini→grok-4.5，framework dogfood）

- **评审模式**：security + architecture（框架非平凡改动 dogfood，rules §七.6）
- **评审范围**：grok-researcher skill + 双地落 agent + 治理文件 + 2 hook + 跨运行时引用
- **评审时间**：2026-07-16 19:45
- **评审方法**：**确定性脚本亲验（grep/diff/sha256/ls）** — 前两个烛实例卡死于 Codex 大调用，本实例改用脚本破局，未依赖 Codex CLI 推断（亲验 > LLM 推断，证据更强）
- **评审前后 sha256（只读评审，未改任何被评审文件）**：
  - `SKILL.md` / 运行时 `agent.md` = `533a5356f5611f0f0a10be3f6570f90511a4b6e38ac9b50727879dc77a609f37`（**双地落字节级相同**）
  - `customize.toml` = `0c4d8174e8e2517d0ec288ac73eb547dc6fc71c0d8f4a6069a5f311712837f91`

---

## 致命问题（必须改）

### F1 · sync-cursor-rules.py 是"复活旧引用"的传播源（迁移完整性致命）

`scripts/sync-cursor-rules.py` 三处**硬编码**旧引用，且经 `deploy()` 主动写入 Cursor 规则：

- **L135**（`caps` 模板）：`织 gemini-researcher | Gemini CLI 或 gemini-researcher skill` — 既是旧名，又硬编码**旧驱动"Gemini CLI"**（与迁移目标 grok-4.5 直接功能矛盾）
- **L147**（`caps` 模板）：`co-research | gemini-researcher | 织情报摘读`
- **L224**（`write_user_rules_bootstrap` 模板）：`🔴 必须发火：烛(codex-reviewer) / 织(gemini-researcher)`

**传播机制（已读脚本验证，非推测）**：`main()`→`deploy(build_rules())` 把这些模板写入 **3 个 DEPLOY_TARGETS**（L17-21：`~/.cursor/rules` 全局User Rules〔任意工作区生效〕+ `514cc/.cursor/rules` + 父工作区`.cursor/rules`）+ `write_user_rules_bootstrap` 写 `~/.cursor/USER-RULES-paste-into-settings.txt`。

**危害**：只要 LO 下次运行 `python sync-cursor-rules.py`（脚本 L189/索引仍在推荐它作为标准维护命令），gemini-researcher + "Gemini CLI 驱动" 就被**复活写进 Cursor 全局规则并覆盖手工修正**。修 Cursor 侧 .mdc 无效——必须修脚本源头 L135/L147/L224。这是时间炸弹，非静态残留，故列致命。

---

## 建议改进（值得讨论）

### S1 · Codex 运行时 agent 定义未迁（命名漂移）

`.codex/agents/gemini-researcher.toml`（mtime 6-16，**未随本次 7-16 迁移更新**）：`name = "gemini-researcher"`，文件名+name 字段仍旧名。同目录另 4 个 agent toml 齐全，唯织未改名。`.codex/CLAUDE_SYNC.md` 已提 grok-researcher 但 toml 没跟改 → Codex 侧双地落不一致。
- 缓解事实：该 toml 的 `developer_instructions` **驱动无关**（只说"Prefer MCP/docs/web"，未硬编码 Gemini CLI），故 Codex 侧织不会真误调 gemini，功能影响有限，主要是花名册命名漂移。
- 建议：重命名为 `grok-researcher.toml` 且 `name = "grok-researcher"`，与 Claude 侧双地落对齐。

### S2 · lilith 运行时映射未迁

`lilith/runtime-map.yaml:53`：`researcher: "织/gemini-researcher"`（活跃 agent_council 映射）。lilith 侧完全未迁（[1c] 正向扫描该文件无 grok-researcher）。建议改为 `"织/grok-researcher"`。严重性取决于 lilith 子系统当前活跃度——请主驾确认后定档。

### S3 · 多模态 jq 拼接未给完整安全示例

SKILL.md L58-59 vision 段仅注释形式给 OpenAI image_url 格式，未示范 base64 图片如何用 jq 安全拼 JSON。文本路径（L50-54）已正确用 `jq -n --arg p` 防注入，多模态路径建议补一句"同样 jq --arg 拼 content 数组"，避免主驾实操时手拼字符串引入注入面。（非致命：当前仅示例说明，无实际调用代码）

---

## 可保留（看似奇怪但合理）

1. **backups/ 下历史文件仍含 gemini-researcher**（claude-runtime/codex-runtime/repair 快照）— 证据链快照，任务卡明确"有意保留不改"，正确。
2. **decisions.md / CHANGELOG.md 含 gemini-researcher** — 记录 gemini→grok 迁移决策/版本历史必然提旧名，合理保留。
3. **两 hook FIRE_PREFIXES 口径不同**：stop-gate.py:33 = `(codex-to-, gemini-to-, grok-to-, synthesis__)`；mirror-gate.py:41 = `(codex-to-, gemini-to-, grok-to-)`（无 synthesis__）。mirror-gate.py:40 **有注释明示"有意不同口径，非疏漏"**（v3.3 历史设计）。两处均已含 `grok-to-`（新驱动发火）+ 保留 `gemini-to-`（识别历史 handoff），符合任务卡第5点。诚实标注，保留。
4. **WR 段 Live Search 待验证标注**（SKILL.md L62）：明确写"反代是否透传 grok 原生 `search_parameters` 待验证 / 不假设、不伪造 / 当前用 grok 推理+web MCP 兜底"。高度诚实，完全符合 Integrity Gate，保留并表扬。

---

## 总评

**七点核验：6 PASS / 1 FAIL。安全红线全数守住，迁移完整性有跨运行时缺口。**

| # | 评审点 | 结论 | 证据 |
|---|--------|------|------|
| 2 | key 红线 | ✅ PASS | 明文扫描 exit=1（零命中）；Authorization 唯一写法 `Bearer $GROK_API_KEY`（变量非明文）；GROK_API_KEY 引用三处齐全。**未回显任何明文 key** |
| 3 | 双地落一致 | ✅ PASS | sha256 **字节级相同** `533a5356…`；正文 diff 无差异；frontmatter 一致 |
| 4 | grok 调用正确 | ✅ PASS | endpoint `/v1/chat/completions`、model `grok-4.5`、key_env `GROK_API_KEY` 齐；文本路径 `jq -n --arg p` 安全拼 JSON 防注入 |
| 5 | FIRE_PREFIXES 一致 | ✅ PASS | 两 hook 均含 grok-to-+gemini-to-；口径差异有注释说明 |
| 6 | silent fallback 红线 | ✅ PASS | SKILL 3a + customize `silent_fallback_forbidden=true` + 行为约束 L133：grok 失败落 grok-error handoff，绝不伪造训练知识 |
| 7 | WR 搜索诚实 | ✅ PASS（优秀） | Live Search 透传"待验证"诚实标注，web MCP 兜底，不假设不伪造 |
| 1 | 活跃 gemini 清干净 | ❌ **FAIL** | 排除历史后仍 3 处活跃残留：`sync-cursor-rules.py:135/147/224`（传播源，F1）、`.codex/agents/gemini-researcher.toml`（S1）、`lilith/runtime-map.yaml:53`（S2） |

**结论**：Claude 主运行时（`~/.claude/agents/grok-researcher.md`）迁移正确、安全红线全守住、双地落完美。但任务卡"完全替代 gemini / 13 活跃文件已改干净"的声称**不成立**——多运行时视角（Codex / lilith / Cursor 同步脚本）有系统性遗漏。**F1（sync-cursor-rules.py）须优先修**，否则迁移成果会被下次同步命令复活覆盖。补齐这 3 处即可升 SECURE。

**对抗式自检**：本次非 0 发现（1 实质 FAIL + 3 建议），健康。盲区自查：backups/decisions/CHANGELOG 的 gemini 命中已逐一确认为合理历史保留，非漏判。

---

## 下游建议

### 建议召唤
- 修完 F1/S1/S2 后，可让主驾自行 grep 复验（`grep -rl gemini-researcher <三处> ` 应空），无需再召唤烛。
- 若 lilith 子系统状态存疑（S2 定档），可问主驾 lilith 当前是否活跃运行时。

### 风险信号
- **传播源类残留**（F1）优先级高于静态残留：静态残留是一次性清理，传播源会持续复活。以后类似"改名/换驱动"迁移，应先 grep 所有 `scripts/*.py` 内嵌模板 + 各运行时 agent 定义目录（`.codex/agents/`、`~/.claude/agents/`、`lilith/`），把"生成源"纳入清单。
- 本次证明：主驾单人"改 13 个文件"仍漏 3 处跨运行时引用——多运行时体系的迁移，天然需要独立扫描兜底盲区。

__VERDICT__: NEEDS_HARDENING
__DELTA__: grok 换驱动迁移完整性评审 | 2 | 推翻主驾"13 活跃文件已清干净/完全替代 gemini"判断：照出 3 处活跃残留 scripts/sync-cursor-rules.py:135/147/224(传播源，会复活旧名+旧Gemini驱动写入Cursor全局规则) + .codex/agents/gemini-researcher.toml + lilith/runtime-map.yaml:53
