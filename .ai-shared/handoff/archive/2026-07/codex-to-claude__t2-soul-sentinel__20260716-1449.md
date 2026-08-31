# Codex 评审：T2 SOUL 全局哨兵（reflection R2 · dogfood + 故障注入）

- **评审模式**：security / architecture（安全 hook 改动 + 全局化设计缺陷；AD-3 强制 dogfood）
- **评审范围**：`I:/514claude/514cc/.claude/hooks/mirror-gate.py`（改后 308 行）——`check_soul_drift()`(:165-190) + `build_card` SOUL 行(:193/:217-237/:250) + `main()` SOUL 全局段(:256-303)
- **评审时间**：2026-07-16 14:49
- **Codex 模型**：gpt-5.6-sol（micu provider，reasoning effort xhigh，sandbox workspace-write）
- **总 token**：主评审会话 ~1,593,708（含大量 cached）+ resume 补完 126,896
- **驱动**：烛（codex-reviewer）；四节正文由 Codex 独立产出（含 19 项可执行故障注入实测），交叉验证注记/发现归属/下游建议由烛综合
- **轮次**：reflection R2（对照 R1 `codex-to-claude__soul-double-landing__20260716-0658.md` 的 4 致命）
- **主评审 stdout 被 harness 600s timeout 截断**（未影响实测完成），最终四节经 `codex exec resume -o` 从同一会话完整补出——非重跑、非伪造，实测 context 连续。

---

## 致命问题（必须改）

1. **致命2未完全修复：SOUL 只做到"计算全局"，没有做到"告警输出全局"。**
   `mirror-gate.py:263-276` 在 cwd 门控前调用 `check_soul_drift()`，但告警送达仍依赖后续项目分支：只要 cwd 命中 `WORKSPACE_ANCHOR`，就必须成功找到 `.ai-shared` 才会输出。`find_aishared()` 返回 `None` 时，`:275-276` 直接退出，已计算出的 drift/unverifiable 被静默丢弃。

   故障注入 3 个触发面均复现（同一根因）：
   - `cwd=I:/514claude-backup/xyz`、`soul=drift`、`find_aishared=None`：exit 0，stdout 为空。
   - 合法 `I:/514claude/new-project`、尚无 `.ai-shared`、`soul=unverifiable`：exit 0，stdout 为空。
   - 合法 JSON 但 `cwd=514`（整数）：`:267` 调用 `cwd.replace()` 抛异常，被 `:299-302` 的 fail-open 吞掉，exit 0，stdout 为空。

   三场景根因同一：**SOUL 告警输出仍耦合于项目 cwd 分类、账本发现和项目卡片流程**。直接违反"SOUL 全局告警独立于 cwd 门控、所有工作区送达"的 P0 验收条件（策 §5.5.1），定性为**阻断 T2 验收的致命问题**。但它不覆盖文件、不阻断会话，故整体未上升为 CRITICAL。

2. **最小修复方向：拆开"全局告警送达"和"项目体检卡构建"。**
   在 `mirror-gate.py:263-277` 先规范化 cwd（非字符串一律按空字符串处理），随后保存一个可独立输出的 `soul_warning`。非 514、anchor 命中但无 `.ai-shared`、或项目卡片构建失败时，只要 `soul_state != "consistent"`，都应输出该全局告警后 exit 0。只有 `aishared` 可用时才把 SOUL 状态合并进完整体检卡，并避免重复输出。修后须固化上述 3 个失败场景为回归测试。

## 建议改进（值得讨论）

1. **明确 fail-open 的双重契约：会话可用性与告警活性不能混为一项。**
   `mirror-gate.py:299-302` 正确保证任何异常均 exit 0，但当前把"没有阻断会话"同时当成"哨兵正常退化"，掩盖了告警丢失。建议验收拆成两个独立断言：`session_exit_code == 0` 与 `non-consistent SOUL warning delivered == true`。故障注入证明前者通过、后者在三类输入下失败。

2. **更新已过时的文件级设计注释。**
   `mirror-gate.py:4-18` 仍称只有三个数据源且"仅 514claude 工作区"cwd 门控，未说明 SOUL 是全局例外。与 `:165-173`、`:263-271` 的新设计冲突，容易让后续维护再次把全局告警圈回项目门控。

