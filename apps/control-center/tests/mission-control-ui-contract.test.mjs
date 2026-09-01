import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import {
  MISSION_SNAPSHOT_MAX_AGE_MS,
  MISSION_SNAPSHOT_SCHEMA,
  validateMissionSnapshot,
} from "../public/mission-control.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

test("Mission Control dock keeps registry-driven ARIA panels and the legacy live registries", async () => {
  // UI-AUDIT P0-3：静态路由表已抽到 src/static-assets.mjs（可单测），server.mjs 只负责装配
  const [html, moduleSource, serverSource, appSource, assetsSource] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/mission-control.js`, "utf8"),
    readFile(`${appRoot}/server.mjs`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/src/static-assets.mjs`, "utf8"),
  ]);

  assert.match(html, /id="mission-control-dock"[^>]+aria-label="Mission Control 任务投影"/);
  assert.match(moduleSource, /"有向委派"|"消息路由"/);
  assert.match(moduleSource, /value\.messageRoutes/);
  assert.match(moduleSource, /value\.delegations|value\.tasks/);
  assert.doesNotMatch(moduleSource, /snapshot\/v2 fallback/);
  assert.doesNotMatch(`${html}\n${moduleSource}`, /任务注册表|直接委派|委派树|读取任务、委派/);
  for (const name of ["tasks", "artifacts", "evidence", "activity", "connections"]) {
    assert.match(html, new RegExp(`role="tab"[^>]+data-registry-tab="${name}"[^>]+aria-controls="registry-panel-${name}"`));
    assert.match(html, new RegExp(`id="registry-panel-${name}"[^>]+role="tabpanel"[^>]+data-registry-panel="${name}"`));
  }
  for (const legacyId of ["route-decision", "session-topology", "workbench-event-list"]) {
    assert.equal((html.match(new RegExp(`id="${legacyId}"`, "g")) ?? []).length, 1, `${legacyId} must be reused exactly once`);
  }
  assert.match(moduleSource, /ArrowRight/);
  assert.match(moduleSource, /ArrowLeft/);
  assert.match(moduleSource, /event\.preventDefault\(\)/);
  assert.match(moduleSource, /export const MISSION_PANEL_REGISTRY/);
  assert.match(moduleSource, /dataset\.missionWorkspaceOpen/);
  assert.match(moduleSource, /hideWorkspace\(\{ restoreFocus: true \}\)/);
  assert.match(moduleSource, /evidence\.status === "degraded"/);
  assert.match(moduleSource, /validateMissionSnapshot\(/);
  assert.match(moduleSource, /scheduleSnapshotRefresh\(\)/);
  assert.match(moduleSource, /MISSION_SNAPSHOT_MAX_AGE_MS/);
  assert.match(html, /id="mission-workspace-browser"/);
  assert.match(html, /id="mission-workspace-status"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /id="mission-evidence-graph"/);
  assert.match(assetsSource, /"\/mission-control\.js": "mission-control\.js"/);
  assert.match(serverSource, /inspectRunWorkspace/);
  assert.match(serverSource, /const run = structuredClone\(state\.orchestrator\.get\(runId\)\)/);
  assert.match(serverSource, /auditBusDiagnostics\(run, result\.diagnostics, result\.messages\.length\)/);
  assert.match(serverSource, /healthService\.all\(\{ signal \}\)/);
  assert.match(appSource, /event\.type === "bus\.appended" \|\| event\.type === "bus\.routed" \|\| event\.type === "user\.message"/);
  assert.match(appSource, /function buildContinueMessage\(/);
  assert.match(moduleSource, /直接收件人 \/ 写入所有者/);
  assert.doesNotMatch(moduleSource, /`起始 \$\{value\.task\.startAgentId\}`/);
  assert.match(appSource, /const \{ message, teamAnswer \} = buildContinueMessage\(\{/);
  assert.match(appSource, /const composerTarget = activeComposerTarget\(\);[\s\S]{0,180}const agentLock = composerTarget\.memberId/);
});

test("Wave UI-A multi-CLI team surface: constellation, command palette, @ mention", async () => {
  const [html, appSource, serverSource, css, paletteSource] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/server.mjs`, "utf8"),
    readFile(`${appRoot}/public/styles.css`, "utf8"),
    readFile(`${appRoot}/public/command-palette.js`, "utf8"),
  ]);

  // 命令面板（v4.0 Forge）：DOM 由 command-palette.js 运行时创建并自绑 Ctrl+K；
  // index.html 保留顶栏 trigger chip，app.js 负责接线与 extraItems 注入
  assert.match(html, /id="command-palette-trigger"/);
  assert.match(appSource, /command-palette\.js/);
  assert.match(appSource, /initCmdPalette\(\{/);
  assert.match(appSource, /extraItems: \(\) => FORGE_PALETTE_EXTRA_ITEMS\(\)/);
  assert.match(paletteSource, /export function openCommandPalette\(/);
  assert.match(paletteSource, /cmd-palette-input/);
  assert.match(paletteSource, /cmd-palette-results/);
  assert.match(paletteSource, /ctrlKey \|\| e\.metaKey/);
  assert.match(html, /id="mention-menu"/);
  assert.match(html, /id="slash-menu"/);
  assert.match(html, /id="automation-dialog"/);
  assert.match(html, /option value="review"/);
  assert.match(html, /id="workbench-team-pulse"/);
  assert.match(html, /id="global-team-pulse"/);
  assert.match(paletteSource, /export function closeCommandPalette\(/);
  assert.match(appSource, /function renderTeamPulse\(/);
  assert.match(appSource, /function worktreeSettlementMarkup\(/);
  assert.match(appSource, /data-settlement-continue-worktree/);
  assert.match(appSource, /function renderConversationAgents\(/);
  assert.match(appSource, /级联取消|cancelCascade/);
  assert.match(html, /id="conversation-agents"/);
  assert.match(appSource, /function renderMentionMenu\(/);
  assert.match(appSource, /requestedAgentIds:/);
  assert.match(appSource, /MAX_REQUESTED_AGENTS/);
  assert.match(appSource, /function renderSlashMenu\(/);
  assert.match(appSource, /function openAutomationManager\(/);
  assert.match(appSource, /能力租约|capability-lease/);
  assert.match(appSource, /动作审批 · 待处理/);
  assert.match(appSource, /data-lease-revoke-run/);
  assert.doesNotMatch(appSource, /能力租约 · 待签发|data-inline-approval-decision="deny">吊销/);
  assert.match(serverSource, /pathname === "\/api\/leases"/);
  assert.match(serverSource, /lease\\\/revoke/);
  assert.match(appSource, /loadIdleRoster/);
  assert.match(appSource, /function teamConstellationMarkup\(/);
  assert.match(html, /id="remote-gates-list"/);
  assert.match(html, /远程 \/ 高风险面门闩|remote-gates/);
  assert.match(appSource, /modules\/resume-hints\.js|resumeHintsFromSessions|resumeHintsMarkup/);
  assert.match(appSource, /function renderRemoteGates\(/);
  assert.match(appSource, /data-settlement-copy-git|data-copy-resume/);
  assert.match(appSource, /function applyStreamEpoch\(/);
  assert.match(appSource, /modules\/stream-epoch\.js|nextStreamEpochState|readStreamEpochFromHeaders/);
  assert.match(appSource, /modules\/welcome-tips\.js|buildWelcomeTipMarkup|welcomeTipMarkup/);
  assert.match(appSource, /function welcomeTipMarkup\(/);
  assert.match(appSource, /constellation-orbit-ring|constellation-stage/);
  assert.match(appSource, /message-cli-badge/);
  assert.match(appSource, /message-role-blurb/);
  assert.match(appSource, /template-start/);
  assert.match(appSource, /chip-tag/);
  assert.match(appSource, /团队会诊/);
  assert.match(appSource, /data-quick-start-agent/);
  assert.match(appSource, /heterogeneous|异构 CLI 团队|原生会话/);
  assert.match(css, /\.team-constellation\b/);
  assert.match(css, /\.welcome-tip\b/);
  assert.match(css, /\.constellation-stage\b/);
  assert.match(css, /\.message-cli-badge\b/);
  assert.match(css, /\.command-palette\b/);
  assert.match(css, /\.mention-menu\b/);
  assert.match(css, /\.slash-menu\b/);
});

test("continue payload keeps owned answers explicit and idless asks on the legacy resume contract", async () => {
  const appSource = await readFile(`${appRoot}/public/app.js`, "utf8");
  const blockStart = appSource.indexOf("function buildContinueMessage");
  const blockEnd = appSource.indexOf("\nasync function continueSelectedRun", blockStart);
  assert.ok(blockStart >= 0 && blockEnd > blockStart, "continue message builder is missing");

  // buildContinueMessage 现在读模块态 state.pendingNativeCommand（原生斜杠命令轮）——
  // 沙箱补一个诚实桩，eval 合同只验证 payload 形状，不验证全局依赖
  const context = { state: { pendingNativeCommand: false } };
  runInNewContext(`${appSource.slice(blockStart, blockEnd)}\n`
    + "globalThis.__buildContinueMessage = buildContinueMessage;", context);
  const buildContinueMessage = context.__buildContinueMessage;

  const owned = buildContinueMessage({
    run: { pendingAsk: { id: "ask-owned-1", from: "claude-fable" } },
    prompt: "方向 A",
    agentId: "claude-fable",
    agentLock: null,
  });
  assert.equal(owned.teamAnswer, true);
  assert.equal(owned.message.messageIntent, "answer");
  assert.equal(owned.message.answerToAskId, "ask-owned-1");
  assert.equal(owned.message.agentId, "claude-fable");

  const legacy = buildContinueMessage({
    run: { pendingAsk: { from: "claude-fable", text: "旧问题" } },
    prompt: "继续",
    agentId: "claude-fable",
    agentLock: null,
    acknowledgeRecovery: true,
  });
  const legacyWireBody = JSON.parse(JSON.stringify(legacy.message));
  assert.equal(legacy.teamAnswer, true);
  assert.equal(Object.hasOwn(legacyWireBody, "messageIntent"), false, "idless ask must not send the invalid answer intent");
  assert.equal(Object.hasOwn(legacyWireBody, "answerToAskId"), false, "idless ask has no ownership id to send");
  assert.equal(legacyWireBody.acknowledgeRecovery, true);

  const memberSteer = buildContinueMessage({
    run: { pendingAsk: { id: "ask-owned-2", from: "claude-fable" } },
    prompt: "只问 Codex",
    agentId: "codex-technical",
    agentLock: "codex-technical",
  });
  assert.equal(memberSteer.teamAnswer, false);
  assert.equal(memberSteer.message.messageIntent, "steer");
  assert.equal(Object.hasOwn(memberSteer.message, "answerToAskId"), false);
});

test("Mission Control rejects stale protocols, malformed routes and cross-run snapshots", () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const valid = {
    schema: MISSION_SNAPSHOT_SCHEMA,
    schemaVersion: 3,
    snapshotId: `mc-snapshot-${"a".repeat(64)}`,
    runId,
    task: { id: "task", title: "owned" },
    attempts: [],
    messageRoutes: [],
    agents: [],
    connections: [],
    approvals: [],
    artifacts: [],
    evidence: {},
  };

  assert.equal(validateMissionSnapshot(valid, runId), valid);
  assert.equal(MISSION_SNAPSHOT_MAX_AGE_MS, 15_000);
  assert.throws(
    () => validateMissionSnapshot({ ...valid, schema: "514cc.mission-control.snapshot/v2", schemaVersion: 2 }, runId),
    (error) => error?.code === "MISSION_SNAPSHOT_INVALID",
  );
  assert.throws(
    () => validateMissionSnapshot({ ...valid, runId: "22222222-2222-4222-8222-222222222222" }, runId),
    (error) => error?.code === "MISSION_SNAPSHOT_INVALID",
  );
  const { messageRoutes: _routes, ...legacyShape } = valid;
  assert.throws(
    () => validateMissionSnapshot({ ...legacyShape, delegations: [] }, runId),
    (error) => error?.code === "MISSION_SNAPSHOT_INVALID",
  );
});

test("Mission Control Playwright gate covers ownership, all tab keys and target viewports", async () => {
  const qaSource = await readFile(`${appRoot}/scripts/qa-ui.mjs`, "utf8");

  assert.match(qaSource, /async function inspectMissionControl\(/);
  assert.match(qaSource, /suite === "mission" \|\| suite === "all"/);
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
    assert.match(qaSource, new RegExp(`key: "${key}"`));
  }
  for (const [name, viewport] of [
    ["desktop", "width: 1440, height: 900"],
    ["compact-desktop", "width: 1280, height: 800"],
    ["tablet", "width: 820, height: 1180"],
    ["mobile", "width: 390, height: 844"],
  ]) assert.match(qaSource, new RegExp(`inspectMissionControl\\("${name}", \\{ ${viewport} \\}\\)`));
  assert.match(qaSource, /did not abort the superseded snapshot request/);
  assert.match(qaSource, /late Mission Control response took ownership/);
  assert.match(qaSource, /closing the workspace browser did not restore focus to its opener/);
  assert.match(qaSource, /Mission Control overlap detected/);
});

test("same-run topology invalidation aborts the old request and rejects a late cache write", async () => {
  const appSource = await readFile(`${appRoot}/public/app.js`, "utf8");
  const blockStart = appSource.indexOf("const socialTopologyCache = new Map()");
  const blockEnd = appSource.indexOf("async function renderSocialTopology", blockStart);
  assert.ok(blockStart >= 0 && blockEnd > blockStart, "social topology cache block is missing");
  assert.match(appSource, /if \(topologySignal && event\.runId\) invalidateSocialTopology\(event\.runId\)/);
  assert.match(appSource, /socialTopologyInflight\.get\(runId\)\?\.promise !== pending/);

  const requests = [];
  const request = (_url, { signal } = {}) => new Promise((resolve, reject) => {
    requests.push({ resolve, reject, signal });
  });
  const context = { request, AbortController };
  runInNewContext(`${appSource.slice(blockStart, blockEnd)}\n`
    + "globalThis.__topology = { loadSocialTopologyMessages, invalidateSocialTopology, socialTopologyCache, socialTopologyInflight };", context);
  const topology = context.__topology;
  const runId = "11111111-1111-4111-8111-111111111111";

  const stale = topology.loadSocialTopologyMessages(runId);
  assert.equal(requests.length, 1);
  topology.invalidateSocialTopology(runId);
  assert.equal(requests[0].signal.aborted, true, "same-run invalidation must abort the in-flight fetch");

  const fresh = topology.loadSocialTopologyMessages(runId);
  assert.equal(requests.length, 2, "invalidation must let the replacement fetch start immediately");
  const staleRejected = assert.rejects(stale, (error) => error?.name === "AbortError");
  requests[0].resolve({ messages: [{ id: "stale" }], diagnostics: null });
  await staleRejected;
  assert.equal(topology.socialTopologyCache.has(runId), false, "late stale completion refilled the cache");

  requests[1].resolve({ messages: [{ id: "fresh" }], diagnostics: { status: "ok" } });
  const result = await fresh;
  assert.equal(result.messages[0].id, "fresh");
  assert.equal(topology.socialTopologyCache.get(runId).messages[0].id, "fresh");
});
