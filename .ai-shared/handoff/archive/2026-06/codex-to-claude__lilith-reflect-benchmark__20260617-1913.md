# Codex Handoff: lilith-reflect-benchmark

- **topic**: Lilith reflection candidate and benchmark expansion
- **date**: 2026-06-17
- **scope**: `lilith/pi-extension`, `lilith/scripts`, Lilith docs/skill
- **status**: implemented + validated

## Summary

Follow-up to `codex-to-claude__lilith-policy-hardening__20260617-1854.md`.

This pass moves Lilith beyond passive safety gates:

1. Adds `buildReflectionCandidates` to generate reviewable episode memory candidates from summary/decision/unresolved/evidence input.
2. Registers `lilith-reflect` in the Pi extension as candidate-only; it does not write durable memory.
3. Splits the benchmark runner into shared case definitions in `lilith/scripts/benchmark-cases.mjs`.
4. Converts the benchmark report from one aggregate case to 15 visible governance/memory/reflect cases.
5. Updates `lilith-core` skill, architecture, and benchmark suite docs to reflect the new candidate-only reflection and benchmark layout.

## Evidence

- Reflection candidate builder: `lilith/pi-extension/src/index.ts:258`.
- `lilith-reflect` command registration: `lilith/pi-extension/src/index.ts:403`.
- Shared benchmark cases: `lilith/scripts/benchmark-cases.mjs:1`.
- Thin regression test entry: `lilith/scripts/test-lilith-policy.mjs:1`.
- Multi-case benchmark runner: `lilith/scripts/run-lilith-benchmarks.mjs:1`.
- Benchmark suite runner and case map: `lilith/benchmark-suite.yaml:4`, `lilith/benchmark-suite.yaml:22`, `lilith/benchmark-suite.yaml:43`.
- Skill maintenance rules updated: `.agents/skills/lilith-core/SKILL.md:57`.
- Latest report: `lilith/benchmark-results.latest.json`.

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
Lilith policy regression tests passed (15 cases).
{"total":15,"passed":15,"failed":0}
Wrote I:\514claude\514cc\lilith\benchmark-results.latest.json
Lilith validation passed.
```

`quick_validate.py` for `.agents/skills/lilith-core` should be rerun after this handoff if further skill edits happen.

## Boundary

- `lilith-reflect` currently creates episode memory candidates only. Skill candidate generation is still pending.
- The benchmark runner now has 15 local regression cases, but not the full 20-case v1 suite and not Codex/OpenCode comparison results.
- No runtime sync to Pi/Codex/Claude/Cursor was performed.

## Next

1. Add skill-candidate generation to `lilith-reflect`.
2. Add coding/security benchmark cases until `min_cases_before_v1: 20` is met.
3. Add a runtime sync script with backup and validation gates.
4. Add live Pi extension event tests when a stable Pi extension harness is available.

__DELTA__: 烛(Codex) | 1 | 将 Lilith 从被动 policy gate 推进到 candidate-only reflection + 15-case benchmark runner，补强 Hermes curated-memory loop 的机械入口；仍不宣称 Codex/OpenCode parity。