3. **在同步脚本显式记录 SOUL 排除原则。**
   实测 `scripts/sync-runtime.ps1:21-41` 仍为 15 对且无 SOUL 映射，实际行为正确；但 `:8-10` 的"不在映射表"说明未登记 SOUL。建议补一句"SOUL 由方向中立只读哨兵管理，不得加入单向 `-Apply`"，防止未来维护者误加回去。

## 可保留（看似奇怪但合理）

1. **致命1已真实修复：SOUL 漂移提示方向中立。**
   `mirror-gate.py:171-188` 只报告两端不一致，同时列出"源为准→回写运行时"和"运行时为准→回写源"两条对称路径；SOUL 专属提示及 SOUL-only 整卡均无 `-Apply`。故障注入不同 hash 后状态为 `drift`，消息与整卡的方向中立断言通过。同步脚本确认无 SOUL 映射，不存在提示之外的隐式自动覆盖路径。

2. **三态防假绿完整。**
   `mirror-gate.py:181-190` 正确区分 `consistent / drift / unverifiable`；`PermissionError` 和内部 hash 异常均返回 `unverifiable`，没有冒泡。`:231-237` 只把明确的 `consistent` 渲染成"一致 ✓"，其余状态均为警告。故障注入中 PermissionError、路径异常和三态卡片渲染全部通过。

3. **fail-open 保住了 SessionStart 安全性。**
   `mirror-gate.py:174-190` 局部捕获路径、权限和读取异常，`:256-303` 外层继续兜底。实测内部异常与 main 全程异常都以 exit 0 结束，没有阻断会话。应保留这一行为，修复告警 liveness 时不能改成 fail-closed。

4. **原体检卡四行未被破坏。**
   `mirror-gate.py:193-250` 仍按原顺序生成路由门、DELTA、外部发火和双地落四行，只在其后追加 SOUL 行。固定 mock 数据的逐行比较通过，原四行内容和顺序不变。

5. **非 514 正常会话没有额外噪声。**
   `mirror-gate.py:267-273` 在 SOUL 一致时保持 stdout 为空；drift/unverifiable 才输出全局告警。故障注入的"非514+consistent静默"和"非514+drift告警"均通过。

## 总评

独立故障注入结果为 **16/19 通过、3 项失败**。方向中立、三态防假绿、SOUL 不进入单向同步、SessionStart fail-open、非 514 静默和原体检卡兼容性均成立；但核心全局化契约仍存在确定性 liveness 漏洞，不能宣称 T2 已安全完成。

严重度定性为 **NEEDS_HARDENING**：这是必须修复的 P0 验收阻断项，但当前缺陷只导致告警漏送，没有会话阻断、自动覆盖或数据破坏。Gemini 外部二意见已尝试调用，但本机缺少 `GEMINI_API_KEY`，CLI 直接失败，因此未取得外部意见；本结论仅基于已完成的静态复核与可执行故障注入，不伪造异构结果。

---

## 烛的交叉验证注记（守夜人层，非原样转抛）

**独立第一手复现**：我在召唤 Codex 前已独立嗅到并磁盘实测了核心漏检缝，与 Codex 16/19 矩阵完全吻合——证据链非单一模型：
- `scratchpad/test_h1_gap.py`：我评审前独立发现的 **H1（`514claude-backup` anchor 子串 + 无 aishared + drift → SOUL 告警丢失）**，实测 `out=''`；并确认 `WORKSPACE_ANCHOR='514claude'` 是 `in` 子串匹配（`514claude-backup`/`x514claudex`/`514claude_old` 均命中，触发面比精确匹配宽）。
- `scratchpad/test_liveness2.py`：我第一手确认了 Codex 独立扩展的另两条——**合法 514 新项目未 co-init（无 .ai-shared）** 与 **非字符串 cwd（`{"cwd":514}`）被 fail-open 吞告警**，均 `out=''`；同时确认 `cwd=None`/`cwd 键缺失` 走非514分支告警正常送达（无问题）。

