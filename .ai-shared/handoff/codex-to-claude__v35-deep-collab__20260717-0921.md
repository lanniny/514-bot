# Codex 评审：v3.5.0 深度对话协作治理层（architecture 模式）

- **评审模式**：architecture + 交叉引用一致性
- **评审范围**：rules.md §三/§四/§八 · SKILL.md(codex-reviewer) · module.yaml · ~/.codex/{review,executor}.config.toml · roster.json · config/control-center/models.json · sync-cursor-rules.py · .cursor/rules · 双地落运行时
- **评审时间**：2026-07-17 09:21
- **驱动方式**：烛（codex-reviewer subagent）亲验为主（亲读 + Grep 交叉扫描 + 确定性命令）；**A 项经真实 `codex exec` 调用实证**（A1–A4b 输出原文见下，非伪造）；并追加一次**独立 `codex exec -p review` 评审 pass**（session 019f6da5，read-only 沙箱，codex 自行探索文件后独立结论），与亲验**收敛互证**。无 silent fallback。
- **Codex 模型**：gpt-5.6-sol（xhigh，via micu/514claude.xyz）
- **codex-cli**：0.144.1

---

## 致命问题（必须改）

### F1. v3.5 codex 新姿势未传播到 Cursor 双地落，且生成器固化旧姿势自我复活 —— Cursor 主驾评审丢失 read-only 沙箱（B 项确证）

**证据链**：
- 主 Claude 运行时**已正确**：`~/.claude/agents/codex-reviewer.md:93,102,107` 与 `~/.claude/commands/co-review.md:93,102,107` 均为新 `-p review` 姿势 → sync-runtime.ps1 -Apply 已兑现。
- Cursor 双地落**STALE 且自我复活**：
  - `scripts/sync-cursor-rules.py:134`（capabilities 模板）+ `:231`（bootstrap 模板）**硬编码旧姿势** `'' | codex exec --skip-git-repo-check "..."`（无 `-p review`），`deploy()`(:196-207) 写入 `.cursor/rules/514cc-capabilities.mdc` + `USER-RULES-paste-into-settings.txt`。
  - `.cursor/rules/514cc-constitution.mdc:70` 亦为旧姿势 `'' | codex exec --skip-git-repo-check "<prompt>"`（Cursor 侧 §四停留在 v3.4 语义，未反映 v3.5 对话桥/双 profile）。
  - `skills/review/codex-reviewer/customize.toml:73` `invoke_pattern` 仍无 `-p review`（烛 skill 自身配置的命令源）。
- **后果**：514cc/CLAUDE.md 明确 Cursor 为一等主驾入口；Cursor Agent 按旧姿势调 Codex 评审 → **拿不到 read-only 沙箱机械保证**（正是 A 项担心的"profile 静默不生效"在 Cursor 侧真实发生）。且重跑 sync-cursor-rules.py 会**覆盖任何手工修复**（复活覆盖）。
- **独立 codex Q2 收敛**：codex 独立判定"必须修……生成的 Cursor rules 已实际携带旧命令，Cursor 主驾调用时会绕过只读保障"，并把 customize.toml:73 一并纳入致命命令源。
- **修复方向**：sync-cursor-rules.py 模板 134/231 改 `-p review` + 补对话桥/executor 说明 → 重跑重生成 `.cursor/rules`；同步 customize.toml:73 invoke_pattern；更新 `resources/powershell-invoke.md`（含 line 13 未关 stdin 变体）与 `soul/CLAUDE.md:39`；采纳 codex 建议：加"评审命令必须含 `-p review`"的生成回归检查（单一命令源 + lint）。

---

## 建议改进（值得讨论）

### S1.（A 副产）base config.toml 首字段令 `--strict-config` 全局不可用
`C:\Users\16643\.codex\config.toml:1` 的 `disable_response_storage` 不被 codex 0.144.1 `--strict-config` 识别（实测 A1 即在此行报 unknown field 中止）。正常（非 strict）运行不受影响，但想用 `--strict-config` 做 profile 键回归校验时会被 base 挡。建议核实该字段是否 legacy/改名，清理后即可用 strict 做机械回归。

### S2.（A 副产）executor profile 继承 base 网络访问
实测 A4b：`-p executor` → `workspace-write [workdir,/tmp,$TMPDIR] (network access enabled)`——继承 base `[sandbox_workspace_write] network_access=true`。executor 兼具写工作区 + 网络，设计上靠主驾派工前守（宪法 §二），但 workspace-write+网络的技术执行者值得在 rules §四/roster 显式知会其权限面。

### S3.（C）SKILL 失败兜底表未含 MCP 主路失败项
`SKILL.md:171-178` 兜底表仍是 CLI 时代项（stdin 卡死/401/504/无四节）。新主路是 MCP 对话桥，但兜底表无 threadId 失效 / `codex-agent` server 未注册或不可用 / codex-reply 失败行。§3 通道链已定义 MCP→exec resume→exec 单发降级，兜底表补一行 MCP 路失败即闭环。

