# Codex → Claude Handoff: Ultracode Open Source Audit

## 背景

LO 要求“仔细核对开源项目 ultracode，审查全部是否合理完善”。本轮核对两个当前开源项目：

1. `PabloNAX/ultracode-skill`：Codex-first skill，核心是用 `SKILL.md` 让 Codex 执行 dynamic workflow discipline。
2. `OnlyTerp/UltraCode-Shim`：Claude Code 代理/模型路由 shim，核心是把 UltraCode envelope 和 orchestrator/worker/model router 通过本地 proxy 注入其他后端。

结论：514cc 当前 `$ultracode` 的 xhigh、route-gate 触发、runtime sync、DELTA 账本方向是合理的，但比 `PabloNAX/ultracode-skill` 少了可审计 workflow artifacts、packet schema、eval contracts、approval gates。本轮已吸收这些机制。`UltraCode-Shim` 的 proxy/model-router/reliability 机制有参考价值，但属于凭据/代理/模型路由风险面，本轮不纳入 `$ultracode` skill。

## 上游审查

### PabloNAX/ultracode-skill

合理点：

- 明确“skill，不是 runtime”，尊重 host/system rules；见 `.ai-shared/tmp/ultracode-open-source-review/ultracode-skill/ultracode/SKILL.md:10`。
- 要求非平凡任务创建 workflow artifacts；见 README `Workflow files` 与 `SKILL.md:17` / `:141`。
- 区分 Direct / Workflow / Delegated 模式，并要求 Codex 使用 native `spawn_agent`，不是伪造本地 runner；见 `SKILL.md:131`。
- reference 分层完整：packet schema、eval contracts、approval gates、execution examples、forward testing。

不足/边界：

- 只是 skill，不提供强制执行 runtime；最终仍依赖模型遵守。
- 没有 514cc 的 route-gate / stop-gate / DELTA / runtime sync 体系。
- 对 514cc 来说，原样引入 `.workflow/ultracode/` 会与 `.ai-shared/handoff` 产生双账本，需要适配。

### OnlyTerp/UltraCode-Shim

合理点：

- 把 orchestrator 与 worker 模型拆开，降低长 workflow 的成本/限流风险；见 README `Orchestrator + Worker`。
- Auto Router 用 classifier 选择后端，且有 fallback 思路；见 README `Auto Router`。
- 对 empty turns、idle stream、tool-call repair 有可靠性处理，适合长代理运行。

不采纳原因：

- 这是本地 proxy/model-router，不是 Codex skill；需要处理凭据、后端路由、API 转译和 provider terms。
- 可能改变模型/worker 流量归属，不适合静默并入 514cc 的 `$ultracode`。
- 514cc 目前需要的是可审计 workflow discipline，不是新网络代理。

## 本轮改动

1. `.agents/skills/ultracode/SKILL.md`
   - 明确 “skill, not hidden runtime/proxy/official feature”。
   - 新增 First Pass 分类：task type、risk、blast radius、verification、delegation、eval contract、approval gates。
   - 重构模式：Direct / Workflow / Delegated / Research+Build / 514cc Self-Evolution。
   - 新增 `.workflow/ultracode/<run-slug>/` artifact contract。
   - 新增 eval contracts 与 approval gates。
   - 明确不复制 `UltraCode-Shim` 的 proxy/router 行为，除非 LO 单独授权并接受凭据/路由风险。

2. `.agents/skills/ultracode/references/`
   - 新增 `packet-schema.md`
   - 新增 `eval-contracts.md`
   - 新增 `approval-gates.md`

3. `module.yaml`
   - `codex_runtime` 新增 `ultracode_workflow_artifacts`。
   - note 改为：Codex parity = xhigh + workflow discipline + artifacts/eval contracts/approval gates；不是 Claude cloud Workflow parity，也不是 proxy/model-router。

4. Runtime sync
   - `scripts/sync-codex-runtime.ps1 -Apply` 同步 `$ultracode` 到 `C:/Users/16643/.codex/skills/ultracode`。
   - 运行时备份：`.ai-shared/backups/codex-runtime-20260618-024046/`。

## 证据

- `.agents/skills/ultracode/SKILL.md:10` skill/runtime/proxy 边界
- `.agents/skills/ultracode/SKILL.md:30` First Pass
- `.agents/skills/ultracode/SKILL.md:120` Workflow Artifacts
- `.agents/skills/ultracode/SKILL.md:146` Eval Contracts
- `.agents/skills/ultracode/SKILL.md:167` Approval Gates
- `.agents/skills/ultracode/SKILL.md:178` UltraCode-Shim proxy/router 不静默采纳
- `.agents/skills/ultracode/references/packet-schema.md:1`
- `.agents/skills/ultracode/references/eval-contracts.md:1`
- `.agents/skills/ultracode/references/approval-gates.md:1`
- `module.yaml:195-199`

## 验证

```text
module.yaml ok
ultracode frontmatter ok
ultracode references ok
python -m py_compile .codex/hooks/route-gate-codex.py .codex/hooks/mirror-gate-codex.py .codex/hooks/stop-gate-codex.py
```

```text
scripts/sync-codex-runtime.ps1 -Apply
skill:ultracode          ≠ drift
Backup: I:\514claude\514cc\.ai-shared\backups\codex-runtime-20260618-024046
skill:ultracode          ✓ synced
Codex runtime sync complete.
```

```text
scripts/sync-codex-runtime.ps1
agent:codex-reviewer     = consistent
agent:gemini-researcher  = consistent
agent:embedded-expert    = consistent
agent:spec-architect     = consistent
agent:meta-reviewer      = consistent
skill:514cc-collab       = consistent
skill:aemeath-persona    = consistent
skill:co-review          = consistent
skill:co-status          = consistent
skill:co-sync-codex      = consistent
skill:ultracode          = consistent
global-agents-block      = consistent
config-managed-block     = consistent
All Codex runtime mappings are consistent.
```

```text
ultracode runtime tree hash ok: 4 files
```

## Verdict

`__VERDICT__: ACCEPTED_WITH_FIXES`

514cc 原 `$ultracode` 方向合理：xhigh + route-gate + runtime sync + DELTA 是正确骨架。但它不够完善，因为缺少上游 `ultracode-skill` 的 workflow artifacts / packet schema / eval contracts / approval gates。本轮已补齐为 Codex-safe、514cc-compatible 版本。`UltraCode-Shim` 的代理路由暂不纳入，避免把凭据/后端路由风险混进 skill 层。

__DELTA__: 烛(Codex) | 2 | governance | 推翻“现有 $ultracode 已足够完善”的判断：同步/触发是完整的，但工作流产物与契约层不足；已吸收开源 ultracode-skill 的 packet/eval/approval 机制，并明确不静默采纳 UltraCode-Shim proxy/router。
