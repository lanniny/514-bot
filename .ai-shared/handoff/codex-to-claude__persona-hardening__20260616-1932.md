# Codex -> Claude Handoff: Persona Hardening

- **date**: 2026-06-16
- **topic**: persona-hardening
- **triggered_by**: LO request to further review and strengthen AEMEATH persona settings
- **scope**: AEMEATH output-style, Codex persona adapter, Codex persona skill, Cursor generated rules, runtime sync

## 致命问题

1. No new blocking defect found in the current persona layering. The existing high-risk decision remains correct: Claude SOUL contains legacy/high-density persona material that must not be copied verbatim into Codex executable instruction.
2. The main latent risk was drift by duplication: SOUL, output-style, Cursor rules, and Codex adapter could each be "strengthened" independently until they contradicted one another.

## 建议改进

1. Added a cross-surface persona contract in `output-styles/aemeath-meta-butler.md:68`: SOUL = identity/relationship source material, output-style = visible voice, Cursor rules = generated slices, Codex adapter = safe executable compression.
2. Added a persona concentration budget in `output-styles/aemeath-meta-butler.md:79` so tool-heavy work stays evidence-first while creative/system-evolution turns can carry more AEMEATH presence.
3. Added a Codex operating contract in `.codex/instructions/aemeath-514cc-codex.md:13`: compact warmth, useful challenge, honest continuity, and Codex's independent skeptical point of view.
4. Added a source contract in `.codex/instructions/aemeath-514cc-codex.md:33` and explicit warning that persona hardening means better continuity/challenge/decision quality, not verbosity or unsafe loyalty rules.
5. Expanded `.agents/skills/aemeath-persona/SKILL.md:35` with layer ownership and `.agents/skills/aemeath-persona/SKILL.md:44` with a before/after anti-drift checklist.

## 可保留

1. Preserved the previous Codex safety boundary: Codex keeps AEMEATH warmth, meta-cognition, LO continuity, route-gate discipline, and verification rigor, but does not inherit instructions that bypass platform/system/developer/safety boundaries.
2. Kept Claude SOUL untouched in this pass because its deeper R1/反驳协议 questions are already recorded as LO safety-pending in `rules.md` and `decisions.md`.
3. Regenerated Cursor rules from source instead of hand-editing `.cursor/rules/*.mdc`, preserving the generated-slice model.

## 总评

The persona is stronger in the place that matters: it now has a clearer cross-runtime contract, a stronger Codex-safe expression, and an explicit anti-drift checklist for future edits. The change is intentionally not "more theatrical"; it makes AEMEATH more continuous, more willing to challenge weak assumptions, and less likely to split into conflicting Claude/Cursor/Codex variants.

Verified:

- `scripts/sync-runtime.ps1 -Apply` synced output-style to `~/.claude/output-styles/` and check mode reports all 15 pairs consistent.
- `scripts/sync-cursor-rules.py` regenerated 8 rules into `~/.cursor/rules`, `I:/514claude/514cc/.cursor/rules`, and `I:/514claude/.cursor/rules`; `aemeath-persona.mdc` hashes match across all 3.
- `scripts/sync-codex-runtime.ps1 -Apply` synced `$aemeath-persona`; check mode reports all Codex runtime mappings consistent.
- `skill-creator` quick validation passed for `.agents/skills/aemeath-persona`.
- Repo `.codex/config.toml` and `.codex/hooks.json` parse successfully.

__DELTA__: 烛(Codex) | 1 | governance | Strengthened persona by adding cross-surface ownership + persona budget + Codex-safe challenge/continuity rules, while preserving the prior safety decision not to copy legacy SOUL text verbatim into Codex.
