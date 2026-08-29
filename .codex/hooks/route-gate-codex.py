#!/usr/bin/env python3
"""514cc Codex UserPromptSubmit hook.

Codex hook contracts differ from Claude's; this hook is intentionally conservative:
it logs route-gate evidence and prints a compact reminder for hook UIs that surface stdout.
The durable behavior still lives in AGENTS.md and .codex/instructions/.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

if sys.platform.startswith("win"):
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

WORKSPACE_ANCHOR = "514claude"

# F-069: 从外部配置文件加载触发词（单一真源）
def load_route_signals(cwd: str) -> dict | None:
    """Load route-signals.json from config/control-center/ if available."""
    base = Path(cwd) if cwd else Path.cwd()
    for parent in [base, *base.parents]:
        cand = parent / "config" / "control-center" / "route-signals.json"
        if cand.exists():
            try:
                return json.loads(cand.read_text(encoding="utf-8"))
            except Exception:
                return None
    return None

# 尝试加载外部配置，失败则使用硬编码默认值
_signals_config = load_route_signals(os.getcwd())
if _signals_config:
    RED_SIGNALS = [(s["pattern"], s["tag"]) for s in _signals_config.get("redSignals", [])]
    UC_SIGNALS = _signals_config.get("ucSignals", [])
    DIV_SIGNALS = _signals_config.get("divSignals", [])
else:
    # Fallback to hardcoded defaults
    RED_SIGNALS = [
        (r"评审|审查|code\s*review|\breview\b", "review"),
        (r"安全|security|漏洞|vuln|注入攻击|sql\s*inject|鉴权|越权|\bauth\b", "security"),
        (r"性能|\bperf\b|优化|optimiz|瓶颈|latency|吞吐", "perf"),
        (r"部署|deploy|生产环境|上线|发布到|\bprod\b", "deploy"),
        (r"调研|最新|对比|竞品|官方文档|查一下|\bsearch\b|\bresearch\b|搜索", "research"),
    ]
    UC_SIGNALS = [
        r"\bultra\s*code\b|\bultracode\b|\butralcode\b|Codex\s*ultra|Claude\s*ultra|最强大脑|深度完善|全面审查体系|动态\s*workflow|dynamic\s*workflow",
    ]
    DIV_SIGNALS = [
        r"怎么设计|如何设计|架构设计|技术方案|设计方案|实现方案|解决方案|思路|有没有更好|重构|选型|取舍|权衡|\b(architecture|refactor|tradeoff|approach)\b",
    ]
NOISE_BLOCK = re.compile(r"<task-notification>.*?</task-notification>|<tool-use-id>.*?</tool-use-id>|<task-id>.*?</task-id>", re.S)
MCP_NOISE = re.compile(r"✔\s*connected|connected\s*·|·\s*✔|web-search-prime|web-reader", re.I)


def find_aishared(cwd: str) -> Path | None:
    base = Path(cwd) if cwd else Path.cwd()
    for parent in [base, *base.parents]:
        cand = parent / ".ai-shared"
        if cand.is_dir():
            return cand
    return None


def strip_noise(text: str) -> str:
    text = NOISE_BLOCK.sub(" ", text)
    return "\n".join(line for line in text.splitlines() if not MCP_NOISE.search(line))


def _main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}

    cwd_value = data.get("cwd") or os.getcwd()
    cwd = cwd_value if isinstance(cwd_value, str) else ""
    prompt_value = data.get("prompt") or data.get("user_prompt") or data.get("input") or ""
    prompt = prompt_value if isinstance(prompt_value, str) else ""
    session_value = data.get("session_id") or data.get("session")
    session_id = session_value.strip() if isinstance(session_value, str) else ""
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", session_id):
        session_id = ""
    if WORKSPACE_ANCHOR not in cwd.replace("\\", "/").lower():
        return 0

    judge = strip_noise(prompt)
    tags = []
    for pattern, tag in RED_SIGNALS:
        if re.search(pattern, judge, re.IGNORECASE):
            tags.append(tag)
    tags = list(dict.fromkeys(tags))
    uc_hit = any(re.search(pattern, judge, re.IGNORECASE) for pattern in UC_SIGNALS)
    div_hit = any(re.search(pattern, judge, re.IGNORECASE) for pattern in DIV_SIGNALS)

    try:
        aishared = find_aishared(cwd)
        if aishared:
            ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            flag = "RED " if tags else "gray"
            reason = ",".join(tags + (["uc"] if uc_hit else []) + (["div"] if div_hit else [])) or "-"
            one_line = prompt.replace("\r", " ").replace("\n", " ")[:100]
            with open(aishared / "route-gate.codex.log", "a", encoding="utf-8") as fp:
                fp.write(f"{ts}\t{flag}\t{reason}\tunknown\t{one_line}\n")
    except Exception:
        pass

    route_hit = bool(tags or div_hit or uc_hit)
    if route_hit or session_id:
        msg = "514cc route gate: " if route_hit else "514cc handoff context: "
        if tags:
            msg += "RED=" + ",".join(tags) + "; "
        if uc_hit:
            msg += "UC=Codex Ultracode: xhigh + bounded dynamic workflow; "
        if div_hit:
            msg += "DIV=先发散2-3个互斥角度再收敛; "
        if session_id:
            msg += (
                f"handoff marker=<!-- 514cc-session-id: {session_id} -->; "
                "DELTA example=__DELTA__: 烛(Codex) | 1 | 证据：file:line 说明新增发现; "
                "choose one numeric score from 0, 1, or 2; "
            )
        print(msg.strip())
    return 0


def main() -> int:
    try:
        return _main()
    except Exception:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
