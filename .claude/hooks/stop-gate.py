#!/usr/bin/env python3
"""514cc Stop hook - enforce a well-formed DELTA ledger entry.

The hook only evaluates handoffs that can be associated with the current
Claude session. Exact ownership can be declared with this marker in a handoff:

    <!-- 514cc-session-id: <session_id> -->

Unmarked artifacts use a bounded best-effort window starting at the first
timestamp in ``transcript_path``. The fallback is recorded as
``session_time_window`` and is never described as exact current-session
ownership. An exact marker remains authoritative when the transcript is
missing or unreadable; only unmarked artifacts then fail open as unknown.

Loop prevention remains fail-open: one unchanged violation blocks at most once
per session. A modified file receives a new fingerprint and is evaluated again.
Any unexpected error allows Stop. Contract: https://code.claude.com/docs/en/hooks.md
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# stderr is the channel returned to Claude. Keep Chinese diagnostics readable
# on Windows hosts whose locale defaults to cp936.
if sys.platform.startswith("win") and hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

WORKSPACE_ANCHOR = "514claude"
FRESH_WINDOW_SEC = 24 * 3600
TRANSCRIPT_SCAN_BYTES = 1024 * 1024
TRANSCRIPT_SCAN_LINES = 256
HANDOFF_SOURCE_REGISTRY = Path(__file__).with_name("handoff-sources.json")

# Exactly: __DELTA__: <agent> | 0/1/2 | [category] | <non-empty evidence>
# Agent may not contain a pipe. Category is optional (backward compatible).
# Evidence may contain pipes (file:line alternatives).
DELTA_LINE_RE = re.compile(
    r"^__DELTA__:\s*(?P<agent>[^\s|](?:[^|\r\n]*[^\s|])?)\s*\|\s*(?P<score>[012])\s*\|\s*"
    r"(?P<category>[^\s|]*)\s*\|\s*(?P<evidence>\S(?:[^\r\n]*\S)?)\s*$"
)
DELTA_LINE_RE_LEGACY = re.compile(
    r"^__DELTA__:\s*(?P<agent>[^\s|](?:[^|\r\n]*[^\s|])?)\s*\|\s*(?P<score>[012])\s*\|\s*"
    r"(?P<evidence>\S(?:[^\r\n]*\S)?)\s*$"
)
DELTA_TOKEN_RE = re.compile(r"^__DELTA__:")
SESSION_MARKER_RE = re.compile(
    r"^<!--\s*514cc-session-id:\s*([^\s>]+)\s*-->\s*$", re.MULTILINE
)
SOURCE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")
PREFIX_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,63}$")
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")


def find_aishared(cwd: str) -> Path | None:
    base = Path(cwd) if cwd else Path.cwd()
    for parent in [base, *base.parents]:
        cand = parent / ".ai-shared"
        if cand.is_dir():
            return cand
    return None


def load_handoff_sources(registry_file: Path = HANDOFF_SOURCE_REGISTRY) -> tuple[tuple[str, str], ...]:
    """Load and validate the one source-of-truth for governed handoff prefixes."""
    raw = json.loads(registry_file.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("schemaVersion") != 1:
        raise ValueError("unsupported handoff source registry schema")
    sources = raw.get("sources")
    if not isinstance(sources, list) or not sources:
        raise ValueError("handoff source registry is empty")

    entries: list[tuple[str, str]] = []
    seen_prefixes: set[str] = set()
    for item in sources:
        if not isinstance(item, dict):
            raise ValueError("handoff source entry must be an object")
        source = item.get("id")
        prefixes = item.get("prefixes")
        if not isinstance(source, str) or not SOURCE_ID_RE.fullmatch(source):
            raise ValueError("invalid handoff source id")
        if not isinstance(prefixes, list) or not prefixes:
            raise ValueError(f"handoff source {source} has no prefixes")
        for prefix in prefixes:
            if not isinstance(prefix, str) or not PREFIX_RE.fullmatch(prefix):
                raise ValueError(f"invalid handoff prefix for {source}")
            if prefix in seen_prefixes:
                raise ValueError(f"duplicate handoff prefix: {prefix}")
            seen_prefixes.add(prefix)
            entries.append((prefix, source))

    # Longest-first makes overlapping future prefixes deterministic.
    return tuple(sorted(entries, key=lambda entry: len(entry[0]), reverse=True))


def handoff_source(name: str, sources: tuple[tuple[str, str], ...]) -> str | None:
    for prefix, source in sources:
        if name.startswith(prefix):
            return source
    return None


def delta_status(content: str) -> str:
    """Return valid only when every DELTA ledger line is strictly valid."""
    statuses: list[bool] = []
    for line in content.splitlines():
        if not DELTA_TOKEN_RE.match(line):
            continue
        # 新格式优先，兼容旧格式
        match = DELTA_LINE_RE.fullmatch(line) or DELTA_LINE_RE_LEGACY.fullmatch(line)
        statuses.append(match is not None)
    if not statuses:
        return "missing"
    return "valid" if all(statuses) else "invalid"


def _epoch(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        number = float(value)
        if number > 10_000_000_000:  # milliseconds
            number /= 1000
        return number if number > 0 else None
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except (ValueError, OverflowError):
        return None


def transcript_start(transcript_path: Any) -> tuple[float | None, str]:
    """Best-effort session start derived from bounded transcript input."""
    if not isinstance(transcript_path, str) or not transcript_path.strip():
        return None, "missing_transcript_path"
    path = Path(transcript_path)
    try:
        if not path.is_file():
            return None, "transcript_not_found"
        stamps: list[float] = []
        remaining = TRANSCRIPT_SCAN_BYTES
        with path.open("r", encoding="utf-8", errors="replace") as fp:
            for _ in range(TRANSCRIPT_SCAN_LINES):
                if remaining <= 0:
                    break
                line = fp.readline(remaining + 1)
                if not line:
                    break
                remaining -= len(line.encode("utf-8", errors="replace"))
                if remaining < 0:
                    break
                try:
                    row = json.loads(line)
                except (json.JSONDecodeError, TypeError):
                    continue
                if not isinstance(row, dict):
                    continue
                candidates = [row.get("timestamp"), row.get("created_at"), row.get("createdAt")]
                for nested_key in ("payload", "message"):
                    nested = row.get(nested_key)
                    if isinstance(nested, dict):
                        candidates.extend(
                            [nested.get("timestamp"), nested.get("created_at"), nested.get("createdAt")]
                        )
                stamps.extend(stamp for value in candidates if (stamp := _epoch(value)) is not None)
        if stamps:
            return min(stamps), "transcript_first_timestamp"

        stat_result = path.stat()
        birth = getattr(stat_result, "st_birthtime", None)
        if isinstance(birth, (int, float)) and birth > 0:
            return float(birth), "transcript_birth_time"
        if sys.platform.startswith("win") and stat_result.st_ctime > 0:
            return float(stat_result.st_ctime), "transcript_creation_time"
    except (OSError, ValueError):
        return None, "transcript_unreadable"
    return None, "transcript_start_unknown"


def artifact_binding(
    content: str,
    session_id: str,
    modified_at: float,
    started_at: float | None,
) -> str:
    """Classify exact marker ownership or the weaker transcript time window."""
    markers = SESSION_MARKER_RE.findall(content)
    if len(markers) > 1:
        return "conflicting_session_markers"
    if markers:
        return "exact_session_marker" if markers[0] == session_id else "foreign_session_marker"
    if started_at is None:
        return "unknown_session"
    # Two seconds tolerate filesystem timestamp granularity without pulling in
    # arbitrary pre-session files from the old 24-hour-only heuristic.
    return "session_time_window" if modified_at + 2 >= started_at else "before_session"


def binding_summary(stats: dict[str, int]) -> str:
    exact = stats.get("exact", 0) > 0
    window = stats.get("timeWindow", 0) > 0
    ambiguous = stats.get("ambiguousSession", 0) > 0
    if sum((exact, window, ambiguous)) > 1:
        return "mixed"
    if exact:
        return "exact_session_marker"
    if window:
        return "session_time_window"
    if ambiguous:
        return "unknown"
    return "none"


def append_audit(aishared: Path, **fields: Any) -> bool:
    record = {
        "schemaVersion": 1,
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        **fields,
    }
    try:
        with (aishared / "stop-gate.log").open("a", encoding="utf-8") as fp:
            fp.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        return True
    except Exception:
        return False


def load_seen(state_file: Path) -> set[str]:
    try:
        state = json.loads(state_file.read_text(encoding="utf-8"))
        raw_seen = state.get("seen", []) if isinstance(state, dict) else []
        return {item for item in raw_seen if isinstance(item, str)}
    except Exception:
        return set()


@contextmanager
def state_lock(lock_file: Path, timeout_sec: float = 0.5):
    """Cross-process advisory lock; timeout is handled by the caller as fail-open."""
    fp = lock_file.open("a+b")
    try:
        fp.seek(0, os.SEEK_END)
        if fp.tell() == 0:
            fp.write(b"0")
            fp.flush()
        deadline = time.monotonic() + timeout_sec
        while True:
            try:
                fp.seek(0)
                if sys.platform.startswith("win"):
                    import msvcrt

                    msvcrt.locking(fp.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(fp.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("stop-gate state lock timeout")
                time.sleep(0.02)
        try:
            yield
        finally:
            fp.seek(0)
            if sys.platform.startswith("win"):
                import msvcrt

                msvcrt.locking(fp.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(fp.fileno(), fcntl.LOCK_UN)
    finally:
        fp.close()


def write_seen_atomic(state_file: Path, seen: set[str]) -> None:
    temp_file = state_file.with_name(
        f".{state_file.name}.{os.getpid()}.{time.time_ns()}.tmp"
    )
    try:
        temp_file.write_text(
            json.dumps({"schemaVersion": 2, "seen": sorted(seen)}, ensure_ascii=False),
            encoding="utf-8",
        )
        os.replace(temp_file, state_file)
    finally:
        try:
            temp_file.unlink(missing_ok=True)
        except OSError:
            pass


def _exit(code: int) -> None:
    raise SystemExit(code)


def _main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        _exit(0)
    if not isinstance(data, dict):
        _exit(0)

    cwd = data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR", "")
    if not isinstance(cwd, str) or WORKSPACE_ANCHOR not in cwd.replace("\\", "/").lower():
        _exit(0)

    aishared = find_aishared(cwd)
    if not aishared:
        _exit(0)
    handoff_dir = aishared / "handoff"
    if not handoff_dir.is_dir():
        _exit(0)

    session_value = data.get("session_id")
    session = session_value.strip() if isinstance(session_value, str) else ""
    if not session:
        append_audit(
            aishared,
            event="evaluation_skipped",
            action="allow",
            sessionBinding="unknown",
            reason="missing_session_id",
        )
        _exit(0)
    if not SESSION_ID_RE.fullmatch(session):
        append_audit(
            aishared,
            event="evaluation_skipped",
            action="allow",
            sessionBinding="unknown",
            sessionId=session[:128],
            reason="invalid_session_id",
        )
        _exit(0)

    started_at, start_source = transcript_start(data.get("transcript_path"))

    try:
        sources = load_handoff_sources()
    except Exception as exc:
        append_audit(
            aishared,
            event="evaluation_skipped",
            action="allow",
            sessionBinding="unknown",
            sessionId=session[:128],
            reason="source_registry_unavailable",
            error=type(exc).__name__,
        )
        _exit(0)

    state_file = aishared / ".stop-gate-state.json"
    seen = load_seen(state_file)

    try:
        candidates = list(handoff_dir.glob("*.md"))
    except Exception:
        append_audit(
            aishared,
            event="evaluation_skipped",
            action="allow",
            sessionBinding="unknown",
            sessionId=session[:128],
            reason="handoff_scan_failed",
        )
        _exit(0)

    now = time.time()
    violations: list[tuple[str, str, str, str, str]] = []
    unverified_violations: list[dict[str, str]] = []
    stats = {
        "governed": 0,
        "valid": 0,
        "beforeSession": 0,
        "foreignSession": 0,
        "ambiguousSession": 0,
        "repeatAllowed": 0,
        "timeWindow": 0,
        "exact": 0,
    }
    for file in candidates:
        name = file.name
        source = handoff_source(name, sources)
        if source is None:
            continue
        stats["governed"] += 1
        try:
            file_stat = file.stat()
            if now - file_stat.st_mtime > FRESH_WINDOW_SEC:
                continue
            content = file.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue

        binding = artifact_binding(content, session, file_stat.st_mtime, started_at)
        if binding == "foreign_session_marker":
            stats["foreignSession"] += 1
            continue
        if binding == "conflicting_session_markers":
            stats["ambiguousSession"] += 1
            status = delta_status(content)
            if status != "valid":
                unverified_violations.append(
                    {"file": name, "source": source, "status": status, "binding": binding}
                )
            continue
        if binding == "unknown_session":
            stats["ambiguousSession"] += 1
            status = delta_status(content)
            if status != "valid":
                unverified_violations.append(
                    {"file": name, "source": source, "status": status, "binding": binding}
                )
            continue
        if binding == "before_session":
            stats["beforeSession"] += 1
            continue
        stats["exact" if binding == "exact_session_marker" else "timeWindow"] += 1

        status = delta_status(content)
        if status == "valid":
            stats["valid"] += 1
            continue
        if binding == "session_time_window":
            # A time correlation cannot establish ownership when two Claude
            # sessions run concurrently. Record the violation, but do not
            # block until a producer emits the exact session marker.
            unverified_violations.append(
                {"file": name, "source": source, "status": status, "binding": binding}
            )
            continue
        content_hash = hashlib.sha256(content.encode("utf-8", errors="replace")).hexdigest()[:24]
        fingerprint = f"{session}:{name}:{status}:{content_hash}"
        if fingerprint in seen:
            stats["repeatAllowed"] += 1
            continue
        violations.append((name, source, status, binding, fingerprint))

    if not violations:
        unverified_reason = "no_exact_violation"
        if unverified_violations:
            unverified_reason = (
                "unverified_time_window_only"
                if all(item["binding"] == "session_time_window" for item in unverified_violations)
                else "unverified_session_binding_only"
            )
        append_audit(
            aishared,
            event="evaluation",
            action="allow",
            sessionBinding=binding_summary(stats),
            sessionId=session[:128],
            sessionStartSource=start_source,
            reason=unverified_reason,
            stats=stats,
            unverifiedViolations=unverified_violations,
        )
        _exit(0)

    # Lock, re-read, merge, then atomically replace. The second read is what
    # prevents concurrent Stop hooks from losing each other's fingerprints.
    # Only block after this succeeds; any lock/write failure remains fail-open.
    try:
        with state_lock(aishared / ".stop-gate-state.lock"):
            latest_seen = load_seen(state_file)
            violations = [item for item in violations if item[4] not in latest_seen]
            if violations:
                latest_seen.update(item[4] for item in violations)
                write_seen_atomic(state_file, latest_seen)
    except Exception as exc:
        append_audit(
            aishared,
            event="evaluation",
            action="allow",
            sessionBinding=binding_summary(stats),
            sessionId=session[:128],
            sessionStartSource=start_source,
            reason="state_persist_failed",
            error=type(exc).__name__,
            violations=[item[0] for item in violations],
            unverifiedViolations=unverified_violations,
        )
        _exit(0)

    if not violations:
        stats["repeatAllowed"] += 1
        append_audit(
            aishared,
            event="evaluation",
            action="allow",
            sessionBinding=binding_summary(stats),
            sessionId=session[:128],
            sessionStartSource=start_source,
            reason="concurrent_violation_already_recorded",
            stats=stats,
            unverifiedViolations=unverified_violations,
        )
        _exit(0)

    append_audit(
        aishared,
        event="evaluation",
        action="block",
        sessionBinding=binding_summary(stats),
        sessionId=session[:128],
        sessionStartSource=start_source,
        stats=stats,
        violations=[
            {"file": name, "source": source, "status": status, "binding": binding}
            for name, source, status, binding, _ in violations
        ],
        unverifiedViolations=unverified_violations,
    )
    rendered = [
        f"{name} [{source}; {'DELTA 格式非法' if status == 'invalid' else '缺 DELTA'}; {binding}]"
        for name, source, status, binding, _ in violations
    ]
    sys.stderr.write(
        "会话时间窗内发现 handoff 缺少严格 DELTA 账本行（rules.md §三铁律3）：\n  "
        + "\n  ".join(rendered)
        + "\n合法示例： __DELTA__: 烛(Codex) | 1 | 证据：file:line 说明新增发现\n"
        "分数只能是单个 0、1 或 2；1补强/2推翻等带标签值不合法，证据不能为空。\n"
        "归属说明：exact_session_marker 为精确标记；session_time_window 仅是 transcript 起始时间后的"
        "best-effort 窗口，不声称文件一定由当前会话创建。本提醒对同一未修改违规文件只阻断一次。"
    )
    _exit(2)


def main() -> None:
    try:
        _main()
    except SystemExit:
        raise
    except Exception:
        # Harness invariant: an unexpected hook defect must never trap Stop.
        _exit(0)


if __name__ == "__main__":
    main()
