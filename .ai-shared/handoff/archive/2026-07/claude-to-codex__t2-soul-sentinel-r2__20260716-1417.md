# 任务卡：T2 SOUL 全局哨兵 reflection R2 异构复评（烛 dogfood + 故障注入）

## 你的身份与立场
你是烛（codex-reviewer）的深推理内核，对**主驾（Claude）改的安全 hook** 做异构 dogfood 复评。
主驾改 mirror-gate 有前科：上一轮（R1）你抓出它的双地落哨兵把「核验失败」静默渲染成「一致 ✓」的致命假绿灯 bug。**这轮读磁盘自己判，不轻信主驾自测脚本的 ALL PASS**——主驾的测试恰恰可能漏掉它自己的盲区。

## 背景（R1 → T2 演进）
`mirror-gate.py` 是 514cc 的 SessionStart hook（开机自省体检卡）。R1 你评审"SOUL 纳入双地落 sync"方案，列 4 致命：
1. **方向**：无方向 hash 差异被哨兵无条件转译成 `-Apply` 单向覆盖建议；SOUL 是高频手改的运行时文件，运行时才是新版时 `-Apply` 会静默抹掉手改。
2. **范围**：全局 SOUL（`~/.claude/CLAUDE.md` 影响所有项目）配了项目域 cwd 哨兵，监控范围<影响范围。
3. byte-equal 掩盖语义陈旧（源内容可能过时但仍显"一致"）。
4. 备份闭环未验证。

主驾按策的加固规格（`spec-architect-to-claude__soul-hardening-spec__20260716-1359.md` §5.5 加固点4-P0）回滚"纳入 sync"，改为 **T2**：
- SOUL **不纳入** sync-runtime.ps1（保持 15 对，已核验脚本无 SOUL 对）。
- 新增 `check_soul_drift()`：**只读、方向中立（绝不建议 -Apply）、全局（不 cwd 门控）**哨兵。
- 致命3/4 通过"不纳入 sync + 只读哨兵"回避（设计决策，本轮不追）。
- **本轮只验致命1（方向中立）+ 致命2（全局化）是否真修复，以及全局化是否引入新漏检/误伤面。**

## 评审对象
`I:/514claude/514cc/.claude/hooks/mirror-gate.py`（改后，308 行）
重点新增/改动：
- `check_soul_drift()`（约 :165-190）
- `build_card()` 的 SOUL 行（签名 :193 默认参数、渲染 :231-237、卡片 :250）
- `main()` 的 SOUL 全局检测段（:256-303，尤其 :263-273 cwd 门控前置检测 + 非514分支）

**当前磁盘态**（构造 drift 时须知）：`soul/CLAUDE.md` == `~/.claude/CLAUDE.md`，byte-identical，18423 字节，SHA256=`1c146cc34a1855c0b3a6bc979a3dfe091a96eabdb698418580e3ade3838da237`。故真实调用 `check_soul_drift()` 返回 `consistent`——要测 drift/unverifiable 须 mock hashlib。

## 复评重点（逐条，file:line + 故障注入证据）
1. **方向中立彻底吗**：drift 路径有无任何残留 `-Apply` 诱导 / 隐含方向假设（"源为准"之类的默认倾向）？
2. **全局检测独立性**：main 改造后 SOUL 检测真在**所有**工作区送达告警吗？有没有意外圈回 cwd 门控内被吞掉的路径？非514正常会话（SOUL 一致）会被误打扰吗？
3. **fail-open 完整**：`check_soul_drift` 任何异常（路径/权限/hash/解包）会冒泡阻断开会话吗？main 改造引入新崩溃面没有？
4. **三态防假绿**：SOUL 核验失败绝不渲染"一致"？（对齐上轮你修的 `check_drift` 三态）
5. **改 main 副作用**：新增 SOUL 段是否破坏原体检卡逻辑（路由门/DELTA/发火/`check_drift` 双地落四行）？
6. **你的独立发现**，尤其"看似方向中立实则有漏"或"全局化引入的新误伤/漏检面"。

## 烛已实证的假设（请独立复现 + 独立评严重度，勿照抄我的定性）
**H1（疑似漏检缝，我已实测 SOUL 告警丢失）**：
main() 逻辑 `if WORKSPACE_ANCHOR not in cwd... : [非514分支，drift 时全局告警]` 之后，进入 514 分支 `aishared = find_aishared(cwd); if not aishared: sys.exit(0)`。
若 cwd **命中** `514claude` 子串（WORKSPACE_ANCHOR 是 `in` 子串匹配，`514claude-backup`/`x514claudex`/`514claude_old` 均命中）**但** find_aishared 返回 None（该路径链无 .ai-shared）→ 走 `if not aishared: sys.exit(0)` 直接退出 → **SOUL drift/unverifiable 告警被吞掉**。
我的实测（mock check_soul_drift 返回 drift + mock find_aishared 返回 None，cwd=`I:/514claude-backup/xyz`）：main 输出为空字符串，SOUL 告警丢失。对照组（非514+drift、514+aishared+drift）均正常告警。
**这似乎违背致命2 的设计意图**（策 §5.5.1："全局关键文件漂移检查段，先于/独立于 cwd 门控执行"）——检测虽在 cwd 门控前**计算**了，但在"514anchor+无aishared"分支**没有输出**，等于"检测独立、告警不独立"的半吊子。
请你：① 独立故障注入复现此场景；② 判定这是**致命**还是**建议**（考虑触发条件现实性：路径含 514claude 子串但无 .ai-shared 有多现实？子串匹配放大了触发面）；③ 若确认，给出最小修复方向。
注：主驾自测脚本 `test_soul_sentinel.py`（scratchpad）用 mock 覆盖 main 三场景，但 **5c 用的是有 .ai-shared 的 `I:/514claude/514cc`，未覆盖此缝**——这正是"主驾测不出自己盲区"的又一实例。

## 故障注入要求（AD-3 强制；破 mirror-loop 靠可执行实证而非模型互印）
在 scratchpad（`C:/Users/16643/AppData/Local/Temp/claude/I--514claude-514cc/d4a8fd96-9914-4247-8cc9-ccd382e7cd8c/scratchpad/`）或 cwd 下写 Python 测试实跑，用 `importlib` 加载 mirror-gate 模块，`unittest.mock` 注入。至少覆盖：
- 方向中立：drift 时 msg 与整卡无 `-Apply` 字样
- 全局独立：非514+drift→全局告警 / 非514+consistent→静默 / 514+aishared+drift→卡片SOUL行 / **514anchor+无aishared+drift→是否漏检（H1）**
- 三态：consistent/drift/unverifiable + PermissionError 注入 hashlib→unverifiable（非假绿）
- fail-open：check_soul_drift 内部异常不冒泡；main 全程异常→exit 0
- 副作用：原体检卡四行（路由门/DELTA/发火/check_drift 双地落）在加 SOUL 段后行数/内容不变
- **自选**：任何你嗅到的其它边界（如 unverifiable 在非514每会话打扰、soul/CLAUDE.md 作为永不更新的 src 快照在 LO 手改运行时后的常驻噪声、cwd 为 None/空的处理）

## 产物
输出**四节结构**（致命/建议/可保留/总评），每条附 file:line + 故障注入证据。
**不要落盘 handoff**（我烛来综合落盘），把完整四节输出到 stdout。
末尾给：`__VERDICT__: SECURE | NEEDS_HARDENING | CRITICAL`
Codex CLI 失败/沙箱受限如实报，不伪造结果。
