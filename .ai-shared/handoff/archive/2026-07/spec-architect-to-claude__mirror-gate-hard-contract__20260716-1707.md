# 规格：mirror-gate SOUL 送达硬契约 + 回归基线（终结五轮补丁循环）

- **From**：策（spec-architect）
- **To**：Claude（主驾，按本规格实现）
- **时间**：2026-07-16 17:07
- **上游任务卡**：`claude-to-spec__mirror-gate-hard-contract__20260716-1659.md`
- **目标文件**：`I:/514claude/514cc/.claude/hooks/mirror-gate.py`（本规格只读它、不改；重设计供主驾实现）
- **性质**：契约驱动的系统治理规格（不是第六轮单点补丁）

---

## 0. 元诊断：为什么单点补丁失败五次（根因拓扑）

五轮 dogfood 每轮修好 N、引入 N+1，全部落在**同一个结构病灶**上：

```
main() 现结构（简化）
  ├─ 输出点 A：emit_soul_warning()  → stdout.write(SOUL 告警 JSON)   @:285
  └─ 输出点 B：体检卡分支          → stdout.write(体检卡 JSON)       @:313
                                        │
                    partial-write 崩 ───┘（write 部分写出后抛异常）
                                        │  card_written 尚未置位(:314 未执行到)
                                        ▼
                    except → if card_written(False) → pass → 落到回退
                                        ▼
                    emit_soul_warning() 再 write 一段 → stdout = 半个体检卡 + 完整 SOUL 告警
                                        └─────────── 双段损坏（R5）
```

**根因一句话**：存在**两个 stdout 输出点**，且第二个是第一个失败时的**回退**。只要"回退再写"存在，partial-write / 双写 / 双 JSON 就是结构性必然——补哪一个分支都堵不住，因为病在结构不在分支。R1–R5 是这个病的五个不同投影：

| 轮次 | 表面症状 | 结构投影 |
|---|---|---|
| R1 | 核验失败静默返回"一致" | 三态坍缩成二态（假绿灯） |
| R2 | 告警送达耦合 cwd 门控 | 送达路径与项目发现纠缠 |
| R3 | 告警串在 json.load→find_aishared→build_card 链 | 送达路径与构造链纠缠 |
| R4 | 治本引入 E1 fail-closed + D1b 双写 | 引入第二输出点 |
| R5 | card_written 标记覆盖不了 partial-write | 回退再写 + 标记时序错位 |

**结论**：不能再补分支。要**从结构上消灭第二个输出点**，让"回退再写"在代码里不可能被表达。这就是本规格的核心。

---

## 1. 硬契约不变量清单（INV，机械可判定）

每条不变量给出 **定义 + 可判定谓词 + 覆盖的崩溃轮次**。谓词是回归基线要机械断言的对象——不变量不可判定就是口号，五轮循环就是"口号 + 直觉"的产物。

### INV1 — fail-open（永不阻断会话）
- **定义**：任何输入 / 任何内部异常下，进程 exit code = 0，绝不阻断 SessionStart。
- **谓词**：`main() 不抛未捕获异常（SystemExit 除外，需 re-raise）；代码中无 sys.exit(非0)；任何 except 分支不 re-raise 非 SystemExit`。
- **覆盖**：R4 E1（fail-closed 阻断）。

### INV2 — 不假绿灯（三态完整性）
- **定义**：SOUL 与双地落状态严格三态 `{consistent, drift, unverifiable}`；渲染"一致 ✓" **当且仅当** state==consistent。
- **谓词**：`核验路径上任何异常 / 文件缺失 / 路径解析失败 / repo 根存疑 → 归入 drift 或 unverifiable，绝无一条归入 consistent；build_card 渲染"一致 ✓" 的分支入口条件恒为 state==consistent`。
- **覆盖**：R1（二态坍缩）。
- **现状**：`check_soul_drift`(:168) / `check_drift`(:128) 已三态，本契约冻结之，防未来回退二态。

### INV3 — 送达解耦（SOUL 告警独立于一切构造链与门控）
- **定义**：SOUL 非 consistent 时，其告警送达**不依赖** {json.load(stdin) 成功、cwd 合法、`_anchor_match` 为真、find_aishared 命中、build_card 成功} 中的任何一项。
- **谓词**：`当 stdin 畸形 ∧ cwd 非514/非法 ∧ build_card 必崩，注入 SOUL=drift → stdout 仍含且仅含一段 SOUL 告警 JSON`。
- **覆盖**：R2（耦合 cwd 门控）、R3（串在构造链）。
- **关键**：cwd 门控只决定"要不要出**项目级体检卡**"，绝不决定"要不要送 **SOUL 全局告警**"——SOUL 全局生效，对任何 cwd 都要能送。