### S4.（C）executor 与烛的边界建议显式化
烛 SKILL 全程只用 `-p review`，executor 是独立角色（roster `codex-executor`／rules §三行，命名"Codex 技术执行者"≠烛），边界基本清晰。建议在 SKILL"行为约束"显式加一句"executor profile 不属于烛，烛只用 review"做纵深防御，防 rules §四并列两 profile 被误读为"烛可写码"。

### S5.（D）executor 发火的 DELTA 未被 stop-gate 机械覆盖
stop-gate `FIRE_PREFIXES=("codex-to-","gemini-to-","grok-to-","synthesis__")`。若 executor 产出 `codex-to-claude__*` handoff 则被扫到（OK）；但 executor 本质是写码者，主产物是代码 diff 而非评审 handoff——若不落受控前缀 handoff，stop-gate 无文件可扫，DELTA 退回"主驾自觉 append decisions.md"软路径（正是 stop-gate 想硬化的对象）。建议：明确 executor 发火须落 `codex-to-` 前缀小结 handoff 以进入门禁覆盖。另注：executor 是 🟡，受白发降级（DELTA=0 连续→降级直达）；review 是 🔴 永不降——executor 可降级属设计内，但值得知会。

### S6.（E）roster.json v1 加固项
无真 `$schema` 校验（仅 `$schema_note` 说明）、无并发写保护，与 control-center configs（models.json 有真 $schema + validate-control-configs）不一致。单主驾顺序写可接受；风险在 party-mode 并行 spawn 多 agent 并发写 roster（低概率，写在召唤边界）。建议后续加轻量 schema + 原子写（temp+rename）+ party-mode 写串行化。不阻塞 v1。

---

## 可保留（看似奇怪但合理）

- **独立 .config.toml 文件 + 顶层键 + `-p <name>` 叠加**：A 项主驾担心"approval_policy 键名非法/静默不生效"——**实测证明设计正确可靠**。`codex exec --help` 原文：`-p, --profile <CONFIG_PROFILE_V2>  Layer $CODEX_HOME/<name>.config.toml on top of the base user config`。这是 codex 0.144 的 Profile V2 机制，独立文件+顶层键正是正确用法（非旧版 `[profiles.x]` 嵌套）。实测生效（见下）。codex 独立 Q1 同判"设计正确、可靠"。
- **executor `approval_policy=never`**：写权限靠 workspace-write 沙箱边界约束，审批免打扰由主驾派工前二次确认兜（宪法 §二），职责分层合理。
- **models.json `gemini-research enabled:false` + governance evidence**：对齐 D-2026-07-16-005，带 verifiedAt 与再启用需新决策记录的注记，治理留痕规范。

### A 项实测命令输出（原文摘录，证据）
```
# A1  '' | codex exec -p review --strict-config --skip-git-repo-check "reply exactly OK"
Error loading config.toml: C:\Users\16643\.codex\config.toml:1:1:
  unknown configuration field `disable_response_storage`     ← 卡在 base 首字段，未及 profile 键

# A3  '' | codex exec --ignore-user-config -p review --strict-config ...
  approval: never
  sandbox: read-only          ← profile 键通过 strict 校验；随后仅因忽略 base 丢 micu provider 而 401

# A4  '' | codex exec -p review --skip-git-repo-check "reply exactly OK"   （生产姿势，base+profile 叠加）
  provider: micu / approval: never / sandbox: read-only     ← 覆盖 base 的 workspace-write，EXIT 0，回 "OK"
# A4b -p executor
  approval: never / sandbox: workspace-write [workdir,/tmp,$TMPDIR] (network access enabled)
```
结论：`-p review` 键名合法、机械生效为只读、正确覆盖 base workspace-write。**A 项无致命，设计正确。**

---

## 总评

v3.5 治理层核心设计**成立且经实证**：双 profile（review=read-only+never / executor=workspace-write）用 Codex Profile V2 正确落地，A 项"疑似风险"被实测钉成"已验证正确"。唯一致命是 **B 项传播缺口**——新姿势只落到 Claude 运行时，Cursor 双地落 stale 且生成器（sync-cursor-rules.py）固化旧姿势，导致 Cursor 主驾评审丢失只读沙箱且修复会自我复活。此为 must-fix。C/D/E 为一致性/加固建议，不阻塞。修 F1（生成器 + Cursor 双地落 + 单一命令源回归检查）后 v3.5 治理面即闭环。

---

## 下游建议
### 建议召唤
- 修 F1 后建议烛二评一次 Cursor 双地落（确认 sync-cursor-rules.py 重生成的 .cursor/rules 已带 `-p review` + 对话桥）。
### 风险信号
- Cursor 侧只读沙箱丢失属安全语义回归（虽为次级入口），优先级高于 C/D/E。

