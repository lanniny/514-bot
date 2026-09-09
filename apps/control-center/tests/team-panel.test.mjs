import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildTeamPanelData,
  layoutTeamTopology,
  nodeInitial,
  normalizeRunSessions,
  renderTeamTopologyMarkup,
  PROFILE_META,
  resolveCatalogBrand,
  runsForTeam,
  selectPipelineRoot,
  sessionAgentIds,
} from "../public/team-panel.js";
import { buildAttentionHeroStat, buildCollabLoadResult, buildTeamActivityCounts, pickTeam, suggestMarkup } from "../public/collab-flow.js";

test("team panel derives real team seats, provider health, task load and delegation flow", () => {
  const team = {
    id: "team-514cc",
    name: "514cc",
    coordinator: "claude-fable",
    members: ["claude-fable", "codex-technical", "kimi-frontend"],
  };
  const snapshot = buildTeamPanelData({
    team,
    now: "2026-07-25T08:00:00.000Z",
    components: [
      { id: "claude-fable", status: "online", available: true },
      { id: "codex-technical", status: "online", available: true },
      { id: "kimi-frontend", status: "missing", available: false },
    ],
    runs: [{
      id: "run-1",
      teamId: team.id,
      title: "修复控制面",
      status: "waiting_agent",
      updatedAt: "2026-07-25T07:59:00.000Z",
      turnAttempts: [{ attemptId: "attempt-1", agentId: "codex-technical", phase: "submitted", updatedAt: "2026-07-25T07:59:30.000Z" }],
      taskGraph: {
        tasks: [{ id: "task-1", kind: "attempt", assigneeId: "codex-technical", status: "running" }],
        delegations: [{ fromAgentId: "claude-fable", toAgentId: "codex-technical", state: "running", kind: "route" }],
      },
    }],
  });

  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.coordinatorId, "claude-fable");
  assert.deepEqual(snapshot.agents.map((item) => item.id), team.members);
  assert.equal(snapshot.agents.find((item) => item.id === "claude-fable").status, "ready", "coordinator is not hard-coded busy");
  assert.equal(snapshot.agents.find((item) => item.id === "codex-technical").status, "busy");
  assert.equal(snapshot.agents.find((item) => item.id === "codex-technical").activeRunCount, 1);
  assert.equal(snapshot.agents.find((item) => item.id === "kimi-frontend").status, "offline");
  assert.deepEqual(snapshot.flows.map(({ from, to, count }) => ({ from, to, count })), [
    { from: "claude-fable", to: "codex-technical", count: 1 },
  ]);
});

test("Claude is a planning seat until the selected team assigns coordinator status", () => {
  assert.equal(PROFILE_META["claude-fable"].title, "规划编排席");
  const snapshot = buildTeamPanelData({
    team: { id: "codex-led", name: "Codex 单席", coordinator: "codex-technical", members: ["claude-fable", "codex-technical"] },
    runs: [],
  });
  assert.equal(snapshot.agents.find((item) => item.id === "claude-fable").layer, "member");
  assert.equal(snapshot.agents.find((item) => item.id === "codex-technical").layer, "leader");
});

test("team panel prefers the live catalog label, role and provider over static profile metadata", () => {
  const snapshot = buildTeamPanelData({
    team: { id: "customized", name: "自定义", coordinator: "kimi-frontend", members: ["kimi-frontend"] },
    catalog: [{ id: "kimi-frontend", label: "月之主脑", role: "custom-ui-coordinator", provider: "custom-moonshot" }],
  });
  assert.equal(snapshot.agents[0].name, "月之主脑");
  assert.equal(snapshot.agents[0].title, "custom · ui · coordinator");
  assert.equal(snapshot.agents[0].role, "custom · ui · coordinator");
  assert.equal(snapshot.agents[0].provider, "custom-moonshot");
  assert.equal(snapshot.agents[0].layer, "leader");
  assert.equal(snapshot.agents[0].avatar, "");
});

test("team panel projects a custom avatar flag from the member catalog", () => {
  const snapshot = buildTeamPanelData({
    team: { id: "customized", name: "自定义", coordinator: "kimi-frontend", members: ["kimi-frontend"] },
    catalog: [{ id: "kimi-frontend", label: "月之主脑", provider: "moonshot", avatar: "custom" }],
  });
  assert.equal(snapshot.agents[0].avatar, "custom");
});