### INV4 — 单 JSON（stdout 至多一段可解析 JSON）
- **定义**：stdout 内容要么为空，要么是**恰好一个** JSON 对象，绝无两段拼接。
- **谓词**：`stdout 全文可被 json.loads 一次性解析成功，或为空字符串；扫描 stdout 中子串 '"hookSpecificOutput"' 出现次数 ≤ 1`。
- **覆盖**：R4 D1b、R5（双段损坏）。

### INV5 — 无 partial-write 双段损坏（结构性）
- **定义**：承载 additionalContext 的 `stdout.write` 在任一执行路径上**至多被调用一次**；write 之后**无任何**再向 stdout 写入的代码路径（无"失败回退再写"）。
- **谓词**：`静态：main 执行图中承载 payload 的 stdout.write 调用点数量 = 1，且该调用点后继路径不含第二个 stdout.write`。`动态：mock write 写一半即抛 → stdout 累积内容中 '"hookSpecificOutput"' 起始 ≤ 1 段`。
- **覆盖**：R5（核心）。这是终结循环的结构保证——不依赖 write 原子性，依赖"物理上不存在第二个 write"。

### INV6 — 留痕不假阳（副作用只在确认送达后）
- **定义**：`mirror-gate.log` 写 `card-injected` **当且仅当**体检卡 payload 已 **flush 成功**；任何非体检卡输出 / write 未成功 / flush 未成功 → 不留痕。
- **谓词**：`payload.tag != "card" ⇒ 不写 log`；`flush 未成功 ⇒ 不写 log`；`SOUL-only 告警送达 ⇒ 不写 card-injected（它不是体检卡）`。
- **覆盖**：R3 建议3（card-injected 假阳）。

### INV7 — anchor 精确（不误注入跨项目）
- **定义**：完整体检卡输出 ⇒ cwd 的**路径组件精确等于** WORKSPACE_ANCHOR，绝不裸子串匹配。
- **谓词**：`_anchor_match('.../514claude-backup/x') == False`；`_anchor_match('.../x514claude/y') == False`；`_anchor_match('C:/.../514claude/wai') == True`。
- **覆盖**：R3 建议2（子串误判在对方 .ai-shared 写 log）。
- **现状**：`_anchor_match`(:259) 已用 `Path.parts` 精确比对，冻结之。

### INV8 —（补充）输出编码健壮（隐性依赖显式化）
- **定义**：含非 ASCII 的 soul_msg / 体检卡文本，经 `json.dumps(ensure_ascii=False)` + stdout 写出时，绝不因编码抛 `UnicodeEncodeError`。
- **谓词**：`stdout 在 win 平台已 reconfigure(encoding='utf-8', errors='replace')(:31-34)；json.dumps 全部带 ensure_ascii=False`。
- **覆盖**：未在 R1–R5 显式出现，但是 Windows stdout 老坑——未来若有人删 :31-34 的 reconfigure，INV4/INV5 全崩（write 抛编码异常触发回退语义）。**显式列为契约，让基线守住这个隐性前提**。

### INV9 —（补充/元不变量）构造与输出分离（支撑 INV4/INV5 的结构根）
- **定义**：所有可能抛异常的计算——`json.load(stdin)` / `find_aishared` / `build_card` / `check_soul_drift` / `check_drift` / `json.dumps`——必须全部完成于**唯一 write 之前**；write 之后的代码路径只允许 {flush（自带 try）、条件留痕（自带 try）、return}，均不得再触发 stdout 写入。
- **谓词**：`唯一 write 调用点之后的后继语句集合 ⊆ {stdout.flush in try, log-append in try, return, exit0}；其中无第二 stdout.write，无未被 try 包裹的可抛异常计算`。
- **覆盖**：R4/R5 的元根因。**INV9 成立 ⇒ INV4 ∧ INV5 自动成立**——这是"为什么单一输出点能治本"的形式化表达，是本规格最高杠杆的一条。

> **不变量间的蕴含关系**（供烛 R6 对抗式核查覆盖完整性）：
> `INV9 ⇒ INV4 ∧ INV5`；`INV2` 独立（三态语义）；`INV3 ⇒` SOUL 送达不被门控吞（含 R2）；`INV1` 是全局兜底外壳。基线必须**每条独立注入验证**，不能因蕴含关系省略——蕴含在"正确实现"下成立，但基线要防的正是"实现被改错"。

