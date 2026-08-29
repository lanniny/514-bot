#!/usr/bin/env python3
"""514cc Codex Stop hook: strict, session-bound DELTA completion gate.

Only a handoff carrying exactly one marker for the current Codex session can
block Stop. Unmarked, foreign, conflicting, stale, unreadable, or otherwise
ambiguous artifacts fail open. The governed filename prefixes come from the
same repository registry as the Claude hook.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from contextlib import contextmanager
from pathlib import Path

if sys.platform.startswith("win"):
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

WORKSPACE_ANCHOR = "514claude"
FRESH_WINDOW_SEC = 24 * 3600
HANDOFF_SOURCE_REGISTRY = (
    Path(__file__).resolve().parents[2] / ".claude" / "hooks" / "handoff-sources.json"
)
DELTA_LINE_RE = re.compile(
    r"^__DELTA__:\s*(?P<agent>[^\s|](?:[^|\r\n]*[^\s|])?)\s*\|\s*"
    r"(?P<score>[012])\s*\|\s*(?P<category>[^\s|]*)\s*\|\s*(?P<evidence>\S(?:[^\r\n]*\S)?)\s*$"
)
DELTA_LINE_RE_LEGACY = re.compile(
    r"^__DELTA__:\s*(?P<agent>[^\s|](?:[^|\r\n]*[^\s|])?)\s*\|\s*"
    r"(?P<score>[012])\s*\|\s*(?P<evidence>\S(?:[^\r\n]*\S)?)\s*$"
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
    for parent in (base, *base.parents):
        candidate = parent / ".ai-shared"
        if candidate.is_dir():
            return candidate
    return None


def load_handoff_sources(
    registry_file: Path = HANDOFF_SOURCE_REGISTRY,
) -> tuple[tuple[str, str], ...]:
    raw = json.loads(registry_file.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("schemaVersion") != 1:
        raise ValueError("unsupported handoff source registry schema")
    sources = raw.get("sources")
    if not isinstance(sources, list) or not sources:
        raise ValueError("handoff source registry is empty")

    entries: list[tuple[str, str]] = []
    prefixes_seen: set[str] = set()
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
            if prefix in prefixes_seen:
                raise ValueError(f"duplicate handoff prefix: {prefix}")
            prefixes_seen.add(prefix)
            entries.append((prefix, source))
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


def load_seen(path: Path) -> set[str]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        values = raw.get("seen", []) if isinstance(raw, dict) else []
        return {value for value in values if isinstance(value, str)}
    except Exception:
        return set()


@contextmanager
def state_lock(path: Path, timeout_sec: float = 0.5):
    handle = path.open("a+b")
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        deadline = time.monotonic() + timeout_sec
        while True:
            try:
                handle.seek(0)
                if sys.platform.startswith("win"):
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Codex stop-gate state lock timed out")
                time.sleep(0.02)
        try:
            yield
        finally:
            handle.seek(0)
            if sys.platform.startswith("win"):
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()


def write_seen_atomic(path: Path, seen: set[str]) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        temporary.write_text(
            json.dumps({"schemaVersion": 2, "seen": sorted(seen)}, ensure_ascii=False),
            encoding="utf-8",
        )
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def _main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    if not isinstance(data, dict):
        return 0

    cwd_value = data.get("cwd") or os.getcwd()
    cwd = cwd_value if isinstance(cwd_value, str) else ""
    if WORKSPACE_ANCHOR not in cwd.replace("\\", "/").lower():
        return 0
    session_value = data.get("session_id") or data.get("session")
    session = session_value.strip() if isinstance(session_value, str) else ""
    if not SESSION_ID_RE.fullmatch(session):
        return 0

    aishared = find_aishared(cwd)
    handoff_dir = aishared / "handoff" if aishared else None
    if not handoff_dir or not handoff_dir.is_dir():
        return 0
    sources = load_handoff_sources()
    state_file = aishared / ".stop-gate-codex-state.json"
    now = time.time()
    violations: list[tuple[str, str, str, str]] = []

    for path in handoff_dir.glob("*.md"):
        source = handoff_source(path.name, sources)
        if source is None:
            continue
        try:
            info = path.stat()
            if now - info.st_mtime > FRESH_WINDOW_SEC:
                continue
            content = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        markers = SESSION_MARKER_RE.findall(content)
        if len(markers) != 1 or markers[0] != session:
            continue
        status = delta_status(content)
        if status == "valid":
            continue
        digest = hashlib.sha256(content.encode("utf-8", errors="replace")).hexdigest()[:24]
        fingerprint = f"{session}:{path.name}:{status}:{digest}"
        violations.append((path.name, source, status, fingerprint))

    if not violations:
        return 0

    try:
        with state_lock(aishared / ".stop-gate-codex-state.lock"):
            seen = load_seen(state_file)
            violations = [item for item in violations if item[3] not in seen]
            if violations:
                seen.update(item[3] for item in violations)
                write_seen_atomic(state_file, seen)
    except Exception:
        return 0
    if not violations:
        return 0

    rendered = [
        f"{name} [{source}; {'invalid DELTA' if status == 'invalid' else 'missing DELTA'}]"
        for name, source, status, _ in violations
    ]
    sys.stderr.write(
        "514cc Codex stop gate: session-owned handoff failed strict DELTA validation:\n  "
        + "\n  ".join(rendered)
        + "\nValid example: __DELTA__: 烛(Codex) | 1 | 证据：file:line 说明新增发现\n"
        + "The score must be one digit; labels such as 1补强 or 2推翻 are invalid.\n"
    )
    return 2


def main() -> int:
    try:
        return _main()
    except Exception:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