test("catalog provider branding overrides a known agent's static provider", () => {
  assert.equal(resolveCatalogBrand("anthropic", "kimi-frontend"), "claude");
  assert.equal(resolveCatalogBrand("custom-provider", "kimi-frontend"), "other");
  assert.equal(resolveCatalogBrand("", "kimi-frontend"), "kimi");

  const snapshot = buildTeamPanelData({
    team: { id: "rebound", name: "重绑定", coordinator: "kimi-frontend", members: ["kimi-frontend"] },
    catalog: [{ id: "kimi-frontend", label: "自定义席", role: "frontend-engineer", provider: "anthropic" }],
  });
  assert.equal(snapshot.agents[0].provider, "anthropic");
  assert.equal(snapshot.agents[0].brand, "claude");
});

test("run sessions derive the pipeline root and membership from the configured coordinator", () => {
  const sessions = normalizeRunSessions({
    "claude-fable": { sessionId: "claude-session", role: "orchestrator" },
    "codex-technical": "codex-session",
  }, "codex-technical");
  assert.deepEqual(sessionAgentIds(sessions), ["claude-fable", "codex-technical"]);
  assert.equal(sessions.find((item) => item.agentId === "claude-fable").role, "worker");
  assert.equal(sessions.find((item) => item.agentId === "codex-technical").role, "orchestrator");
  assert.equal(selectPipelineRoot(sessions, "codex-technical")?.agentId, "codex-technical");
  assert.equal(selectPipelineRoot([{ agentId: "worker", role: "worker" }]), null, "missing parent fields must not imply a root session");
});

test("team panel keeps unknown agent identity and does not turn waiting approval into provider activity", () => {
  const snapshot = buildTeamPanelData({
    team: { id: "custom", name: "Custom", coordinator: "custom-cli", members: ["custom-cli"] },
    components: [],
    runs: [{ id: "run-wait", teamId: "custom", title: "待批准", status: "waiting_approval", startAgentId: "custom-cli" }],
  });
  assert.equal(snapshot.agents[0].id, "custom-cli");
  assert.equal(snapshot.agents[0].provider, "custom");
  assert.equal(snapshot.agents[0].status, "unknown");
  assert.equal(snapshot.agents[0].activeRunCount, 0);
});

test("team workspace resolves the explicitly selected team before the builtin fallback", () => {
  const teams = [
    { id: "team-514cc", name: "514cc", builtin: true },
    { id: "team-custom", name: "前端组", builtin: false },
  ];

  assert.equal(pickTeam(teams, "team-custom")?.id, "team-custom");
  assert.equal(pickTeam(teams, "missing")?.id, "team-514cc");
});

test("legacy runs without teamId belong only to the builtin team", () => {
  const runs = [
    { id: "legacy", title: "旧任务", status: "running", startAgentId: "claude-fable" },
    { id: "custom", teamId: "team-custom", title: "自定义任务", status: "running", startAgentId: "claude-fable" },
  ];
  const builtin = buildTeamPanelData({
    team: { id: "team-514cc", name: "514cc", coordinator: "claude-fable", members: ["claude-fable"] },
    runs,
  });
  const custom = buildTeamPanelData({
    team: { id: "team-custom", name: "前端组", coordinator: "claude-fable", members: ["claude-fable"] },
    runs,
  });

  assert.equal(builtin.agents[0].activeRunCount, 1);
  assert.equal(builtin.agents[0].currentTask, "旧任务");
  assert.equal(custom.agents[0].activeRunCount, 1);
  assert.equal(custom.agents[0].currentTask, "自定义任务");
});

