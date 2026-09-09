import { ADAPTER_TEMPLATES } from "./adapters/manifest.mjs";

const DEFAULT_SEATS = [
  ["claude-fable", "Claude Code", "primary-coordinator", "claude-stream-json"],
  ["codex-technical", "Codex", "technical-executor", "codex-app-server"],
  ["grok-build", "Grok Build", "fast-executor", "grok-build-headless"],
  ["kimi-frontend", "Kimi", "frontend-engineer", "kimi-headless-resume"],
  ["pi-resident", "Pi", "resident-agent", "pi-rpc"],
];

export function createDefaultControlConfig() {
  const profiles = DEFAULT_SEATS.map(([id, label, role, adapter]) => {
    const template = ADAPTER_TEMPLATES.find((item) => item.id === adapter);
    if (!template) throw new Error(`missing built-in adapter template: ${adapter}`);
    return { id, label, role, adapter, provider: template.defaultProvider || "multi-provider",
      command: template.requiresCommand ? template.defaultCommand : null, model: null,
      enabled: true, capabilities: ["*"], ...template.routingDefaults,
      evidence: [{ source: "bundled adapter manifest", verifiedAt: "2026-09-06", detail: "Template defaults only; local CLI health is not yet verified." }] };
  });
  const modes = {
    plan: { write: false, shell: false, network: false, approvalRequired: false },
    review: { write: false, shell: "read-only", network: false, approvalRequired: false },
    build: { write: "workspace", shell: "workspace", network: "prompt", approvalRequired: true },
    ask: { write: "workspace", shell: "workspace", network: "approval", approvalRequired: false },
    auto: { write: "workspace", shell: "workspace", network: "approval", approvalRequired: false },
    "full-access": { write: true, shell: true, network: true, approvalRequired: false },
    config: { write: "config.toml", shell: "config.toml", network: "config.toml", approvalRequired: false },
  };
  const files = {
    "models.json": { version: 1, profiles },
    "routing.json": { version: 1, primaryCoordinator: "claude-fable", technicalExecutor: "codex-technical",
      maxRounds: 6, maxDepth: 2, maxParallelAgents: 4,
      requireHealthyProvider: true, failOnUnavailableExplicitProvider: true,
      weights: { quality: 0.44, speed: 0.26, health: 0.22, cost: 0.08 }, rules: [],
      independentPass: { requiredFor: ["high", "security", "production", "governance", "non-trivial-review"], mustDifferFromPrimary: true } },
    "permissions.json": { version: 1, defaultMode: "plan", modes,
      limits: { maxRounds: 6, maxDepth: 2, maxParallelAgents: 4, defaultBudgetUsdPerTurn: 2, turnTimeoutMs: 1800000, turnIdleTimeoutMs: 300000 },
      runtimeWrites: { allowed: false, requiresApproval: true, requiresBackup: true, requiresReadback: true },
      secrets: { exposeValues: false, persistValues: false, allowedReferences: ["env", "os-credential-store"] },
      approval: { ttlMs: 300000, bindToActionSha256: true, defaultDecision: "deny" } },
    "sources.json": { version: 1, explicit: ["models", "routing", "permissions", "sources"].map((name) => ({
      id: `control.${name}`, path: `config/control-center/${name}.json`, label: name, kind: "json", scope: "repo", critical: true,
    })), discover: [], runtime: [] },
    "claude-headless-settings.json": {},
  };
  return Object.fromEntries(Object.entries(files).map(([name, value]) => [`config/control-center/${name}`, `${JSON.stringify(value, null, 2)}\n`]));
}
