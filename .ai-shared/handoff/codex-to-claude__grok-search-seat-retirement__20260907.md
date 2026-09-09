<!-- 514cc-session-id: 01a075e7-1614-7ce1-8205-c19ab6d1d8c8 -->

# Grok Search Seat Retirement

## Checkpoint

- Goal: LO explicitly requested permanent removal of Grok Search as a runtime seat because seat backends must be CLI or harness implementations.
- Completed: source registry removal, bundled defaults, adapter binding/template/factory/implementation removal, backend recreation rejection, default team and frontend preset cleanup, routing update, focused regression and isolated browser restart/readback.
- Preview: http://127.0.0.1:60665/?ui=cli-seats#config/sources?runtime=codex-technical
- Formal desktop executable replacement, migration of unrelated older installations and real MCP/provider execution remain partial, outside this activation.

## Ownership

Removed the exact grok-search profile from config/control-center/models.json and DEFAULT_SEATS. Removed grok-mcp-via-codex-app-server from the manifest, builtin bindings and factory table, and deleted src/adapters/grok-mcp.mjs. The backend rejects reuse of the retired profile ID even with a valid custom Codex adapter, and rejects the retired adapter under other IDs.

The default team retains Claude/Codex/Grok Build/Kimi/Pi. Existing other repository seats remain untouched. Research routes target codex-technical as a harness that can call configured MCP tools; route selection does not itself prove live search availability. Grok Search MCP declarations, its independent compatibility script and credentials remain outside this removal. Historical role/brand/usage mappings remain for old records and do not generate seat candidates.

Frontend quick tasks, fallback lists, team presets and suggestions no longer offer the retired seat. Updated QA fixtures and expectations so preview and new installs do not seed it again. Registry docs and module.yaml now reflect the removed executable adapter.

## Existing Data

Read-only structured inspection of I:/514claude/514cc/.ai-shared/control-center/team-members.json and teams.json found zero grok-search references. No formal cc-desktop.exe process was present during the check. No historical Conversation/Run records were changed, deleted or rebound.

Independent Store analysis noted that an unrelated older installation with persisted overrides or custom teams bound to grok-search would require a deliberate migration. This turn does not silently delete or rebind such records; ordinary missing-runtime compatibility checks continue to fail closed. The old adapter cannot load through the new manifest. This is not a claim that every older installation has been migrated.

## Evidence

Root: C:/Users/16643/.codex/visualizations/2026/09/06/01a075e7-1614-7ce1-8205-c19ab6d1d8c8/workspace/

- grok-seat-removal-tests.tap: final 162/162 passing across adapters, teams, router, presets, team UI, approval ownership, runtime seats HTTP, no-route ledger, portable defaults and HTTP end-to-end tests. Two obsolete tests for the deleted MCP seat implementation were removed; generic Codex MCP tests remain.
- npm run validate: all 13 validation results valid. UI lint has no new violations. Scoped diff check passed.
- grok-seat-removal-report.json: API seats, bootstrap team catalog and actual UI all contain the five default executable seats; template transports are local-cli/local-rpc. Page reload still has five seats and zero grok-search nodes.
- grok-seat-removed.png: inspected actual 1440x920 desktop screenshot showing five seats and no Grok Search.
- Current preview was gracefully stopped through its authenticated test shutdown endpoint after process ownership verification, then restarted on the same 60665 port with a new isolated fixture. Old temporary data was retained. Current launcher/server PIDs in preview.json are 48272/41172; verify ownership again before lifecycle operations.
- Independent read-only final review found no new issue in the manifest, factories, backend write gate, registry, defaults and built-in team. Pure-memory checks confirmed rejection of the retired ID including whitespace and custom valid-adapter variants. It did not inspect formal runtime or call a provider.

__DELTA__: Codex independent review | 1 | Evidence: src/team-members.mjs:658 and src/teams.mjs:428 identified persisted-reference risks; main-agent inspection confirmed zero current references and preserved unrelated history. Final manifest/factory/write-gate review found no bypass.