---

## 2. 送达结构重设计（核心：单一输出点）

### 2.1 对主驾方向的评估结论（诚实先行）

主驾建议的"单一输出点"方向 **正确，无更优解，我未发现隐患级缺陷**，只需深化 + 明示一处有意 trade-off。评估三个我认真挑战过的替代/隐患：

- **"既单段又能体检卡崩了回退 SOUL"能否两全？** —— **不能**。兜底本质上需要第二次 write，而第二次 write 正是病根。鱼与熊掌不可兼得，必须明确取舍（见 2.4 trade-off）。这一条是前五轮反复栽的地方：每轮都想两全，于是每轮都留了"回退再写"。**契约驱动要求敢于明确放弃兜底**。
- **单段会不会丢失 SOUL 信息？** —— **不会**。体检卡 payload **已内嵌 SOUL 状态行**（build_card `soul_line` :234-240）。514 工作区出体检卡时，SOUL 三态信息在卡里；非514 或体检卡崩时才降级到纯 SOUL 告警。信息零丢失。
- **build_card 内部子函数崩会不会污染输出？** —— **不会**（若 INV9 落实）。build_card 被 `safe_build_card` 包住、崩则返回 None、降级到 SOUL 分支，全程在 write 之前。

### 2.2 设计原则（四条，按优先级）

1. **决策先于输出（INV9）**：把 `main()` 劈成两相——**构造相**（纯计算，可以随便抛异常，绝不碰 stdout）与**输出相**（单点 write，payload 已锁死）。所有 R1–R5 的崩溃点全部落在构造相，构造相崩 = 降级 payload 或 None，永远污染不到输出相。
2. **唯一 payload，二/三选一在 write 前锁定（INV4/INV5）**：构造相返回**恰好一个** `(tag, payload)` 或 `None`。输出相对这唯一值做单次 write，之后**代码里不存在第二个 write**——不是"运行时不走到"，是"物理上没有"。
3. **降级是选择不同 payload，不是失败后回退再写**：体检卡构造失败 → 构造相**在 write 之前**就改选 SOUL 告警 payload；不是先 write 体检卡、崩了再 write SOUL。降级发生在构造相内部，输出相永远只见到一个成品。
4. **副作用（留痕）在确认送达之后，且不影响输出契约（INV6）**：留痕写文件不写 stdout，只受"flush 成功才留、只有体检卡才留"约束，崩了只 pass。

### 2.3 payload 决策树（构造相，纯计算）

```
build_payload(stdin_raw) -> (tag, json_str) | None      # tag ∈ {"card","soul"}；绝不碰 stdout
  soul_state, soul_msg = safe_check_soul_drift()         # 自带 try；崩 → ("unverifiable", "...")

  cwd = parse_cwd(stdin_raw)                             # 自带 try；畸形/非字符串 → ""（不抛）
  if anchor_match(cwd):                                  # INV7 精确组件匹配
      aishared = find_aishared(cwd)                      # 已自带 try(:53)
      if aishared is not None:
          card_body = safe_build_card(aishared, soul_state, soul_msg)   # 自带 try；崩 → None
          if card_body is not None:
              return ("card", safe_dumps(wrap_card(card_body)))   # 体检卡含 SOUL 行；dumps 崩→见下
      # 走到这：非514 / 无aishared / build_card 崩 / dumps 崩 → fall through 到 SOUL 降级

  if soul_state != "consistent":                         # INV3：SOUL 告警独立于以上全部
      return ("soul", safe_dumps(wrap_soul(soul_msg)))
  return None                                            # consistent 且无体检卡 → 静默不输出

# safe_dumps：json.dumps 崩（极罕见）→ 返回 None；上层把 (tag, None) 视同该 payload 不可用，
#   card 分支 None → fall through 到 SOUL；soul 分支 None → build_payload 返回 None（静默）。
#   即：dumps 失败也绝不产出半段、绝不触发第二 write。
```

### 2.4 输出相（单点 write）+ 有意 trade-off

