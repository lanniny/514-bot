# Codex Handoff: lilith-policy-hardening

- **topic**: Lilith Pi permission and memory gate hardening
- **date**: 2026-06-17
- **scope**: `lilith/pi-extension`, `lilith/scripts`, Lilith architecture/benchmark docs
- **status**: implemented + locally validated

## Summary

Follow-up to `codex-to-claude__lilith-integration-review__20260617-1814.md` `CHANGES_REQUESTED`.

This pass turns the main review findings into mechanical gates and regression tests:

1. Pi extension now reads permission/profile/memory policy from YAML-backed sources instead of hardcoded drift-prone subsets.
2. `Plan` / `Review` shell mutations are blocked for `tool_call` and `user_bash`.
3. `user_bash` uses Pi's actual result shape by returning a replacement `BashResult`-compatible result instead of invalid `{ block, reason }`.
4. Build writes are constrained to `permission-policy.yaml` roots; `LILITH_ROOT` no longer expands the authorization boundary.
5. Protected path checks normalize paths case-insensitively.
6. Profile lint is schema-driven and includes `主观体验`.
7. Memory candidate validation now rejects missing required fields, secret-like content, and Lilith persona self-narrative as durable memory.
8. `validate-lilith.ps1` now runs YAML parse, policy/memory regression tests, the benchmark runner, and a focused TypeScript check for the Pi extension.

## Evidence

- Permission source fixed at repository profile root: `lilith/pi-extension/src/index.ts:11`.
- Policy loader exported and YAML-backed: `lilith/pi-extension/src/index.ts:83`.
- Tool gate evaluator covers shell/custom mutation tools and build roots: `lilith/pi-extension/src/index.ts:195`.
- User shell gate evaluator and Pi-compatible replacement result: `lilith/pi-extension/src/index.ts:230`, `lilith/pi-extension/src/index.ts:284`, `lilith/pi-extension/src/index.ts:337`.
- Memory candidate gate: `lilith/pi-extension/src/index.ts:258`.
- Regression coverage for shell/user_bash/custom tools/build roots/protected paths/env-root/profile/memory: `lilith/scripts/test-lilith-policy.mjs:52`, `lilith/scripts/test-lilith-policy.mjs:104`, `lilith/scripts/test-lilith-policy.mjs:116`.
- Validate script now checks `user_bash`, exported policy/memory evaluators, YAML parse, policy regression, and TypeScript: `lilith/scripts/validate-lilith.ps1:151`, `lilith/scripts/validate-lilith.ps1:161`, `lilith/scripts/validate-lilith.ps1:213`, `lilith/scripts/validate-lilith.ps1:249`.
- Benchmark runner writes a structured latest report: `lilith/scripts/run-lilith-benchmarks.mjs`, `lilith/benchmark-results.latest.json`.
- `yaml` dependency is exact: `lilith/pi-extension/package.json:14`.
- Architecture/benchmark docs updated without claiming full benchmark parity: `lilith/architecture.md:61`, `lilith/architecture.md:76`, `lilith/benchmark-suite.yaml:22`, `lilith/benchmark-suite.yaml:34`.

## Verification

Passed:

```powershell
I:/514claude/514cc/lilith/scripts/validate-lilith.ps1
```

Output:

```text
I:\514claude\514cc\module.yaml ok
I:\514claude\514cc\lilith\profile-schema.yaml ok
I:\514claude\514cc\lilith\memory-schema.yaml ok
I:\514claude\514cc\lilith\runtime-map.yaml ok
I:\514claude\514cc\lilith\permission-policy.yaml ok
I:\514claude\514cc\lilith\benchmark-suite.yaml ok
Lilith policy regression tests passed.
{"total":1,"passed":1,"failed":0}
Wrote I:\514claude\514cc\lilith\benchmark-results.latest.json
Lilith validation passed.
```

Also passed standalone:

```powershell
$env:NODE_PATH='G:\tasks\pi proxy\node_modules'
G:/tasks/pi proxy/node_modules/.bin/tsx.cmd I:/514claude/514cc/lilith/scripts/test-lilith-policy.mjs
```

## Boundary

- This does **not** claim Lilith has reached Claude/Codex/OpenCode parity. It hardens the permission and memory-policy layer enough to continue toward that bar.
- Benchmark suite entries are marked as local regression coverage, not competitor comparison results.
- No runtime sync to `~/.pi`, `~/.codex`, `~/.claude`, or `~/.cursor` was performed in this pass.
- A `codex-reviewer` sidecar was attempted for independent read-only review, but `wait_agent` returned `not_found`; no sidecar finding is counted as evidence.

## Next

1. Add an executable benchmark runner with at least the covered governance/memory cases before any parity statement.
2. Add Pi live harness tests or extension event simulation once the Pi runtime test API is pinned.
3. Implement `lilith-reflect` as candidate generation only, with no direct durable memory writes.
4. Add runtime sync script only after validation remains green.

__DELTA__: 烛(Codex) | 2 | correctness | 推翻初始 "Pi permission skeleton can serve as safety gate" 状态：`user_bash` 返回类型、env-root 扩权、policy drift 和 memory prompt-only 均改为可测试 gate，证据见 `lilith/pi-extension/src/index.ts:195`, `lilith/pi-extension/src/index.ts:337`, `lilith/scripts/test-lilith-policy.mjs:52`, `lilith/scripts/validate-lilith.ps1:249`.
