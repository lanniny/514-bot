import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readBotWorkspaceRoute, botWorkspaceRoute, ownsBotWorkspaceHash } from "../public/modules/bot-workspace-route.js";
import { routeKey } from "../public/modules/view-history.js";

test("Bot is canonical and old experience URLs retain their Conversation, Run and tab", () => {
  const target = { conversationId: "c-1", runId: "r-1", tab: "results" };
  assert.equal(botWorkspaceRoute(), "#bot");
  assert.equal(botWorkspaceRoute({ tab: "conversation" }), "#bot");
  for (const prefix of ["#bot", "#/bot", "#experience", "#/experience", "#workbench", "#/workbench"]) {
    assert.deepEqual(readBotWorkspaceRoute(`${prefix}?conversation=c-1&run=r-1&tab=results`), target);
  }
  assert.equal(botWorkspaceRoute(target), "#bot?conversation=c-1&run=r-1&tab=results");
  assert.equal(readBotWorkspaceRoute("#bot/automations/example?tab=history"), null);
  assert.equal(routeKey({ view: "experience", experienceHash: "#experience?conversation=c-1&run=r-1&tab=results" }), routeKey({ view: "bot", botWorkspaceHash: botWorkspaceRoute(target) }));
});

test("route input is bounded and never carries auth fields into a copied Bot URL", () => {
  const parsed = readBotWorkspaceRoute(`#bot?conversation=%3Cscript%3E&run=${"x".repeat(129)}&tab=unknown&token=never-copy`);
  assert.deepEqual(parsed, { conversationId: "", runId: "", tab: "conversation" });
  assert.equal(botWorkspaceRoute(parsed), "#bot");
});

test("background Bot sync relinquishes location before another destination's hashchange runs", async () => {
  for (const hash of ["#config/providers", "#config/hooks", "#run=r", "#bot/automations/example", "#config?member=x&conversation=c"]) {
    assert.equal(ownsBotWorkspaceHash(hash), false, hash);
  }
  for (const hash of ["", "#bot", "#experience?conversation=c", "#workbench", "#workbench?conversation=c", "#conversation=c&run=r", "#run=r&conversation=c"]) {
    assert.equal(ownsBotWorkspaceHash(hash), true, hash);
  }
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /ownsLocation: ownsBotWorkspaceHash\(location.hash\)/);
});

test("canonical Bot work routes bypass legacy top-level Run parsing", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const section = app.slice(app.indexOf("function conversationDeepLinkFromHash("), app.indexOf("async function consumeConversationDeepLink("));
  const parse = new Function("location", `${section}; return conversationDeepLinkFromHash;`)({ hash: "" });
  assert.equal(parse("#bot?conversation=c&run=r&tab=results"), null);
  assert.equal(parse("#experience?conversation=c&run=r&tab=results"), null);
  assert.equal(parse("#workbench?conversation=c&run=r&tab=results"), null);
  assert.equal(parse("#bot/automations/example?run=r"), null);
  assert.equal(parse("#run=r").runId, "r");
  assert.equal(parse("#conversation=c").conversationId, "c");
});

test("there is one visible work entry and startup saves the route before asynchronous loaders", async () => {
  const [app, html] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(html, /data-(?:view|workspace-view)="experience"|id="experience-workbench-open"/);
  assert.match(html, /forge\/bot-workspace\.css/);
  assert.match(app, /const startupHash = location\.hash/);
  assert.match(app, /parseForgeRoute\(startupHash\)/);
  assert.match(app, /active: state\.view === "bot" && botWorkspaceLocationReady/);
});