```
main():
  try:
      result = build_payload(read_stdin_raw())     # 构造相全部异常在此被吸收
  except Exception:
      result = None                                 # 兜底：构造相任何漏网异常 → 静默，fail-open(INV1)

  if result is None:
      return                                         # 无输出，exit 0
  tag, payload = result

  # ===== 唯一 stdout.write（INV5）：此点之后代码中不存在第二个 write =====
  try:
      sys.stdout.write(payload)                      # partial-write 崩 → 落 except → 绝不回退再写
      flushed = False
      try:
          sys.stdout.flush(); flushed = True
      except Exception:
          pass                                       # flush 崩不回退（write 已发，回退会造双段）
  except Exception:
      return                                          # write 崩 → fail-open，无第二 write（INV5 核心）

  # ===== 副作用相（INV6）：只在体检卡且 flush 成功后留痕，写文件不写 stdout =====
  if tag == "card" and flushed:
      safe_log_card_injected(...)                    # 自带 try，崩只 pass
  return                                              # exit 0
```

> **有意 trade-off（务必写进代码注释，让烛/未来维护者知道这是设计不是遗漏）**：
> 当 tag=="card" 且体检卡 write 中途崩溃时，本次**不再回退送 SOUL 告警**（即使 SOUL==drift）。理由三条，构成明确的工程取舍：
> 1. 体检卡 write 崩 ⇒ stdout pipe 已不可靠 ⇒ 回退再写 SOUL 大概率同样崩（同一坏 pipe），兜底期望价值趋近 0；
> 2. SOUL drift 是**持久状态**，下次开机 mirror-gate 必再检出，漏送一次不致命；
> 3. 相对地，"回退再写"带来的双段 JSON 损坏是**每次都可能**的结构病。
> **用"极低概率漏一次 SOUL 告警"换"结构性根除双段损坏"——这是正解，不是妥协。** 前五轮的病根恰恰是不肯做这个取舍。

### 2.5 相对现结构的删除项（结构收缩即约束固化）

- **删除** `emit_soul_warning` 嵌套函数（:278-289）——它是第二输出点的化身。其"送 SOUL 告警"职责下沉为 build_payload 的 `("soul", ...)` 分支（构造相，不碰 stdout）。
- **删除** main 里所有"回退再送"路径（:333 `emit_soul_warning()`、:339 最外层 `emit_soul_warning()`）——回退语义被"构造相内降级选 payload"替代。
- **删除** `card_written` 标记及其"write 后置位判回退"逻辑（:304/:314/:330-331）——无回退则无需该标记；留痕改用 `flushed`（write 后置位判留痕，安全，因为留痕不触发 stdout 写）。
- **保留不动**：`check_soul_drift`/`check_drift`/`build_card`/`scan_route_gate`/`count_delta`/`days_since_last_fire`/`find_aishared`/`_anchor_match`/`_tail_text`——它们是纯计算或自带 try，契约合规，被 build_payload 组合调用。

> 删除三个"回退/双写"节点后，代码里将**不存在任何能表达"第二次 stdout 写入"的语句** —— INV5 从"靠 review 守"变成"靠结构不可能违反"。这是把纪律焊到结构上。

---

## 3. 回归基线测试套件（INV → 故障注入映射）

**这是终结五轮循环的核心机械资产**。未来任何人改 mirror-gate.py，必须先跑绿这套基线。

### 3.1 测试架构（双轨）

- **白盒轨**（主力）：`import` mirror-gate 模块，monkeypatch `sys.stdout`（替身对象捕获/注入故障）、monkeypatch `check_soul_drift`/`build_card` 注入崩溃，直接调 `main()`。partial-write / flush 崩 / 构造崩必须白盒才能注入。
- **黑盒轨**（端到端补充）：`subprocess` 起真进程喂 stdin JSON、捕获 stdout + exit code，验证 INV1/INV4/INV7 的真实进程行为。
- 建议落位：`I:/514claude/514cc/.claude/hooks/tests/test_mirror_gate_contract.py`（新建 tests/ 子目录）。

### 3.2 partial-write mock 骨架（核心夹具）

```python
class HalfWriteStdout:
    """模拟 partial-write：write 只吐一半就抛，flush 也崩。用于 INV5 核心断言。"""
    def __init__(self):
        self.captured = []
    def write(self, s):
        self.captured.append(s[: max(1, len(s) // 2)])   # 只"写"一半
        raise IOError("simulated partial write")
    def flush(self):
        raise IOError("simulated broken pipe")
    def reconfigure(self, **kw):                         # 兼容 :31-34 的 reconfigure 调用
        pass

def count_json_segments(text: str) -> int:
    return text.count('"hookSpecificOutput"')            # INV4/INV5 断言：≤ 1
```

