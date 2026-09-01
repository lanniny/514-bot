/**
 * 模型路由已并入团队编排：独立 #view-router 不得回归，
 * 预览不得默认锁死协作台直接发送目标。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const publicRoot = resolve(import.meta.dirname, "../public");

test("team page owns the router workbench and router is only an alias", async () => {
  const [index, app, palette, routerPanel] = await Promise.all([
    readFile(resolve(publicRoot, "index.html"), "utf8"),
    readFile(resolve(publicRoot, "app.js"), "utf8"),
    readFile(resolve(publicRoot, "command-palette.js"), "utf8"),
    readFile(resolve(publicRoot, "modules/router-preview-panel.js"), "utf8"),
  ]);
  const teamStart = index.indexOf('id="view-team"');
  const configStart = index.indexOf('id="view-config"');
  const teamView = index.slice(teamStart, configStart);

  assert.match(teamView, /id="team-router-workbench"/);
  assert.match(teamView, /id="router-form"/);
  assert.match(teamView, /id="router-preferred-seat"/);
  assert.match(teamView, /id="router-candidate-body"/);
  assert.match(teamView, /id="model-table-body"/);
  assert.match(teamView, /id="team-routing-root"/);
  assert.match(teamView, /data-router-kind="long-context"/);
  assert.doesNotMatch(index, /id="view-router"|data-view-panel="router"/);
  assert.doesNotMatch(index, /data-view="router"|模型路由/);

  assert.match(app, /if \(view === "router"\)/);
  assert.match(app, /revealTeamRouting/);
  assert.match(app, /lockToTarget: false/);
  assert.match(app, /includeAttachments: false/);
  assert.match(routerPanel, /team-router-candidate/);
  assert.doesNotMatch(app, /router-candidate-body"\]\.innerHTML = `<tr/);

  assert.match(palette, /router: "router 路由/);
});

test("form preview does not inherit workbench requestedAgentIds or composer lock", async () => {
  const app = await readFile(resolve(publicRoot, "app.js"), "utf8");
  const submit = app.slice(app.indexOf("async function handleRouterSubmit"), app.indexOf("async function createRun"));
  assert.match(submit, /lockToTarget: false/);
  assert.match(submit, /preferredSeat:/);
  assert.match(submit, /\{\s*teamId,\s*memberId:\s*null/);
  assert.match(submit, /\[\s*\]/);
});
