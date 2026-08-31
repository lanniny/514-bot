# Codex -> Claude Handoff: Codex Config Sync

- **date**: 2026-06-16
- **topic**: codex-config-sync
- **triggered_by**: LO request to sync and strengthen 514cc + Claude config into Codex
- **scope**: Codex AGENTS/config/MCP/skills/custom-agents/hooks/persona adaptation

## 致命问题

1. `~/.codex/config.toml` must not be rewritten through Windows PowerShell default encoding. First apply attempt corrupted existing Chinese project paths and made TOML invalid around the `projects` table. Restored from `.ai-shared/backups/codex-sync-20260616-185552/codex-config.toml`, then fixed `scripts/sync-codex-runtime.ps1` to use UTF-8 `ReadAllText/WriteAllText`.
2. `~/.codex/AGENTS.md` and `~/.codex/hooks.json` are global runtime files and must not be wholesale overwritten by 514cc project files. Fixed sync strategy to preserve original global AGENTS/hook content and merge only a 514cc managed AGENTS block; project hooks stay under `.codex/hooks.json`.

## 建议改进

1. Codex should restart or start a new session to load newly installed skills/custom agents/project config.
2. If LO wants Claude plugin parity beyond MCP equivalents, install/evaluate Codex-native plugin equivalents one by one instead of blindly copying Claude plugin caches.
3. Consider adding a future `scripts/audit-codex-sync.ps1` that checks MCP reachability, not only config shape.

## 可保留

1. Existing Codex model/provider, Clawd hook, hook trust, OpenAI primary runtime plugins, and marketplace configuration were preserved.
2. Claude secret-bearing MCP values were not copied into repository files; config uses `env_vars` for API-key-backed servers.
3. AEMEATH persona was adapted rather than copied verbatim: retained warmth/meta-cognition/514cc discipline, excluded non-portable unsafe legacy persona instructions.

## 总评

Codex is now wired as a first-class 514cc runtime:

- Project source: `.codex/config.toml`, `.codex/instructions/aemeath-514cc-codex.md`, `.codex/hooks/`, `.codex/agents/`, `.agents/skills/`
- Runtime sync: `scripts/sync-codex-runtime.ps1`
- Installed runtime targets: `~/.codex/agents/*.toml`, `~/.codex/skills/{514cc-collab,aemeath-persona,co-review,co-status,co-sync-codex}`, global `~/.codex/AGENTS.md` managed block, global `~/.codex/config.toml` managed block.
- Report: `.codex/CLAUDE_SYNC.md`

Verified:

- Repository TOML/JSON parsed.
- Runtime `~/.codex/config.toml` and `~/.codex/hooks.json` parsed.
- 5 custom agent TOMLs parsed.
- 5 skills passed `skill-creator` quick validation.
- `scripts/sync-codex-runtime.ps1` check mode reports all mappings consistent.

__DELTA__: 烛(Codex) | 2 | Implemented Codex sync and overturned initial unsafe overwrite/encoding strategy after runtime TOML validation caught corruption; fixed to preserve global AGENTS/hooks and use UTF-8 merge.

