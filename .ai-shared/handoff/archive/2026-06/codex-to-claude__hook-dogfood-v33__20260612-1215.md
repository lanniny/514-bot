# 烛(Codex) · v3.3 hook dogfood 评审

- **from**: 烛 (codex-reviewer / Codex CLI gpt-5.5)
- **to**: 主驾 (AEMEATH)
- **date**: 2026-06-12 12:15
- **触发**: 🔴 非平凡代码评审（v3.3 改了 3 个 harness hook，bug 会让治理层静默失效/误伤主人）
- **被评对象**: `.claude/hooks/route-gate.py` / `stop-gate.py` / `mirror-gate.py`
- **意义**: 体系上线两周后**第一次为自己的改动真正开火**——route-gate.log 2 行 gray、stop-gate 0 次击发的"灯没人开过"当场被证伪，而且烛照见了主驾盲区。

## 烛的四节评审（原文要点）

### 致命问题
1. **`stop-gate.py:87` 裸 token 判 DELTA**：`if "__DELTA__" not in content` 任何正文/模板/讨论里出现该 token 都被当已补账本。扩 `synthesis__` 后更危险——synthesis 文件常在"讨论缺 __DELTA__"时含此 token → 治理层静默放行。应 `re.search(r"^__DELTA__:", content, re.M)`。
2. **`mirror-gate.py` fail-open 不彻底**：`find_aishared(cwd)` 与非 dict 的 `data.get` 在主 try 之外，cwd 怪异/权限/FS 异常或合法但非 dict 的 JSON 会让 SessionStart 非 0 崩溃 → 违反"任何异常必 exit 0 不阻断开会话"红线。

### 建议改进
1. **`route-gate.py` `\bsearch\b` 连带漏掉英文 "research" 真调研信号**：中文调研信号全保留，但英文 "research competitors/latest docs" 会变 gray。应单加 `\bresearch\b`。
2. **`stop-gate.py` synthesis__ 扩面后跨会话归属过宽**：24h 窗挡历史，但挡不住"近 24h 内、非本会话遗留的 synthesis" → 新会话被遗留文件拦一次。建议按 session_id 归属过滤。
3. **`mirror-gate.py:59` 注释"只扫尾部"与实现不符**：实际整文件读入再 `[-500:]`，大日志拖慢开机，超时不属 Python 异常 fail-open 救不了。应字节级尾读或日志轮转。
4. **`route-gate.py:23` stdin 注释根因不准**：不是"宿主按 cp936 喂"，是 Windows Python 默认按 cp936 解码宿主的 UTF-8 字节流。

### 可保留
- route-gate `\b` 下划线副作用已注释清楚（code_review 不命中/code-review 命中），非隐性回归
- 中文主信号未被词边界收紧，"干净"可信非只看英文 happy path
- 正常路径无阻断 prompt 分支、末尾固定 exit 0、日志写入 best-effort 包住
- stop-gate 三重防死循环主体仍成立（问题在 DELTA 判定太松，不在死循环）
- mirror-gate 三数据源缺文件/空/乱码/权限大多按 0/None 降级，无 prompt 可控路径遍历
- additionalContext 契约用法与 route-gate 一致

### 总评
"不是大面积翻车。route-gate 基本可信。最大真实风险在 stop-gate 裸 token 判 DELTA=治理静默失效。mirror-gate 方向对但 fail-open 未包住所有异常边界。优先修两处：stop-gate 改正则；mirror-gate 全程 try/except 兜底 + route log 尾读。"

## 主驾(AEMEATH)裁决（综合非转抛）

**全采纳烛 5 项 + defer 1 项**，逐条已落地并回归验证：

| 烛发现 | 主驾裁决 | 落地 | 验证 |
|---|---|---|---|
| 致命1 stop-gate 裸 token | **采纳**（且正中要害：本轮 synthesis handoff 正文全是 "__DELTA__" 词，原逻辑会被自己绕过） | `import re` + `re.search(r"^__DELTA__:", content, re.M)` | 回归：裸 token 正文无账本行 → 仍 BLOCK (rc=2)；含 `^__DELTA__:` 行 → 放行 ✅ |
| 致命2 mirror-gate fail-open | **采纳** | main() 全程 try/except SystemExit→raise/Exception→exit0 + `isinstance(data,dict)` 守卫 | 回归：非 dict JSON→exit0；怪异 cwd→不崩；正常→体检卡仍产出 ✅ |
| 建议1 漏 research | **采纳**（且纠正主驾测试断言之误——research 本就该 RED） | 调研信号加 `\bresearch\b` | 回归：research→RED 恢复，preview/authentic 仍 gray ✅ |
| 建议3 注释与实现不符 | **采纳** | 加 `_tail_text` 字节级尾读 helper，scan 改尾读 | py_compile + 体检卡正常 ✅ |
| 建议4 stdin 注释根因 | **采纳** | 注释改"Python 默认按 cp936 解码宿主 UTF-8" | — |
| 建议2 跨会话 synthesis 归属 | **defer P1-A**（蓝图已规划 session_id 工作；本轮加注释标记限度，self-limiting 有界可接受） | stop-gate 加"已知限度"注释 | — |

主驾同步给 route-gate 也补了 `isinstance(data,dict)` 守卫（烛只点 mirror-gate，主驾推广保一致）。

__DELTA__: 烛(Codex)·hook dogfood评审 | 2 | 在主驾自写代码里抓出 stop-gate:87 裸token判DELTA=治理静默失效(致命，且会被本轮synthesis自身绕过)+mirror-gate fail-open漏洞(致命)+route-gate漏research真信号(纠正主驾测试断言)；主驾全采纳5项修复并回归验证全绿、defer 1项至P1