test("team activity and delegation data stay scoped to the selected team", () => {
  const builtin = { id: "team-514cc", name: "514cc", coordinator: "claude-fable", members: ["claude-fable", "codex-technical"] };
  const custom = { id: "team-custom", name: "前端组", coordinator: "claude-fable", members: ["claude-fable", "codex-technical"] };
  const stamp = "2026-07-27T10:00:00";
  const edge = { fromAgentId: "claude-fable", toAgentId: "codex-technical", state: "running", kind: "route", updatedAt: stamp };
  const runs = [
    { id: "legacy", status: "running", updatedAt: stamp, turnAttempts: [{ agentId: "claude-fable", updatedAt: stamp }], taskGraph: { delegations: [edge] } },
    { id: "builtin", teamId: builtin.id, status: "running", updatedAt: stamp, turnAttempts: [{ agentId: "claude-fable", updatedAt: stamp }], taskGraph: { delegations: [edge] } },
    { id: "custom", teamId: custom.id, status: "running", updatedAt: stamp, turnAttempts: [{ agentId: "claude-fable", updatedAt: stamp }], taskGraph: { delegations: [edge] } },
  ];

  assert.deepEqual(runsForTeam(builtin, runs).map((run) => run.id), ["legacy", "builtin"]);
  assert.deepEqual(runsForTeam(custom, runs).map((run) => run.id), ["custom"]);

  const day = new Date(2026, 6, 27).getTime();
  const counts = buildTeamActivityCounts({
    team: custom,
    agents: custom.members.map((id) => ({ id })),
    runs,
    days: [day],
  });
  assert.deepEqual(counts.get("claude-fable"), [2], "one attempt and one delegation from the custom run only");

  const panel = buildTeamPanelData({ team: custom, runs });
  assert.equal(panel.flows.length, 1);
  assert.equal(panel.flows[0].count, 1, "same-agent delegations from other teams must not inflate the current flow");
});

