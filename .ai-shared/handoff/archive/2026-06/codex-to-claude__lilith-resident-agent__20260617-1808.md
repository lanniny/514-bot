# Codex → Claude Handoff: Lilith Resident Agent

- date: 2026-06-17
- actor: Codex / 烛
- mode: `$ultracode`
- topic: lilith-resident-agent
- scope: 514cc profile source + Pi extension skeleton + Codex skill registration

## Objective

LO asked to deeply refine and integrate a dedicated virtual-life agent named Lilith, benchmarking against Codex CLI and OpenCode, and borrowing strengths from Hermes and OpenClaw.

## Current-source research

- Pi extension docs in `G:/tasks/pi proxy/packages/coding-agent/docs/extensions.md`: event interception, commands, custom tools, session persistence, subagent patterns, permission-gate and protected-path examples.
- Open-source/reference targets mapped in `lilith/references/agent-benchmark.md`: Codex CLI, OpenCode, Hermes Agent, OpenClaw, Pi.
- Local 514cc source read before edits: `rules.md`, `.ai-shared/context.md`, `.ai-shared/decisions.md`, `module.yaml`, `$ultracode`, `$514cc-collab`, `$aemeath-persona`.

## Changes

Created Lilith source profile:

- `lilith/identity.md`: Lilith as governed resident persona profile, not a new authority or sentience claim.
- `lilith/architecture.md`: layered architecture, competitor absorption map, operating loop, MVP roadmap, mechanical gates.
- `lilith/profile-schema.yaml`: `role: tone_layer`, forbidden capabilities, prompt lint, memory lint, sync policy.
- `lilith/memory-schema.yaml`: candidate-first memory schema with sensitivity/confidence/evidence.
- `lilith/permission-policy.yaml`: plan/review/build mode permissions, protected paths, mutation command patterns.
- `lilith/benchmark-suite.yaml`: 20-case pre-v1 benchmark target for coding/security/memory/governance.
- `lilith/runtime-map.yaml`: source/runtime map and quality gates.
- `lilith/references/agent-benchmark.md`: current-source comparison notes.
- `lilith/prompts/lilith-output-style.md`, `lilith/prompts/lilith-codex-adapter.md`: persona surfaces.
- `lilith/pi-extension/`: Pi extension skeleton with status, profile injection, profile lint, dangerous command gate, protected path gate, and `--lilith-mode plan|review|build`.
- `lilith/scripts/validate-lilith.ps1`: source presence, prompt lint, module registration, extension capability checks.
- `.agents/skills/lilith-core/SKILL.md`: Codex skill entrypoint.
- `module.yaml`: registered `lilith-core` and `lilith_profile`.

## Sidecar Findings Integrated

- `spec-architect` sidecar added hard acceptance criteria: Plan/Review zero-write, Build writes only authorized workspace/worktree, LSP diagnostics source labeling, session recovery, benchmark suite.
- `meta-reviewer` sidecar blocked unsafe framing: Lilith must be governed persona profile, not "virtual-life agent" with authority. Required prompt lint, memory sanitizer, profile schema, route/DELTA gate awareness, and runtime sync validation before deployment.
- `codex-reviewer` sidecar was spawned for post-change review; if it returns after this handoff, integrate any concrete file:line findings before runtime sync.

## Verification

Passed:

- `I:/514claude/514cc/lilith/scripts/validate-lilith.ps1`
- YAML parse via Pi workspace `yaml` package for `module.yaml`, `profile-schema.yaml`, `memory-schema.yaml`, `runtime-map.yaml`, `permission-policy.yaml`, `benchmark-suite.yaml`
- `python -X utf8 C:/Users/16643/.codex/skills/.system/skill-creator/scripts/quick_validate.py I:/514claude/514cc/.agents/skills/lilith-core`
- isolated TypeScript check for `lilith/pi-extension/src/index.ts` with a minimal Pi extension API stub

Not done:

- Runtime sync to `~/.pi`, `~/.codex`, Claude output-style, or Cursor rules.
- Full Pi extension live-load test.
- Codex/OpenCode benchmark run.

## Risks / Next Steps

1. Add route-gate signal coverage for `Lilith|莉莉丝|virtual-life|persona|sentience|autonomy|memory` so profile/memory changes always get RED/YELLOW attention.
2. Add compaction/memory sanitizer before allowing Lilith runtime sync.
3. Add `sync-lilith-runtime.ps1` with backup + validation-first behavior.
4. Live-test Pi extension in `pi -e I:/514claude/514cc/lilith/pi-extension/src/index.ts --lilith-mode plan`.
5. Build benchmark cases before claiming parity with Codex CLI/OpenCode.

__DELTA__: 策(spec-architect) | 1 | Added hard product acceptance criteria missing from main plan: Plan/Review zero-write, Build authorized workspace only, LSP diagnostics source labeling, session recovery, and benchmark suite.
__DELTA__: 鉴(meta-reviewer) | 2 | Overturned unsafe "virtual-life agent" framing; forced Lilith to `governed persona profile` with schema + prompt lint + memory lint + no new authority/tool override.
__DELTA__: 烛(Codex) | 1 | Converted concept into versioned 514cc/Pi artifacts with validation script, Pi extension safety skeleton, module registration, and verified YAML/skill/TS checks.