__VERDICT__ (Round 1): CHANGES_REQUESTED
__DELTA__: v3.5治理层(profile/对话桥/路由表/roster) | 1 | security | 补强主驾：A 从"疑似键名非法风险"实测钉为"设计正确"（A4 banner sandbox:read-only 覆盖 base workspace-write）；B 从"待查残留"确证为致命传播缺陷（scripts/sync-cursor-rules.py:134,231 + skills/review/codex-reviewer/customize.toml:73 + .cursor/rules/514cc-constitution.mdc:70）

---

## 二评 Round 2（F1 修复验证 · 2026-07-17 09:32 · 轻量确定性亲验，未跑 codex exec）

主驾按 F1 修复方向落地，逐项确定性复核如下——**F1 致命已闭环，无新致命**。

**A) 三处 .cursor/rules 全部新姿势、无旧残留 ✓**
- `~/.cursor/rules`、`514cc/.cursor/rules`、`I:/514claude/.cursor/rules` 三地 `514cc-capabilities.mdc:16-17` 均为「MCP 对话桥 `codex-agent` 优先 + CLI 降级 `-p review`」并新增 executor 行（`-p executor`，workspace-write+网络已标注）；`514cc-constitution.mdc:75` §四重写为 `codex exec --json -p <profile> --skip-git-repo-check` + `exec resume`，v3.4 旧 §四语义已消除。三地一致。

**B) bootstrap 同步 ✓**
- `~/.cursor/USER-RULES-paste-into-settings.txt:18` = `codex exec -p review`（read-only 沙箱机械保证）+ 技术执行 `-p executor` + MCP 对话桥优先。无旧姿势。

**C) verify_review_profile() 正则经回溯验证——不误伤合法、覆盖现实回退 ✓（一条 minor 加固建议）**
- 正则 `codex exec (?!-p )(?!resume)(?:--json )?--skip-git-repo-check`（sync-cursor-rules.py:261），扫 `rules` 生成物 + bootstrap，命中即 `SystemExit` 硬失败，已焊入 main()。
- 逐形回溯：`codex exec -p review --skip`→`(?!-p )` 拦截**不误伤** ✓；`codex exec --json -p <profile> --skip`（constitution.mdc 实际形态）→`--json` 消费后 `-p` 破坏 `--skip` 邻接，**不误伤** ✓；`codex exec resume`→`(?!resume)` 拦截**不误伤** ✓；旧 `codex exec --skip` 与 `codex exec --json --skip`（无 profile）→**均命中硬失败** ✓。这正是重跑输出 `regression check ... OK` 的原因（生成物已全 `-p review`）。
- **minor 建议（非阻塞）**：正则依赖规范顺序（`-p` 先于 `--skip`、`--json` 紧邻 `exec`）。非常规顺序 `codex exec --skip ... -p review` 会**误报**，而 `codex exec --sandbox workspace-write --skip`（评审语境用错沙箱、非模板故障模式）会**漏报**。当前生成物均规范，无实际影响；若日后模板演化可加一条"评审命令必须含 `-p review`"的正向断言互补。

**D) 活跃区 grep 无残留 ✓**
- 以只命中旧姿势的正则 `codex exec (--json )?--skip-git-repo-check` 全库扫描：所有命中落在**排除区**（`.ai-shared/backups/*`、`.ai-shared/tmp/*`、`.ai-shared/handoff/*` 历史含本 handoff 引用、`lilith/*` 基准显式 `--sandbox` 命令）。唯一活跃命中 = `sync-cursor-rules.py:259`，为 verify_review_profile() **自身 docstring** 描述"旧姿势"用于说明（非可部署命令、不自扫），属良性。**活跃治理/运行时零旧姿势残留。**
- 配套修复亦确认：`customize.toml:74` `-p review` ✓；`resources/powershell-invoke.md` 5 处全 `-p review` ✓；`soul/CLAUDE.md:39` 对话桥+`-p review` ✓；主 Claude 运行时 `~/.claude/agents+commands` 保持 `-p review` ✓。

**S3/S4/S5 采纳**：本轮聚焦 F1 传播闭环，未逐字复核 SKILL 兜底表/rules §四 executor 网络面文案（主驾自述已加），如需可另起轻量核对。

**结论**：F1 传播缺陷已完整修复且以 `verify_review_profile()` 机械扳机防复活；「Cursor 主驾评审丢 read-only 沙箱」风险消除。R1 唯一致命关闭，升级为 APPROVED。

__VERDICT__ (Round 2, supersedes R1): APPROVED
__DELTA__ (Round 2): F1修复(生成器模板+回归扳机+双地落传播) | 0 | 白发确认：三地 .cursor/rules+bootstrap+customize+powershell+soul 全 `-p review`，D 扫活跃区零残留，verify_review_profile 正则不误伤合法/覆盖现实回退（唯 1 条 minor 顺序敏感加固建议，非阻塞）
