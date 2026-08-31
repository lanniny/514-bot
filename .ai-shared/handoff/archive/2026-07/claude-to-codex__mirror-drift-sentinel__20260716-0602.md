# 任务卡：独立评审 mirror-gate.py 新增「双地落漂移哨兵」

## 你的角色
你是独立代码评审官（second opinion）。这是一次 **dogfood 评审**：被评审的代码是主驾（Claude Opus）自己写的治理 hook。主驾自写 hook 有系统性盲区——前科：曾有独立评审抓出同目录 `stop-gate.py` 用「裸 token 判 DELTA」导致的静默失效 bug。**请带着「主驾会不会又自己骗了自己」的对抗心态照盲区**，不要客气，不要凭训练假设，一切结论对着真实文件内容 + 行号取证。

## 评审对象（请完整读）
- `I:/514claude/514cc/.claude/hooks/mirror-gate.py` —— 评审主体。重点看**新增的 `check_drift()` 函数**（约 125-153 行）+ `build_card()` 里调用它并拼接的 **drift 行**（约 160、180-199 行）。
- `I:/514claude/514cc/scripts/sync-runtime.ps1` —— **双地落映射的权威真相**。全 15 对映射在这里。核对 check_drift 内联的 2 对路径是否与它一致。

## 背景（触发）
2026-07-16 发现 `rules.md` 双地落方向倒挂（某次改动只写了运行时 `~/.ai-collab/rules.md`、忘了回写仓库源 `514cc/rules.md`）。此前双地落一致性全靠人**记得手动跑** `scripts/sync-runtime.ps1`，无机械哨兵。本次给 `mirror-gate.py`（一个 SessionStart hook，作用是开会话时注入「自省体检卡」）加了 `check_drift()`：开机用 Python `hashlib` 实时比对**最高价值的 2 对双地落**（宪法 `rules.md` + 人格 `output-style`），发现漂移就在体检卡上标红 + 给修复命令。

## 设计约束（务必据此判断，这些是红队既定硬约束，不是可商量的）
1. **mirror-gate 是 SessionStart hook**，硬约束：①**同步快速执行**（不能拖慢开会话）；②**全程 fail-open**（任何异常一律 `exit 0` 放行，**绝不阻断开会话**）；③cwd 门控（仅 `514claude` 工作区生效）。新增代码必须守这三条。
2. **全 15 对双地落映射的权威在 `scripts/sync-runtime.ps1`**。check_drift 只内联 2 对（宪法+人格）作开机哨兵核心子集——这是**刻意的范围克制**（避免动 sync 核心脚本、避免 Python 去 parse PowerShell 数组的高 blast radius）。请判断这个「内联 2 对 vs DRY 抽共享清单」的权衡**是否可接受**，还是必须抽共享清单。
3. 路径解析：用 `Path(__file__).resolve().parents[2]` 推 repo 根 + `USERPROFILE` 推 home。

## 评审重点（请逐条给明确判决 + file:line 证据）
1. **fail-open 完整性**：check_drift 的任何异常路径（路径解析失败 / 文件不存在 / 读取权限不足 / hash 异常）会不会冒泡到 `main()` 从而阻断开会话？`build_card()` 调 `check_drift()` 是否落在 `main()` 的 try 保护内？逐条异常路径追。
2. **路径解析健壮性**：`parents[2]` 若 mirror-gate.py 被移动/软链/部署到不同位置会怎样？误解析成错的 repo 根，会不会导致「缺文件」假阳漂移告警（狼来了，稀释哨兵公信力）？有没有 sanity check？
3. **假阳 / 假阴**：hash 比对逻辑有无边界问题（BOM / 行尾 CRLF↔LF / 编码）导致源与运行时明明字节一致却报漂移？或反之，明明漂移却漏报？读失败的对最终会呈现成什么（一致？漂移？还是第三态）？
4. **与 sync-runtime.ps1 一致性**：check_drift 内联的 2 对路径（rules.md、output-style/aemeath-meta-butler.md 的源与目标）是否与 sync-runtime.ps1 对应映射**完全一致**（逐字符核对源路径、目标路径）？路径写错会让哨兵监控错对象。
5. **体检卡呈现**：drift 行的 f-string 拼接（`build_card` 返回值 191-199 行）——尾部 `\n` 处理、verdict 分支为空/非空两种情况、drift_line 里 `scripts\\sync-runtime.ps1` 的反斜杠转义——有无格式 bug 导致卡片错行或粘连？
6. **任何你想到的、上面没列的盲区**（这条最重要——前科就是主驾列不全自查项）。

## 产物格式（务必遵守）
用**简体中文**输出，严格四节结构，每节内的每条发现必须带 `文件:行号` 证据：

```
## 致命问题（必须改）
## 建议改进（值得讨论）
## 可保留（看似奇怪但合理）
## 总评
```

总评末尾附一行判决：`__VERDICT__: APPROVED | CHANGES_REQUESTED | REJECTED_FUNDAMENTAL`

若某节无内容，写「（无）」。不要客套，直接给判决与证据。
