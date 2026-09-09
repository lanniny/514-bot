# 514cc Control Center

Local-first control plane and operator console for 514cc.

## Run

```powershell
cd I:\514claude\514cc\apps\control-center
npm start
```

The server binds to `127.0.0.1` only and prints a URL containing an ephemeral access token. The browser stores that token in session storage; API calls without it are rejected.

Core JSON configuration contracts are validated by a bounded Node worker. Full framework validation (including YAML/TOML and repository truth checks) additionally requires Python 3.11+ (`python -m pip install -r requirements-validation.txt`, then `npm run validate`).

Optional environment variables:

- `CONTROL_CENTER_PORT`: fixed loopback port; default `0` chooses an available port.
- `CONTROL_CENTER_DATA_DIR`: event/run/version state; default `.ai-shared/control-center` under the repository.
- `CONTROL_CENTER_OPEN=1`: request opening the browser after startup.

## Security model

- Repository sources are edited through optimistic locking, validation, backup, same-directory atomic replace, parse readback, and an append-only audit event.
- The generic source editor keeps runtime files read-only. Separate CC-Switch actions retain scoped write workflows for runtime configuration and Skills; these do not grant a CLI unrestricted access.
- Secret-bearing runtime files never return raw content.
- Claude Fable plans in `plan` mode. Codex starts read-only; write-capable execution requires an approval-bearing run.
- Grok Build runs on the official `responses` backend and is active for text and PNG/JPEG images (`image-analysis`); GIF/WebP/video remain conservatively rejected. `grok-search-rs` remains an MCP tool used by CLI/harness backends. The former `grok-search` runtime seat is retired and cannot be recreated.
- Routing no longer guesses capabilities: models/seats/members normalize to `["*"]`, and capability tags do not gate admission or scoring. Only special channels with a human-readable `reason` and `constraints.allowedProviders` may hard-limit candidates.
- Collaboration sessions have no total round cap: `round` is a monotonic audit sequence; each user message gets an independent `interaction` with a default 6-step autonomous budget, and the input stop key interrupts only the current provider turn.

## API

- `GET /api/bootstrap`, `/api/health`, `/api/events` (SSE)
- `GET /api/config/sources`, `/api/config/:id`, `/api/config/:id/versions`
- `POST /api/config/:id/validate|plan|apply|rollback`
- `POST /api/router/preview`
- `GET/POST /api/runs`, `GET /api/runs/:id`, `POST /api/runs/:id/cancel`
- `GET /api/providers`, `GET /api/providers/live`, `POST /api/providers/switch|preview|fetch-models|test-endpoints|usage-test|sort|export|import`
- `GET /api/providers/:id`, `POST /api/providers/:id/duplicate|check|model-test`, `GET /api/providers/:id/usage`
- `GET /api/runtime-seats`, `GET /api/teams`, `GET /api/team-members`, `GET /api/capabilities`, `GET /api/sessions`
- `GET /api/observability/summary|routegate|delta|handoffs|drift`
- The full endpoint surface lives in `public/api.js` and `src/*/routes.mjs`.

## Tests

```powershell
npm test
npm run probe
```

The test suite does not call paid model endpoints. Native Claude/Codex/Gemini/Pi conversation smoke tests are opt-in and must be run with an explicit budget/approval outside unit tests.

## Skill publication and navigation

Skill installation, updates, app toggles and confirmed removal use one publication unit for canonical files, selected live targets and domain metadata. Inputs are validated before replacement; unique backups avoid collisions with legitimate names such as `demo.old`. Shared or nested destinations cannot remove another active binding or canonical source.

Publication journals live under `CONTROL_CENTER_DATA_DIR/ccswitch/skill-transactions`; archives live under `CONTROL_CENTER_DATA_DIR/backups/skills`. An incomplete publication or failed rollback blocks domain writes with `SKILL_TRANSACTION_RECOVERY_REQUIRED`, including after restart. Keep journals, previous/staged directories and archives for review. Recovery is not automatic: inspect the affected files before an explicitly approved recovery. These journals are not a cross-process lock or a guarantee of power-loss atomicity.

The topbar history controller commits Back/Forward only after navigation accepts the route. Cancelling an unsaved seat draft does not consume a history entry. Bot Conversation/Run restoration carries its navigation owner through asynchronous loading so an obsolete completion cannot replace a newer selection.

Focused browser and HTTP proof (requires installed Chrome, uses an isolated home and unavailable CLI paths):

```powershell
node --experimental-sqlite scripts/qa-history-navigation.mjs --output-dir=C:/Temp/514Bot-history-proof
```
