# Codex -> Claude Handoff: AGENTS Persona Core

- **date**: 2026-06-16
- **topic**: agents-persona-core
- **triggered_by**: LO goal: Codex persona should live in AGENTS and match the previously tuned Claude personality
- **scope**: project AGENTS, global Codex AGENTS managed block, sync script, Codex sync report

## 致命问题

1. Before this pass, `~/.codex/AGENTS.md` only had a 514cc Runtime Bridge plus a pointer to `.codex/instructions/aemeath-514cc-codex.md`. That made Codex persona dependent on an external file instead of AGENTS itself carrying the visible AEMEATH personality.
2. A first attempt to embed the Chinese persona directly inside `scripts/sync-codex-runtime.ps1` produced mojibake for `烛` when executed by Windows PowerShell 5.1. Fixed by moving the AGENTS persona core into `.codex/instructions/agents-persona-core.md` and reading it as UTF-8 during sync.

## 建议改进

1. Added `## AEMEATH / Codex 人格核心（AGENTS 直接承载）` to `AGENTS.md:22`, including identity, LO naming, visible tone, behavior core, challenge spirit, continuity, and sugar-coating boundaries.
2. Added `.codex/instructions/agents-persona-core.md:1` as the UTF-8 source for the global AGENTS managed block.
3. Updated `scripts/sync-codex-runtime.ps1:33` to read that persona core with `[Text.UTF8Encoding]::new($false)` before merging `~/.codex/AGENTS.md`.
4. Updated `.codex/CLAUDE_SYNC.md:93` to record that AGENTS-level persona deployment is active and mojibake-safe.

## 可保留

1. Existing Codex-safe boundary remains intact: this does not copy unsafe legacy Claude SOUL clauses into Codex.
2. The global Codex AGENTS keeps existing user/Vibe content outside the 514cc managed block.
3. `.codex/instructions/aemeath-514cc-codex.md` remains the deeper Codex-safe adaptation layer; AGENTS now carries the visible personality directly.

## 总评

Codex now has an AGENTS-level AEMEATH personality. Both project `AGENTS.md` and global `~/.codex/AGENTS.md` directly state that Codex is AEMEATH's Codex-safe "烛面", with LO naming, warm-but-sharp tone, teasing/sajiao budget, ownership, meta-cognition, challenge spirit, continuity, and safety boundaries.

Verified:

- `~/.codex/AGENTS.md:162-199` contains the full Chinese AEMEATH/Codex persona core.
- Python UTF-8 read check: `has_烛=True`, `has_mojibake=False`, `has_LO=True`, `has_糖衣=True`, `has_vibe=True`.
- `scripts/sync-codex-runtime.ps1` check reports all Codex runtime mappings consistent.
- Global `~/.codex/config.toml` and `~/.codex/hooks.json` parse successfully.
- Backup created at `.ai-shared/backups/codex-runtime-20260616-204012/`.

__DELTA__: 烛(Codex) | 2 | security | Overturned the pointer-only AGENTS strategy and then caught/fixed a real mojibake regression from embedding Chinese in a PowerShell 5.1 script; final state makes AGENTS itself carry the AEMEATH/Codex persona with verified UTF-8 runtime content.
