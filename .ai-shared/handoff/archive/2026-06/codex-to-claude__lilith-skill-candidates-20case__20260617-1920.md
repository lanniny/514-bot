# Codex Handoff: lilith-skill-candidates-20case

- **topic**: Lilith skill-candidate reflection and 20-case local regression benchmark
- **date**: 2026-06-17
- **scope**: `lilith/pi-extension`, `lilith/scripts`, Lilith docs/skill
- **status**: implemented + validated

## Summary

Follow-up to `codex-to-claude__lilith-reflect-benchmark__20260617-1913.md`.

This pass completes the next local benchmark threshold:

1. `buildReflectionCandidates` now creates both `episode` and `skill_candidate` proposals.
2. `lilith-reflect` remains candidate-only; it still does not write durable memory.
3. Benchmark cases expanded from 15 to 20, meeting `benchmark-suite.yaml` `min_cases_before_v1: 20` for local regression coverage.
4. New cases cover skill-candidate generation/rejection and read-tool allow paths.

## Evidence

- Reflection candidate union and skill fields: `lilith/pi-extension/src/index.ts:59`.
- Skill-candidate generation path: `lilith/pi-extension/src/index.ts:321`.
- Reflection command candidate-only output: `lilith/pi-extension/src/index.ts:427`.
- Shared case source expanded: `lilith/scripts/benchmark-cases.mjs:130`.
- Benchmark acceptance count updated: `lilith/benchmark-suite.yaml:68`.
- Architecture states 20 local regression cases and skill candidates: `lilith/architecture.md:62`, `lilith/architecture.md:84`.
- Skill maintenance rule updated: `.agents/skills/lilith-core/SKILL.md:58`.

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
Lilith policy regression tests passed (20 cases).
{"total":20,"passed":20,"failed":0}
Wrote I:\514claude\514cc\lilith\benchmark-results.latest.json
Lilith validation passed.
```

## Boundary

- `min_cases_before_v1: 20` is now met for local regression coverage only.
- Codex/OpenCode comparison remains required before any parity claim.
- No runtime sync was performed.

## Next

1. Add explicit coding/security benchmark tasks that exercise real file edits in a disposable workspace.
2. Add competitor comparison report fields once Codex/OpenCode cases are run.
3. Add runtime sync script and install gates for Pi/Codex/Claude/Cursor.

__DELTA__: 烛(Codex) | 1 | security | Lilith 达到 20-case 本地 regression 门槛，并补上 skill_candidate 反思候选；但仍把 Codex/OpenCode parity 标为未验证边界。
