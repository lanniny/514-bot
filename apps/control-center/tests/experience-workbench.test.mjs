import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readExperienceRoute, experienceRoute, experienceSelection } from "../public/modules/experience-workbench.js";
import { routeKey, recordRouteChange, stepHistory } from "../public/modules/view-history.js";
import { VIEW_TITLES } from "../public/state.js";
import { navViews } from "../public/modules/nav-config.js";

test("bounded experience routes are distinct from old conversation/run/session deep links", () => {
  const view = { conversationId: "conversation-1", runId: "run-1", tab: "results" };
  assert.deepEqual(readExperienceRoute(experienceRoute(view)), view);
  assert.deepEqual(readExperienceRoute("#/experience?conversation=conversation-1&run=run-1&tab=results"), view);
  for (const hash of ["#conversation=c", "#run=r", "#session=claude::p::s", "#project=p", "#config/providers"]) assert.equal(readExperienceRoute(hash), null);
  assert.deepEqual(readExperienceRoute("#experience?conversation=%3Cscript%3E&run=" + "x".repeat(500) + "&tab=invalid"), { conversationId: "", runId: "", tab: "conversation" });
});

test("selection uses persisted Conversation ownership, including historical runs and tombstones", () => {
  const conversation = { id: "c", projectId: "p", activeRunId: "r", runIds: ["old", "r", "wrong"] };
  const runs = new Map([["r", { id: "r", conversationId: "c" }], ["old", { id: "old" }], ["wrong", { id: "wrong", conversationId: "other" }]]);
  const data = { conversations: [conversation], projects: [{ projectId: "p" }], resolveRun: (id) => runs.get(id) };
  assert.equal(experienceSelection(data, { conversationId: "c" }).run.id, "r");
  assert.equal(experienceSelection(data, { conversationId: "c", runId: "old" }).run.id, "old");
  assert.equal(experienceSelection(data, { conversationId: "c", runId: "wrong" }).run, null);
  assert.equal(experienceSelection(data, { conversationId: "missing", runId: "r" }).run, null);
  data.conversations.push({ id: "other", activeRunId: "old" });
  assert.equal(experienceSelection(data, { conversationId: "c", runId: "old" }).run, null);
  conversation.deletedAt = "2026-09-05";
  assert.equal(experienceSelection(data, { conversationId: "c" }).run, null);
});

test("view history distinguishes conversation, run and tab without changing legacy keys", () => {
  const route = (conversationId, tab = "conversation", runId = "") => ({ view: "bot", botWorkspaceHash: experienceRoute({ conversationId, tab, runId }) });
  const a = route("a");
  const b = route("b", "results", "old");
  const recorded = recordRouteChange(a, b, { back: [] });
  assert.equal(recorded.recorded, true);
  assert.deepEqual(stepHistory("back", { back: recorded.back, forward: [], current: b }).target, a);
  assert.notEqual(routeKey(a), routeKey(route("a", "results")));
  assert.equal(routeKey({ view: "workbench" }), "workbench|||");
  assert.equal(routeKey({ view: "config", configSurface: "capabilities", capabilityWorkspace: "mcp" }), "config|capabilities|mcp|");
});

test("all pre-existing view IDs and navigation entries remain available", async () => {
  const oldViews = ["overview", "bot", "workbench", "team", "channels", "config", "router", "security", "observability", "sessions", "bootstrapper", "office", "automations", "terminal", "market", "hosts", "hero", "appearance", "browser"];
  for (const view of oldViews) assert.ok(VIEW_TITLES[view], `missing old view: ${view}`);
  const previousNavigation = ["bot", "team", "channels", "bootstrapper", "office", "overview", "observability", "sessions", "market", "hosts", "config", "automations", "security"];
  for (const view of previousNavigation) assert.ok(navViews().includes(view), `missing previous navigation: ${view}`);
  assert.ok(!navViews().includes("workbench"), "retired workbench must not remain in navigation");
  assert.ok(navViews().includes("plugins"));
  assert.equal(new Set(navViews()).size, navViews().length);
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  for (const view of ["memory", "capabilities", "terminal", "hero", "router"]) assert.ok(app.includes(`if (view === "${view}")`), `missing alias: ${view}`);
  assert.match(app, /FORGE_VIEW_TITLES\[initialRoute\.view\] \? initialRoute\.view : "bot"/);
  assert.equal(VIEW_TITLES.experience, undefined);
  assert.match(app, /if \(view === "experience" \|\| view === "workbench"\) view = "bot"/);
  assert.match(app, /createConversationWorkspace\(/);
  assert.match(app, /conversationCommands\.submit\(/);
});
