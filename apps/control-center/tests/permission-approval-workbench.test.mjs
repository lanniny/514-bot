import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildPermissionOverviewModel } from "../public/modules/permission-overview.js";
import { adapterTemplateCatalog } from "../src/adapters/manifest.mjs";

const publicRoot = resolve(import.meta.dirname, "../public");

test("permission and approval workbench is wired into the live element map", async () => {
  const [index, app, state] = await Promise.all([
    readFile(resolve(publicRoot, "index.html"), "utf8"),
    readFile(resolve(publicRoot, "app.js"), "utf8"),
    readFile(resolve(publicRoot, "state.js"), "utf8"),
  ]);
  assert.match(index, /data-view="security" title="权限与审批"/);
  assert.match(index, /id="security-title">权限与审批/);
  assert.match(index, /id="permission-instance-context"/);
  assert.match(index, /id="permission-overview-grid"/);
  assert.match(index, /id="permission-seat-list"/);
  assert.match(index, /data-config-surface-jump="sources"/);
  assert.match(app, /"permission-overview-summary",[\s\S]*"permission-seat-list",/);
  assert.match(app, /function renderPermissionOverview\(\)/);
  assert.match(app, /buildPermissionOverviewModel\(\{/);
  assert.match(app, /onLoadStateChanged: \(\) => renderPermissionOverview\(\)/);
  assert.match(app, /if \(!state\.runtimeSeatsData && !state\.runtimeSeatsLoading\) void runtimeSeatManager\?\.load\(\)/);
  assert.match(app, /runtimeSeatManager\?\.load\(\{ fresh: true \}\)/);
  assert.match(app, /actionSha256: item\.actionSha256/);
  assert.match(state, /security: "权限与审批"/);
});

test("permission overview counts only server-confirmed active seats", () => {
  const model = buildPermissionOverviewModel({
    runtimeSeatsData: {
      seats: [
        { id: "ready", label: "Ready Codex", adapter: "codex-app-server", enabled: true, activation: "live", defaultPermissionMode: "workspace-write", live: { adapter: "codex-app-server", enabled: true, teamMemberEligible: true, defaultPermissionMode: "read-only" } },
        { id: "unknown", label: "Unknown seat", adapter: "claude-stream-json", enabled: true, activation: "live", live: { adapter: "claude-stream-json" } },
      ],
      adapterTemplates: adapterTemplateCatalog(),
      runtime: { generation: 7 },
    },
    apiState: "ok",
    repoRoot: "I:/514claude/514cc",
    runtimeGeneration: 7,
  });

  assert.equal(model.cards.find((card) => card.id === "seats").value, "1/2 已激活可执行");
  assert.equal(model.seatRows[0].configuredPermission, "workspace-write");
  assert.equal(model.seatRows[0].activePermission, "read-only");
  assert.equal(model.seatRows[0].approvalChannel, "514cc 动作审批");
  assert.equal(model.seatRows[1].activation, "不可执行");
  assert.equal(model.seatRows[1].approvalChannel, "仅 Build 审批");
  assert.equal(model.instance.runtimeGeneration, 7);
  assert.equal(buildPermissionOverviewModel().instance.runtimeGeneration, null);
});

test("permission overview hides stale counts while loading and fails closed on snapshot errors", () => {
  const loading = buildPermissionOverviewModel({
    runtimeSeatsLoading: true,
    runtimeSeatsData: { seats: [{ id: "stale", enabled: true, activation: "live", live: { enabled: true, teamMemberEligible: true } }] },
  });
  assert.equal(loading.cards.find((card) => card.id === "seats").value, "读取中");
  assert.equal(loading.summary.label, "正在核对");

  const failed = buildPermissionOverviewModel({
    runtimeSeatsData: { seats: [], error: "runtime unavailable" },
    approvalSnapshotError: "approval unavailable",
    remoteGatesError: "gates unavailable",
    apiState: "ok",
  });
  assert.equal(failed.blocked, true);
  assert.equal(failed.summary.label, "3 项阻断");
  assert.deepEqual(failed.blockers, [
    "运行席位快照：runtime unavailable",
    "审批快照：approval unavailable",
    "远程门闩：gates unavailable",
  ]);
  assert.equal(failed.cards.find((card) => card.id === "approvals").tone, "error");
  assert.equal(failed.cards.find((card) => card.id === "temporary").tone, "error");
});

test("adapter catalog declares approval ownership instead of inferring it in the UI", () => {
  const templates = new Map(adapterTemplateCatalog().map((template) => [template.id, template]));
  assert.equal(templates.get("codex-app-server").approvalChannel, "broker-action");
  assert.equal(templates.get("codex-exec-json").approvalChannel, "unavailable");
  assert.equal(templates.has("grok-mcp-via-codex-app-server"), false, "MCP tools are not runtime seat backends");
  assert.equal(templates.get("claude-stream-json").approvalChannel, "governed-build");
  assert.equal(templates.get("pi-rpc").approvalChannel, "unavailable");
});

test("permission overview has responsive seat and instance contracts", async () => {
  const css = await readFile(resolve(publicRoot, "styles.css"), "utf8");
  assert.match(css, /\.permission-overview-grid\s*\{/);
  assert.match(css, /\.permission-overview-card\.is-error/);
  assert.match(css, /\.permission-seat-row\s*\{/);
  assert.match(css, /\.permission-seat-facts\s*\{/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.permission-seat-facts/);
});
