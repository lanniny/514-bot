# Codex -> Claude Handoff: Codex Ultracode

- **date**: 2026-06-16
- **topic**: codex-ultracode
- **triggered_by**: LO request for Codex to have Claude ultracode capability
- **scope**: Codex skill/runtime/config/instructions/route-gate/project docs

## 致命问题

1. Claude `ultracode` should not be represented as a magic word alone. Current evidence shows it combines `xhigh` reasoning with dynamic workflow orchestration for substantive tasks.
2. Codex already had the reasoning side via `.codex/config.toml` `model_reasoning_effort = "xhigh"`, but lacked an executable workflow contract and runtime skill. Without that, "Codex ultracode" would be a soft promise, not a capability.

## 建议改进

1. Added `$ultracode` skill at `.agents/skills/ultracode/SKILL.md:1`. It defines triggers, operating contract, UC-1/UC-2/UC-3/UC-4 workflow shapes, fan-out limits, verification, and DELTA recording.
2. Added Codex instruction mapping at `.codex/instructions/aemeath-514cc-codex.md:41`: Codex ultracode = xhigh config + `$ultracode` dynamic workflow discipline, not a claim of Claude cloud Workflow parity.
3. Updated `.codex/hooks/route-gate-codex.py:30` to detect `ultracode`, `utralcode`, `ultra code`, "最强大脑", "深度完善", and related dynamic workflow phrases; it logs `uc` and prints a compact UC reminder.
4. Registered `$ultracode` in `scripts/sync-codex-runtime.ps1` and synced it to `~/.codex/skills/ultracode`.
5. Documented the capability in `module.yaml`, `CLAUDE.md`, `README.md`, `.codex/CLAUDE_SYNC.md`, `$514cc-collab`, and `$co-sync-codex`.

## 可保留

1. Existing Codex xhigh project config remains the reasoning baseline.
2. Existing 514cc route-gate, handoff, DELTA, and safety rules remain authoritative.
3. Claude cloud-native dynamic workflow is not claimed as directly copied; this is a Codex-native equivalent using available Codex tools, MCP, skills, and subagents.

## 总评

Codex now has a concrete ultracode-equivalent mode in 514cc:

- Trigger: explicit `ultracode` / `utralcode` / "最强大脑深度完善" style authorization.
- Reasoning: project xhigh.
- Workflow: `$ultracode` skill.
- Hook support: route-gate `uc` detection and reminder.
- Runtime: installed in `~/.codex/skills/ultracode`.

Verified:

- `$ultracode`, `$514cc-collab`, `$co-sync-codex` pass skill quick validation.
- repo/runtime Codex sync reports all mappings consistent.
- repo `.codex/config.toml`, runtime `~/.codex/config.toml`, `.codex/hooks.json`, and `module.yaml` parse successfully.
- Codex route-gate smoke test emits `UC=Codex Ultracode: xhigh + bounded dynamic workflow`.
- `~/.codex/skills/ultracode/SKILL.md` hash matches repo source.

__DELTA__: 烛(Codex) | 1 | governance | Converted LO's "Codex also needs Claude ultracode" request into a real Codex-native capability: xhigh config + `$ultracode` skill + route-gate UC trigger + runtime sync, while avoiding a false claim of Claude cloud Workflow parity.
