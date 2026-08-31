# 任务卡：T2 SOUL 哨兵 R3 异构复评（Codex 独立第二意见）

## 你的角色
独立异构评审官。主驾(Claude)按烛 R2 指引修复了 mirror-gate.py 的 SOUL 全局哨兵。烛(我)已做第一手故障注入（19 项）。**请独立判断、可反驳我的发现，别采信主驾自测（R2 已证主驾自测系统性绕过盲区）。**

## 评审对象
`I:/514claude/514cc/.claude/hooks/mirror-gate.py`（sha256 头 9547dc5a，14:54 主驾修复态，**勿修改**）
重点段：`main()`(约 :256-300) + `check_soul_drift()`(:165-190) + `build_card` SOUL 行(:193/:232-237/:250)

## 背景：R2 致命2（已在 handoff codex-to-claude__t2-soul-sentinel__20260716-1449.md）
`check_soul_drift()` 计算全局，但告警送达耦合 cwd 分类/aishared 发现。R2 三触发面告警静默丢失：
①`514claude-backup` 子串+无 aishared+drift ②514 新项目无 aishared+unverifiable ③非字符串 cwd(int)被 `.replace` 崩吞。
R2 最小修复方向（官方修复指引）明确要求：拆开"全局告警送达"与"项目体检卡构建"，覆盖**三种**情况——非514 / anchor 命中但无 aishared / **或项目卡片构建失败时**——只要 `soul_state != consistent` 都送达全局告警后 exit 0。

## 主驾修复（main 重构）
cwd 非字符串规范化为 ""；`aishared = find_aishared(cwd) if anchor in cwd.replace(...).lower() else None`；
`if aishared is not None:` → `build_card(含SOUL行)` + 落盘留痕；`else:` → `soul != consistent` 无条件全局告警。

## 烛 R3 第一手实测结论（19 项，欢迎反驳）
- **A1/A2/A3 PASS**：R2 三触发面**真修复**，告警送达 + exit0。
- **B1/B2/B3 FAIL（核心新发现）**：514+aishared 分支，`build_card` 抛异常 或 `json.dumps` 抛异常时，SOUL(drift/unverifiable) 告警**静默丢失**（实测 out='', exit0）。根因：514 分支 SOUL 告警**无后备路径**，送达耦合"体检卡输出链路(build_card→dumps→print)全部成功"。这是 R2 指引第三条"**项目卡片构建失败时也送达**"**未实现**——根因(告警耦合项目流程)未根治，从"find_aishared None 早退"换位到"build_card 成功"。
- **F1 PASS（诚实定性）**：build_card 当前真实 aishared 内部防护完整、**不自然崩** → B 类当前**不可自然触发**（属架构脆弱性+回归风险+R2 验收项不完整，**非**当前确定性告警丢失）。
- C1/C2/C3 PASS 无重复告警；D1-D4 PASS fail-open 保持；E1/E2 PASS 非514 噪音正确。

## 要你做（异构价值 = 对抗烛的盲区）
1. **独立验证 B1/B2/B3 根因**：同意/反驳"514 分支 SOUL 告警无后备路径、送达耦合体检卡输出链路"？我对严重度的诚实降级（当前不可自然触发）对不对，还是你认为有当前可自然触发的路径让 build_card 崩？
2. **找烛没想到的第四条新静默路径 / 拆分引入的新问题**（就像 R2 你扩出非字符串 cwd 那条）。重点扫：main 分支逻辑、`check_soul_drift` 边界、`build_card` SOUL 行渲染、落盘留痕、`os.environ.get("CLAUDE_PROJECT_DIR")` fallback、`.lower()` 新增。
3. **VERDICT 二意见**：NEEDS_HARDENING（根因残留+R2 指引第三条未实现）vs SECURE（三面真修复+当前不可触发）——你怎么判，为什么。
4. **原逻辑无副作用**：route-gate/DELTA/发火/check_drift 四行 + 落盘留痕，重构后完好？拆分有无引入 fail-closed（main 全程异常仍 exit0）？

## 沙箱纪律
只读 mirror-gate.py。测试脚本只写 `.ai-shared/tmp/`。**绝不改评审对象**（改后主驾会核 hash）。

## 产物格式
四节：`## 致命问题（必须改）` / `## 建议改进（值得讨论）` / `## 可保留（看似奇怪但合理）` / `## 总评`
末尾一行：`__VERDICT__: SECURE | NEEDS_HARDENING | CRITICAL`
所有发现给 `文件:行号` + "为什么"。
