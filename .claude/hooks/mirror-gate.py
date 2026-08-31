#!/usr/bin/env python3
"""514cc SessionStart hook —— 镜·自省体检卡。

把三个已经在写、却没有任何机械消费者的「死数据源」，在开会话第一眼摆到 LO 面前：
  1. route-gate.log —— 路由门近 7 天命中（RED/gray 比 + 空转告警）
  2. decisions.md   —— DELTA 账本条数（`^__DELTA__:` 行）
  3. handoff/       —— 距上次真实外部发火（烛/织 handoff）N 天

诊断锚：route-gate.log 上线两天只 2 行全 gray、DELTA 5 条全自审、stop-gate 0 次击发——
「引擎接了电，但灯没人开过」。这张卡给体系装上 LO 看得见的眼睛：不加纪律、不算评分（避伪精确），
只把原始数字摆出来，让 LO 开机一眼回答「这周体系到底被真正运转了没」。

设计原则（红队硬约束）：
  · 只动本文件 + settings.json，绝不碰 rules.md（不加任何新纪律）
  · 同步执行（非 async），否则 additionalContext 会在会话已开始后才回来，「开机即见」落空
  · 数字口径用正则 `^__DELTA__:` 而非裸 token（否则首张卡就报错数自毁公信力）
  · 容错乱码行 + handoff 无发火场景；空转/超期信号醒目标红，不当异常吞掉
  · cwd 门控（仅 514claude 工作区）、fail-open（任何异常一律 exit 0 放行）、绝不阻断
契约见 https://code.claude.com/docs/en/hooks.md
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

if sys.platform.startswith("win"):
    for _s in (sys.stdout, sys.stdin):
        if hasattr(_s, "reconfigure"):
            _s.reconfigure(encoding="utf-8", errors="replace")

WORKSPACE_ANCHOR = "514claude"
RECENT_DAYS = 7            # 路由门只看近 7 天
# 故意只数 codex-to-/gemini-to-（真·外部异构模型发火），不含 stop-gate 的 synthesis__：本卡"外用浓度"
# 指标专测"有没有真用过烛/织"——synthesis__ 是主驾自审，算进去等于让该指标撒谎（自审有余正是体系病灶）。
# 与 stop-gate.FIRE_PREFIXES（含 synthesis__，管所有产物的 DELTA 纪律）有意不同口径，非疏漏。
FIRE_PREFIXES = ("codex-to-", "gemini-to-", "grok-to-")  # 真·外部发火 handoff（grok-to-=织新驱动，gemini-to- 保留识别历史）
STALE_FIRE_DAYS = 14      # 超此天数无真实外部发火 → 醒目告警
STALE_CONTEXT_DAYS = 7    # context.md 超 7 天未收口 → 醒目告警
DELTA_RE = re.compile(r"^__DELTA__:")


def find_aishared(cwd: str) -> Path | None:
    try:
        base = Path(cwd) if cwd else Path.cwd()
        for parent in [base, *base.parents]:
            cand = parent / ".ai-shared"
            if cand.is_dir():
                return cand
    except Exception:
        pass  # 烛 R3 G1：find_aishared 自身加 try，防它抛异常被 main 的 fail-open 静默吞掉 SOUL 告警
    return None


def _tail_text(path: Path, max_bytes: int = 65536) -> str:
    """只读文件尾部 max_bytes（真·尾读，非整文件读入），避免大日志拖慢 SessionStart。
    首行可能从中途截断，由下游解析层（split/strptime 容错）自然跳过。烛 dogfood 建议3。"""
    with open(path, "rb") as fp:
        fp.seek(0, 2)
        size = fp.tell()
        fp.seek(max(0, size - max_bytes))
        return fp.read().decode("utf-8", "replace")


def scan_route_gate(aishared: Path):
    """返回 (近7天总记录, RED 数, gray 数)。容错乱码/残行。"""
    log = aishared / "route-gate.log"
    if not log.is_file():
        return 0, 0, 0
    cutoff = datetime.now() - timedelta(days=RECENT_DAYS)
    total = red = gray = 0
    try:
        lines = _tail_text(log).splitlines()
    except Exception:
        return 0, 0, 0
    for ln in lines:  # 字节级尾读已限大小，残首行由下方 split/strptime 容错跳过
        parts = ln.split("\t")
        if len(parts) < 2:
            continue  # 残行/乱码行跳过
        try:
            ts = datetime.strptime(parts[0].strip(), "%Y-%m-%d %H:%M:%S")
        except Exception:
            continue
        if ts < cutoff:
            continue
        flag = parts[1].strip().upper()
        total += 1
        if flag.startswith("RED"):
            red += 1
        else:
            gray += 1
    return total, red, gray


def count_delta(aishared: Path) -> int:
    dec = aishared / "decisions.md"
    if not dec.is_file():
        return 0
    try:
        return sum(1 for ln in dec.read_text(encoding="utf-8", errors="replace").splitlines()
                   if DELTA_RE.match(ln))
    except Exception:
        return 0


def days_since_last_fire(aishared: Path):
    """距最近一个 codex-to-/gemini-to- handoff 的天数；无则 None。"""
    hd = aishared / "handoff"
    if not hd.is_dir():
        return None
    newest = None
    try:
        for f in hd.glob("*.md"):
            if f.name.startswith(FIRE_PREFIXES):
                m = f.stat().st_mtime
                if newest is None or m > newest:
                    newest = m
    except Exception:
        return None
    if newest is None:
        return None
    return int((datetime.now().timestamp() - newest) / 86400)


def context_stale_days(aishared: Path):
    """W0.2 记忆新鲜度：context.md 最后修改距今天数；文件缺失返回 None。
    动机：context.md 曾过期 8~11 天而全体 agent 仍按纪律先读它——软纪律下沉为机械告警。
    口径用 mtime（文件被真实收口才会更新），阈值 STALE_CONTEXT_DAYS=7。"""
    ctx = aishared / "context.md"
    if not ctx.is_file():
        return None
    try:
        return int((datetime.now().timestamp() - ctx.stat().st_mtime) / 86400)
    except Exception:
        return None


def check_drift():
    """开机实时比对最高价值双地落对（宪法 rules.md + 人格 output-style），返回三桶元组
    (drifted, broken, unverifiable)——**核验失败绝不吞成"一致"**（烛 dogfood 致命修复：
    原二态把 PermissionError/repo根异常静默返回空 → build_card 渲染成"一致 ✓"=假绿灯谎报健康，
    与 stop-gate 裸 token 前科同源）：
      · drifted:      hash 不一致 或 运行时文件缺失 → scripts/sync-runtime.ps1 -Apply 可修
      · broken:       仓库源文件缺失 → sync 救不了（仓库损坏），需人工查（烛建议2：源缺 sync 只 skip+fail）
      · unverifiable: repo 根解析失败/身份存疑/读取权限/hash 异常 → 核验没做成，展示时必须标红不当"一致"

    动机：2026-07-16 发现 rules.md 双地落方向倒挂（v3.4.1 只写运行时未回写源），一致性此前全靠人记得
    手动跑 sync；本函数把「开机照双地落健康」焊进体检卡。范围克制：全 15 对权威在 scripts/sync-runtime.ps1；
    此处只内联 2 语义最高对（宪法+人格）——改这两对路径须同步 sync-runtime.ps1。纯 hashlib（无子进程，
    守「同步快速执行」约束）。"""
    try:
        repo = Path(__file__).resolve().parents[2]  # .claude/hooks → .claude → 514cc(repo 根)
    except Exception:
        return [], [], ["repo根解析失败"]
    # repo 根身份校验（烛建议1）：parents[2] 被复制到同深度目录会监控错对象 → 判无法核验，不假绿灯
    if not (repo / "rules.md").is_file() or not (repo / "scripts" / "sync-runtime.ps1").is_file():
        return [], [], ["repo根存疑"]
    home = Path(os.environ.get("USERPROFILE") or os.path.expanduser("~"))
    pairs = [
        ("rules.md", repo / "rules.md", home / ".ai-collab" / "rules.md"),
        ("output-style", repo / "output-styles" / "aemeath-meta-butler.md",
         home / ".claude" / "output-styles" / "aemeath-meta-butler.md"),
    ]
    drifted, broken, unverifiable = [], [], []
    for name, src, dst in pairs:
        try:
            if not src.is_file():
                broken.append(name)       # 源缺失：sync 救不了，不能建议 -Apply
            elif not dst.is_file():
                drifted.append(name)      # 运行时缺失：-Apply 会创建
            elif hashlib.sha256(src.read_bytes()).hexdigest() != hashlib.sha256(dst.read_bytes()).hexdigest():
                drifted.append(name)
        except Exception:
            unverifiable.append(name)     # 读取/hash 异常：核验没做成，绝不当"一致"
    return drifted, broken, unverifiable


def check_soul_drift():
    """SOUL 全局方向中立哨兵（策 T2 / spec-architect-to-claude__soul-hardening-spec 加固点4-P0）。
    返回 (状态, 提示)，状态 ∈ {consistent, drift, unverifiable}。

    SOUL 是特殊资产：①全局生效（~/.claude/CLAUDE.md 影响所有项目，故本检测**独立于 cwd 门控**，在
    任何工作区开会话都查）②会被 LO 高频手改（与 sync 的 15 对"源唯一真相、单向覆盖"特性根本不同）
    →③**方向中立**：只报 src≠runtime、绝不建议 `-Apply`（守 D-2026-07-16-001 回滚教训——运行时才是
    新版时 -Apply 会静默抹掉手改）④**不纳入 sync-runtime.ps1**。纯 hashlib（守 SessionStart 快速约束）、
    绝对路径（不依赖 cwd）。核验失败绝不当"一致"（对齐 check_drift 三态，防假绿灯）。"""
    try:
        src = Path(__file__).resolve().parents[2] / "soul" / "CLAUDE.md"  # 仓库快照
        home = Path(os.environ.get("USERPROFILE") or os.path.expanduser("~"))
        dst = home / ".claude" / "CLAUDE.md"  # 运行时（全局生效）
    except Exception:
        return "unverifiable", "SOUL 路径解析失败"
    try:
        if not dst.is_file():
            return "unverifiable", "SOUL 运行时缺失（~/.claude/CLAUDE.md）"
        if not src.is_file():
            return "unverifiable", "SOUL 仓库快照缺失（soul/CLAUDE.md）"
        if hashlib.sha256(src.read_bytes()).hexdigest() == hashlib.sha256(dst.read_bytes()).hexdigest():
            return "consistent", ""
        # 方向中立：不判方向、不建议 -Apply，交人工 diff 决定
        return "drift", "SOUL 双地落漂移——人工 diff soul/CLAUDE.md ↔ ~/.claude/CLAUDE.md 决定方向（源为准→回写运行时；运行时为准→回写源）"
    except Exception:
        return "unverifiable", "SOUL 核验异常（权限/读取）"


def build_card(aishared: Path, soul_state: str = "unverifiable", soul_msg: str = "") -> str:
    total, red, gray = scan_route_gate(aishared)
    n_delta = count_delta(aishared)
    fire_days = days_since_last_fire(aishared)
    drifted, broken, unverifiable = check_drift()

    # 路由门行
    if total == 0:
        rg = f"无记录 ⚠️ 近 {RECENT_DAYS}d 路由门空转"
    else:
        idle = "（0 RED）" if red == 0 else ""
        rg = f"{total} 次（{red} RED / {gray} gray）{idle}"

    # 发火行
    if fire_days is None:
        fire = "⚠️ 从未真实发火（烛/织 武器库在睡觉）"
        idling = True
    elif fire_days >= STALE_FIRE_DAYS:
        fire = f"{fire_days} 天 ⚠️ 超 {STALE_FIRE_DAYS}d 空转"
        idling = True
    else:
        fire = f"{fire_days} 天"
        idling = False

    # 记忆新鲜度行（W0.2）：context.md 是全体 agent 的第一读取，过期即全局误判源
    ctx_days = context_stale_days(aishared)
    if ctx_days is None:
        ctx_line = "⚠️ context.md 缺失"
        idling = True
    elif ctx_days >= STALE_CONTEXT_DAYS:
        ctx_line = f"{ctx_days} 天未收口 ⚠️ 超 {STALE_CONTEXT_DAYS}d（先收口再开工）"
        idling = True
    else:
        ctx_line = f"{ctx_days} 天 ✓"

    # 双地落哨兵行（三态：一致/漂移/无法核验——核验失败绝不渲染成"一致"，烛 dogfood 致命修复）
    try:
        _sync = str(Path(__file__).resolve().parents[2] / "scripts" / "sync-runtime.ps1")
    except Exception:
        _sync = "scripts/sync-runtime.ps1"  # 烛建议3：优先绝对路径（hook 在任何含 514claude 的 cwd 生效）
    _parts = []
    if drifted:
        _parts.append(f"⚠️ 漂移 {'/'.join(drifted)}（跑 {_sync} -Apply）")
    if broken:
        _parts.append(f"⚠️ 源缺失 {'/'.join(broken)}（仓库损坏，-Apply 救不了）")
    if unverifiable:
        _parts.append(f"⚠️ 无法核验 {'/'.join(unverifiable)}（权限/路径/repo根异常）")
    drift_line = "一致 ✓" if not _parts else "；".join(_parts)

    # SOUL 全局哨兵行（策 T2）：方向中立，绝不出现 -Apply 字样
    if soul_state == "consistent":
        soul_line = "一致 ✓"
    elif soul_state == "drift":
        soul_line = f"⚠️ {soul_msg}"
    else:
        soul_line = f"⚠️ 无法核验（{soul_msg}）"

    # 判读行（只在有空转信号时出，避免无意义占行）
    verdict = ""
    if idling or total == 0:
        verdict = "\n· 判读：体系在自审空转、未上真实负载——把下一个真实任务直接交给它跑，灯才算开。"

    return (
        "【514cc 自省体检卡 · 开机自动】\n"
        f"· 路由门(近{RECENT_DAYS}d)：{rg}\n"
        f"· DELTA 账本：{n_delta} 条\n"
        f"· 距上次真实外部发火(烛/织)：{fire}\n"
        f"· 记忆新鲜度(context.md)：{ctx_line}\n"
        f"· 双地落哨兵(宪法/人格)：{drift_line}\n"
        f"· SOUL 哨兵(全局)：{soul_line}"
        f"{verdict}\n"
        "详情敲 /co-status。"
    )


def _anchor_match(cwd: str) -> bool:
    """完整体检卡的工作区判定——匹配**路径组件精确等于** WORKSPACE_ANCHOR，而非裸子串（烛 R3 建议2：
    裸子串会把 `514claude-backup`/`x514claude` 误判为 514 工作区、在对方 .ai-shared 写 mirror-gate.log）。
    注意：SOUL 全局告警**不**走此判定（它对任何 cwd 都送达）；此判定只决定"要不要出项目级完整体检卡"。"""
    try:
        return any(p.lower() == WORKSPACE_ANCHOR for p in Path(cwd).parts) if cwd else False
    except Exception:
        return False


# ===== 契约驱动重构（策 mirror-gate-hard-contract 规格，终结 R1-R5 五轮补丁循环）=====
# 构造相（INV9）：以下全部纯计算，**绝不碰 stdout**——所有异常在此吸收，降级=改选 payload。
def safe_build_card(aishared: Path, soul_state: str, soul_msg: str):
    """包 build_card 加 try，崩→None 降级（绝不碰 stdout）。"""
    try:
        return build_card(aishared, soul_state, soul_msg)
    except Exception:
        return None


def safe_dumps(obj):
    """INV4/INV5：json.dumps 崩（极罕见）也绝不产半段、绝不触发第二 write。崩→None。"""
    try:
        return json.dumps(obj, ensure_ascii=False)
    except Exception:
        return None


def _safe_wrap_dumps(wrap_fn, arg):
    """INV3/INV4 纵深（烛 R6 建议4）：wrap 构造 + json.dumps 全包 try——SOUL 告警最后一层包装抛也不吞。崩→None。"""
    try:
        return safe_dumps(wrap_fn(arg))
    except Exception:
        return None


def _wrap_card(card_body: str) -> dict:
    """体检卡 additionalContext 包装（卡内已含 SOUL 三态行，信息零丢失）。"""
    return {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": (
        "以下是 514cc 开机自省体检卡。请把【】卡片**逐字**放在你本会话首条回复的最顶部"
        "（这是体系『被 LO 看见』的机械承载，不可转述/省略/掩埋），再正常回应主人：\n\n"
        + card_body)}}


def _wrap_soul(soul_msg: str) -> dict:
    """纯 SOUL 全局告警 additionalContext 包装（非514/体检卡降级时；SOUL 全局生效）。"""
    return {"hookSpecificOutput": {"hookEventName": "SessionStart",
            "additionalContext": f"【514cc SOUL 全局哨兵】⚠️ {soul_msg}（在任何工作区都提示，因 SOUL 全局生效）"}}


def _parse_cwd(data) -> str:
    """从已解析 stdin data 取 cwd，规范化为字符串（非 dict/非字符串/缺失→""，不抛）。"""
    if not isinstance(data, dict):
        return ""
    cwd = data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR", "")
    return cwd if isinstance(cwd, str) else ""


def build_payload(stdin_raw: str):
    """构造相（INV9 核心）：纯计算、**绝不碰 stdout**。返回 (tag, json_str, aishared) | None。
    tag ∈ {"card","soul"}；aishared 仅 card 非 None（供输出相留痕）。R1-R5 所有崩溃点全部吸收在此，
    降级=构造相内改选 payload，绝无"输出失败回退再写"（那正是五轮病根）。"""
    # INV2 不假绿：check_soul_drift 崩→保持 fail-open 默认 unverifiable，绝不冒充 consistent
    soul_state, soul_msg = "unverifiable", "SOUL 状态计算未完成"
    try:
        soul_state, soul_msg = check_soul_drift()
    except Exception:
        pass
    # INV3 送达解耦：stdin 解析在构造相内，崩→data=None→cwd=""，绝不吞后续 SOUL 告警
    try:
        data = json.loads(stdin_raw) if stdin_raw else None
    except Exception:
        data = None
    cwd = _parse_cwd(data)
    if _anchor_match(cwd):                        # INV7 精确组件匹配（决定"要不要出体检卡"）
        aishared = find_aishared(cwd)             # 已自带 try
        if aishared is not None:
            card_body = safe_build_card(aishared, soul_state, soul_msg)   # 崩→None
            if card_body is not None:
                s = _safe_wrap_dumps(_wrap_card, card_body)               # wrap+dumps 全包 try（烛 R6 建议4）
                if s is not None:
                    return ("card", s, aishared)
        # 非514 / 无aishared / build_card 崩 / dumps 崩 → fall through 到 SOUL 降级（INV3）
    if soul_state != "consistent":                # INV3：SOUL 告警独立于以上全部门控/构造
        s = _safe_wrap_dumps(_wrap_soul, soul_msg)                        # _wrap_soul 抛也不吞 SOUL 告警（烛 R6 建议4）
        if s is not None:
            return ("soul", s, None)
    return None                                   # consistent 且无体检卡 → 静默不输出


def main() -> None:
    # 契约驱动重构（策 mirror-gate-hard-contract 规格，终结 R1-R5 五轮补丁循环）：
    # 送达从"两个输出点 + 失败回退再写"（partial-write/双JSON 结构病根）改为**单一输出点**——
    # 构造相 build_payload 纯计算二/三选一锁定唯一 payload；输出相单点 write 之后**代码里物理上不存在
    # 第二个 write**（已删 emit_soul_warning/card_written/所有回退）。INV9 构造/输出分离 ⇒ INV4 单JSON
    # ∧ INV5 无partial-write双段。fail-open(INV1)：任何异常 exit 0，绝不阻断 SessionStart。
    # 注：顶层 except 用 `except Exception`（不含 BaseException）——SystemExit 自然传播、不被吞（INV1 谓词）。
    try:
        stdin_raw = sys.stdin.read()
    except Exception:
        stdin_raw = ""
    try:
        result = build_payload(stdin_raw)         # 构造相：R1-R5 全部异常在此被吸收
    except Exception:
        result = None                             # 漏网异常 → 静默，fail-open（INV1）

    if result is None:
        return                                     # 无输出，exit 0

    # ===== 输出相（INV9）：解包 + 唯一 write 全纳入 try（烛 R6 建议3：INV1 自足，不耦合 build_payload 返回契约）=====
    flushed = False
    tag = aishared = None
    try:
        tag, payload, aishared = result            # 非 3-元组 → 解包异常在此吸收（fail-open，不冒泡）
        sys.stdout.write(payload)                 # 唯一 stdout.write（INV5）：partial-write 崩→except→绝不回退
        try:
            sys.stdout.flush()
            flushed = True
        except Exception:
            pass                                  # flush 崩不回退（write 已发，回退会造双段损坏）
    except Exception:
        return                                     # 解包/write 崩 → fail-open，无第二 write（INV1/INV5）

    # ===== 副作用相（INV6）：仅体检卡且 flush 成功才留痕；写文件不写 stdout =====
    # 有意 trade-off（策 §2.4，设计非遗漏）：体检卡 write 中途崩则本次不回退送 SOUL——用极低概率漏一次
    # （SOUL drift 是持久态、下次开机必再检出）换结构性根除双段损坏。前五轮病根正是不肯做此取舍。
    if tag == "card" and flushed and aishared is not None:
        try:
            ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            with open(aishared / "mirror-gate.log", "a", encoding="utf-8") as fp:
                fp.write(f"{ts}\tcard-injected\n")
        except Exception:
            pass
    return                                         # exit 0


if __name__ == "__main__":
    main()