**发现归属（dogfood 净增量）**：H1（backup 场景）我独立发现；"合法新项目无账本"（更现实，LO 在 514claude 容器下开新子项目是常态）与"非字符串 cwd fail-open 吞告警"（我完全没想到的第三条路径）由 Codex 独立扩展——**互补交叉验证**，三触发面收敛同一根因。

**主驾盲区实证（AD-3 存在意义）**：主驾自测 `test_soul_sentinel.py` **8 项 ALL PASS**（我复跑确认），但其 main 三场景（5/5b/5c）全部落在主驾自己想到的路径——5c 用的是**有 `.ai-shared` 的 `I:/514claude/514cc`**，系统性绕过了自己的盲区。这是"同模型有同盲区"的又一实证：主驾上轮改 mirror-gate 漏了"假绿灯"（R1 致命），这轮漏了"告警 liveness"。**主驾自测通过 ≠ 安全**，正是 rules §三 铁律1 与策 AD-3 强制 dogfood 的理由。

**Codex 合规核查**：Codex 全程 workspace-write 沙箱，仅在 `.ai-shared/tmp/` 写测试脚本（`review_t2_soul_sentinel_r2.py`，10695 字节）+ `-o` 输出（`codex_r2_final.md`）——**已核验评审对象 `mirror-gate.py` 未被改动**（mtime 停在 14:15 主驾改后态，SHA `9e67974d…`）。无篡改、无夹带。

**Gemini 外部二意见缺口（reflection R2 mirror-loop 防护如实标注）**：Codex 按 reflection 规约主动尝试召唤 Gemini 破镜像循环，但本机缺 `GEMINI_API_KEY`，CLI 直接失败——与 MEMORY 记录的 Gemini 反代环境问题一致。本轮破 mirror-loop 实际靠**可执行故障注入实测**（Codex 19 项矩阵 + 烛 2 份独立第一手测试脚本，非模型互印），而非 Gemini 资料。对纯 Python hook 逻辑审查，外部实时信息无增量，此豁免符合 SOP 精神；但缺口如实记录，Codex 与烛均未伪造第二意见。

**烛结论**：本轮评审高可信（异构 Codex + 烛独立双实证收敛）。**T2 未达"推送全局"验收口径**——致命1 已修，但致命2 仅表面修复，遗留确定性 liveness 漏洞，主驾"8 项 ALL PASS/致命2 已修复"的自评被推翻。

---

## 下游建议

### 建议召唤
- **主驾直接改**（最小修复）：按致命#2 拆开"全局告警送达"与"项目体检卡构建"——SOUL 非 consistent 时无条件先输出全局告警再走 cwd 分支；cwd 非字符串规范化为空串。改后**必召唤烛 reflection R3** 验收 3 失败场景固化为回归 + 无重复告警。
- **策（可选）**：若主驾认为"全局告警送达独立性"值得抽象为 mirror-gate 的通用契约（不止 SOUL，未来其它全局资产同理），可让策补一条"全局哨兵送达不得耦合项目发现"的设计约束到加固规格 §5。

### 风险信号
- **不修则 T2 不可"推送全局"**：LO 在任一 `514claude` 新子项目（未 co-init）或路径含 `514claude` 子串的备份/改名目录开会话时，若 SOUL 恰被改坏，**本该全局告警却静默**——正是致命2 想根治的"回到特定工作区才告警"的残留变种。
- **fail-open 吞告警是体系级模式**：非字符串 cwd 场景暴露"fail-open 保 session 安全 = 静默牺牲告警 liveness"的张力，其它三扳机（route/stop-gate）若也有"先算后输出、输出在异常路径后"的结构，可能同病，值得一并巡检。

__VERDICT__: NEEDS_HARDENING
__DELTA__: t2-soul-sentinel(reflection R2) | 2 | 推翻主驾"致命2已修复 / 8项自测ALL PASS"判断——异构 Codex(16/19故障注入)+烛独立第一手双实证收敛证明致命2仅表面修复：`check_soul_drift` 计算全局但告警输出仍耦合 cwd 分类/账本发现(mirror-gate.py:263-276 find_aishared None 早退 + :267 非字符串cwd .replace 崩被 :299-302 fail-open 吞)，3 触发面同根因，阻断 T2 P0"推送全局"验收；致命1(方向中立)已真修复