### 3.3 用例映射表（15 条，每条 = 注入点 + 手法 + 断言 + 目标 INV）

| # | 用例 | 注入手法 | 断言 | 目标 INV |
|---|---|---|---|---|
| T1 | 体检卡 partial-write | stdout=HalfWriteStdout，cwd=514+aishared，build_card 正常 | `count_json_segments(captured) <= 1` 且进程不抛（exit0） | **INV5**/INV1 |
| T2 | write 短返回 | stdout.write 返回 `len(s)//2`（非抛，短写语义） | captured 无第二段 JSON | INV5 |
| T3 | flush 崩 | stdout.write 正常、flush 抛 | 无第二 write；exit0；**不留痕**（flushed=False） | INV6/INV1 |
| T4 | build_card 崩 | monkeypatch build_card 抛异常，cwd=514，SOUL=drift | stdout 恰含一段 **SOUL 告警**（非体检卡）；exit0 | **INV3**/INV4 |
| T5 | check_soul_drift 崩 | monkeypatch check_soul_drift 抛异常 | SOUL 状态保持 fail-open 默认 `unverifiable`，送"无法核验"告警；exit0 | **INV2**/INV1 |
| T6 | 畸形 stdin | stdin = "not json{{{" / 空 / 截断 JSON | data 解析失败不吞 SOUL；SOUL=drift 时仍送告警；exit0 | **INV3**/INV1 |
| T7 | 非字符串 cwd | stdin={"cwd":123} / null / ["x"] | cwd 规范化为 ""，不抛；SOUL=drift 则送 SOUL 告警 | INV7/INV1 |
| T8 | backup 子串路径 | cwd="C:/x/514claude-backup/p"，SOUL=consistent | `_anchor_match==False`；不出体检卡、不写对方 log；无输出 | **INV7** |
| T9 | json.load(stdin) 崩 | stdin 触发 json.load 异常 | 落 SOUL 降级分支；exit0 | INV3 |
| T10 | find_aishared 崩 | monkeypatch find_aishared 抛（模拟权限） | 降级 SOUL 或 None；exit0；无体检卡半段 | INV3/INV9 |
| T11 | json.dumps 崩 | monkeypatch json.dumps 抛（safe_dumps 路径） | 不产出半段、不触发第二 write；exit0 | INV4/INV5 |
| T12 | SOUL consistent + 非514 | cwd 非514，SOUL=consistent | **stdout 为空**（静默，不乱送） | INV3 反向 |
| T13 | SOUL drift + 非514 | cwd 非514，SOUL=drift | stdout **恰一段** SOUL 告警 JSON；`count_json_segments==1` | INV3/INV4 |
| T14 | 正路：完整体检卡 | cwd=514+aishared，SOUL=consistent，全正常 | stdout 恰一段体检卡 JSON（含"一致 ✓" SOUL 行）；**留痕 card-injected** | INV4/INV6 正路 |
| T15 | 非 ASCII soul_msg | soul_msg 含中文，全链正常 | write 不抛 UnicodeEncodeError；单段 JSON 可解析 | **INV8** |

> **补充断言（贯穿所有用例）**：每个用例都附带 `assert exit_code == 0`（INV1 全覆盖）与 `assert count_json_segments(stdout) <= 1`（INV4/INV5 全覆盖）——这两条是横切不变量，任何用例违反即基线红。

### 3.4 元验收：基线必须能捕获前五轮的 bug（防假基线）

**这是最关键的一条，也是前五轮"主驾自测 ALL PASS 却仍漏"的解药**：把 mirror-gate.py **回退到 R1–R5 各自的 buggy 版本**（git 历史或手工构造最小复现），对应 INV 用例**必须变红**：

| buggy 版本 | 应变红的用例 |
|---|---|
| R1（核验失败返回"一致"二态） | T5（应检出假绿灯） |
| R2（告警耦合 cwd 门控） | T13、T6（非514/畸形下 SOUL 漏送） |
| R3（告警串在构造链） | T4、T9、T10（构造崩则 SOUL 漏送） |
| R4（双写 D1b） | T1、T11（出现双段 JSON） |
| R5（partial-write 双段） | **T1、T2**（核心，必红） |

**若某 buggy 版本下对应用例仍全绿 → 该用例是假的、没真正守边界，必须重写。** 基线要能"测出历史病"才配叫回归基线。这条把"测试测试本身"焊进验收——不做这步，第六轮基线可能又是一套自我安慰的绿灯。