test("team flow and heatmap renderers do not consume unscoped handoffs", async () => {
  const source = await readFile(resolve(import.meta.dirname, "../public/collab-flow.js"), "utf8");
  const flow = source.slice(source.indexOf("function renderFlow"), source.indexOf("function wireFlowHover"));
  const heatmap = source.slice(source.indexOf("function renderHeatmap"), source.indexOf("// ─── 路由决策"));
  assert.doesNotMatch(flow, /data\.handoffs|for \(const handoff/i);
  assert.doesNotMatch(heatmap, /data\.handoffs|for \(const handoff/i);
  assert.match(source, /renderFlow\(roots\.flow, buildPanel\(\)\)/);
  assert.match(source, /renderHeatmap\(roots\.heatmap, buildPanel\(\), team, teamRuns\)/);
});

test("collaboration refresh result distinguishes success, partial failure and total failure", () => {
  const fulfilled = { status: "fulfilled", value: {} };
  const rejected = (message) => ({ status: "rejected", reason: new Error(message) });

  const success = buildCollabLoadResult(new Array(6).fill(fulfilled), { teamId: "team-custom" });
  assert.equal(success.__forgeLoadResult, true);
  assert.equal(success.ok, true);
  assert.equal(success.status, "success");
  assert.equal(success.partial, false);
  assert.deepEqual(success.failedSources, []);

  const partial = buildCollabLoadResult([fulfilled, fulfilled, rejected("health offline"), fulfilled, fulfilled, fulfilled]);
  assert.equal(partial.ok, false);
  assert.equal(partial.status, "partial");
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.failedSources, ["health"]);
  assert.match(partial.error.message, /health/);

  const failure = buildCollabLoadResult(Array.from({ length: 6 }, (_, index) => rejected(`failed-${index}`)));
  assert.equal(failure.ok, false);
  assert.equal(failure.status, "failure");
  assert.equal(failure.partial, false);
  assert.deepEqual(failure.failedSources, ["teams", "runs", "health", "delta", "handoffs", "routegate"]);
});

test("attention hero keeps failed or incomplete attention data unknown instead of zero", () => {
  assert.deepEqual(buildAttentionHeroStat(null), {
    value: "—",
    sub: "注意力数据未知",
    known: false,
  });
  assert.deepEqual(buildAttentionHeroStat({ counts: { activeSeats: 0, queueDepth: 0, pendingAskCount: 0 } }), {
    value: 0,
    sub: "当前无执行中任务",
    known: true,
  });
  assert.deepEqual(buildAttentionHeroStat({ counts: { activeSeats: 1 } }), {
    value: 1,
    sub: "队列与待答数据未知",
    known: true,
  });
});

test("default team suggestion follows the configured coordinator instead of Claude", () => {
  const markup = suggestMarkup("整理一下下一步", new Set(["claude-fable", "codex-technical"]), "codex-technical");
  assert.match(markup, /codex-technical/);
  assert.doesNotMatch(markup, /data-brand="claude"/);
  assert.match(markup, /当前团队主脑规划/);
});

test("planning keyword suggestions still prefer the selected team's coordinator", () => {
  const markup = suggestMarkup("规划整体架构方案", new Set(["claude-fable", "kimi-frontend"]), "kimi-frontend");
  assert.match(markup, /kimi-frontend/);
  assert.doesNotMatch(markup, /data-brand="claude"/);
});

test("planning suggestions fail closed when the team has no coordinator", () => {
  const markup = suggestMarkup("规划整体架构方案", new Set(["claude-fable"]), null);
  assert.match(markup, /当前团队未指定主脑/);
  assert.doesNotMatch(markup, /claude-fable/);
});

test("suggestion skips offline preferred seats and picks the next usable one", () => {
  const seats = new Map([
    ["codex-technical", { id: "codex-technical", status: "offline" }],
    ["grok-build", { id: "grok-build", status: "ready" }],
  ]);
  const markup = suggestMarkup("帮我写代码实现这个功能", new Set(["codex-technical", "grok-build"]), null, seats);
  assert.match(markup, /data-suggest-agent="grok-build"/);
  assert.doesNotMatch(markup, /data-suggest-agent="codex-technical"/);
});

test("available true cannot paint degraded health as ready", () => {
  const snapshot = buildTeamPanelData({
    team: { id: "team-514cc", name: "514cc", coordinator: "claude-fable", members: ["claude-fable"] },
    components: [{ id: "claude-fable", status: "degraded", available: true }],
    runs: [],
  });
  assert.equal(snapshot.agents[0].status, "degraded");
});

test("busy seat suggestion is annotated with running load", () => {
  const seats = new Map([["kimi-frontend", { id: "kimi-frontend", status: "busy", activeRunCount: 2 }]]);
  const markup = suggestMarkup("优化前端页面布局", new Set(["kimi-frontend"]), null, seats);
  assert.match(markup, /data-suggest-agent="kimi-frontend"/);
  assert.match(markup, /执行中 · 2 任务/);
});

test("unknown-health seat is annotated instead of filtered", () => {
  const seats = new Map([["codex-technical", { id: "codex-technical", status: "unknown" }]]);
  const markup = suggestMarkup("评审一下安全面", new Set(["codex-technical"]), null, seats);
  assert.match(markup, /data-suggest-agent="codex-technical"/);
  assert.match(markup, /未核验/);
});

test("all seats offline yields an honest hint instead of a pick", () => {
  const seats = new Map([["kimi-frontend", { id: "kimi-frontend", status: "offline" }]]);
  const markup = suggestMarkup("做个前端页面", new Set(["kimi-frontend"]), null, seats);
  assert.match(markup, /没有可建议的席位/);
  assert.doesNotMatch(markup, /cf-suggest-pick/);
});

test("disabled gemini seat is never suggested for long-context tasks", () => {
  const markup = suggestMarkup("读一下这篇论文全文", new Set(["gemini-research", "claude-fable"]), null);
  assert.match(markup, /data-suggest-agent="claude-fable"/);
  assert.doesNotMatch(markup, /gemini-research/);
});

test("three-seat topology spreads into a triangle instead of a vertical line", () => {
  const { width, height, positions } = layoutTeamTopology([
    { id: "a", name: "金色瞬间" },
    { id: "b", name: "Codex 技术并行" },
    { id: "c", name: "初音未来·极速电子歌姬" },
  ], "b");
  const xs = positions.map((item) => item.x);
  const ys = positions.map((item) => item.y);
  assert.equal(positions.length, 3);
  assert.ok(width >= 600);
  assert.ok(height >= 240);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 120, "nodes must occupy horizontal space");
  assert.ok(new Set(xs.map((value) => Math.round(value))).size >= 3, "three seats must not share one x");
  assert.ok(Math.max(...ys) - Math.min(...ys) > 40);
  assert.equal(nodeInitial("金色瞬间"), "金");
  assert.equal(nodeInitial("Codex"), "CO");
  const markup = renderTeamTopologyMarkup([
    { id: "a", name: "金色瞬间", provider: "xai", brand: "grok", avatar: "custom" },
    { id: "b", name: "Codex 技术并行", provider: "openai", brand: "codex" },
    { id: "c", name: "初音未来·极速电子歌姬", provider: "tokenrhythm", brand: "other" },
  ], { coordinatorId: "b" });
  assert.match(markup, /tp-topo-face/);
  assert.match(markup, /cli-logo tp-topo-icon|avatar-photo tp-topo-photo/);
  assert.doesNotMatch(markup, /tp-topo-initial/);
});