---

## 4. 主驾实现任务列表（有序原子步骤）

| 步 | 任务 | 验证点 |
|---|---|---|
| S1 | 新增 `safe_build_card(aishared, s, m)`：包 build_card 加 try，崩返回 None（不改 build_card 本体） | 单测：注入 build_card 崩 → 返回 None 不抛 |
| S2 | 新增 `safe_dumps(obj)`：包 json.dumps 加 try，崩返回 None | 单测：注入不可序列化 → None |
| S3 | 抽 `build_payload(stdin_raw) -> (tag, str)|None`：实现 §2.3 决策树（纯计算，绝不碰 stdout） | 静态：函数体无 `stdout` 引用；单测覆盖 card/soul/None 三出口 |
| S4 | 重写 `main()`：§2.4 单点 write + flush + 条件留痕；**删** emit_soul_warning、所有回退再写、card_written 标记 | 静态：`main` 内承载 payload 的 `stdout.write` 计数 == 1 |
| S5 | 保留 §2.5 "保留不动"清单的所有纯计算函数原样 | diff 核对：这些函数体零改动 |
| S6 | 新建 `tests/test_mirror_gate_contract.py`：§3 全 15 用例 + partial-write 夹具 + 横切断言 | 全 15 绿 |
| S7 | 元验收：回退 R1–R5 buggy 版本，跑 §3.4 映射表，确认对应用例变红 | 每个 buggy 版本至少一条对应用例红 |
| S8 | 召唤烛做 R6 独立评审（对抗式：0 发现 = 可疑，重审） | 烛 handoff + DELTA 账本行 |

> **实现纪律**：S3/S4 是结构手术，S6/S7 是机械守卫。**顺序不可颠倒**——先有结构再有基线，且 S7（buggy 变红）先于 S8（烛评审），让烛评审的是"已被基线守住的结构"，而非又一版裸直觉。

---

## 5. R6 验收口径（区分"我以为"与"我验证了"）

契约驱动的验收**不认"主驾自测 ALL PASS"**（前五轮都 PASS 过仍漏）。R6 通过 = 以下全绿且有磁盘证据：

1. **基线全绿**：§3 的 15 用例可执行、可重复，全部通过——**贴运行输出，不凭记忆声称**。
2. **元验收达标**：§3.4 每个 buggy 版本下对应用例确实变红（证明基线真守边界，非假绿灯）。
3. **静态单点契约**：`main()` 中承载 payload 的 `stdout.write` 调用点 == 1，且其后继无第二 write（AST 扫描或人工 diff 确认，写进验收记录）。
4. **烛 R6 独立评审**：对新结构一轮，重点找"有无 INV 未被基线覆盖的新异常路径"。0 发现按对抗式兜底 HALT 重审。
5. **DELTA 账本**：S8 烛发火后在本 handoff 或 decisions.md 追 `__DELTA__:` 行，记净增量（0=白发/1=补强/2=推翻主驾判断）。

**任一项无磁盘证据 → 判 R6 未过，不得声称完成。** 尤其防"任务尾部凭记忆标完成"——五轮循环的社会工程学根源正在此。

---

## 6. 一句话交付摘要（给主驾回主人）

mirror-gate 送达从"两个输出点 + 失败回退再写"（partial-write / 双 JSON 的结构病根）重设计为**单一输出点**：构造相纯计算二/三选一锁定唯一 payload、输出相单点 write 之后代码里物理上不存在第二个 write。配 9 条机械可判定不变量（INV1–9，其中 INV9 构造/输出分离是治本元根，蕴含 INV4∧INV5）+ 15 条故障注入回归基线 + "buggy 版本必变红"元验收。明示一处有意 trade-off（体检卡 write 崩不回退送 SOUL，用极低概率漏一次换结构性根除双段损坏）。主驾方向经评估正确、无更优解。8 步实现清单，R6 验收只认磁盘证据 + 烛独立评审。

---

## __DELTA__（策发火账本占位，主驾综合后回填）
- 发火对象：策（spec-architect）
- 净增量：待主驾判定（预期 1=补强，或 2 若"buggy 必变红"元验收与"明示 trade-off 放弃兜底"推翻了主驾原"想两全"的隐含判断）
- 证据：本规格 §1 补 INV8/INV9（主驾原清单 INV1–7）+ §2.4 trade-off 明示 + §3.4 元验收"假基线"防线
