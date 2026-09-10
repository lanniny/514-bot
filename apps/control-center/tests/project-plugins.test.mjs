import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectPluginStore, PLUGIN_CATALOG, normalizePluginManifest } from "../src/project-plugins.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "514cc-project-plugins-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projects = { get(projectId) { if (!["a", "b", "archived"].includes(projectId)) throw Object.assign(new Error("missing"), { code: "PROJECT_NOT_FOUND" }); return { projectId, title: `Project ${projectId}`, canonicalCwd: root, archivedAt: projectId === "archived" ? "2026-01-01" : null }; } };
  const store = await new ProjectPluginStore({ dataRoot: root, projects }).init();
  return { store, root, projects };
}
const revision = (store) => store.list().revision;

test("plugins persist installation and isolated project bindings across restart", async (t) => {
  const { store, root, projects } = await fixture(t);
  await store.install({ catalogId: "project-context", expectedRevision: 0 });
  await store.configure({ pluginId: "project-context", projectId: "a", enabled: true, expectedRevision: 1 });
  assert.equal(store.snapshot("a").length, 1);
  assert.deepEqual(store.snapshot("b"), []);
  const restored = await new ProjectPluginStore({ dataRoot: root, projects }).init();
  assert.deepEqual(restored.snapshot("a"), store.snapshot("a"));
  assert.throws(() => restored.list("missing"), { code: "PROJECT_NOT_FOUND" });
});
test("concurrent plugin edits require a current revision and cannot uninstall enabled bindings", async (t) => {
  const { store } = await fixture(t);
  const writes = await Promise.allSettled(PLUGIN_CATALOG.slice(0, 2).map((item) => store.install({ catalogId: item.id, expectedRevision: 0 })));
  assert.equal(writes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(writes.find((item) => item.status === "rejected").reason.code, "PLUGIN_REVISION_MISMATCH");
  const pluginId = store.list().installed[0].id;
  await store.configure({ pluginId, projectId: "a", enabled: true, expectedRevision: revision(store) });
  await assert.rejects(store.remove({ pluginId, expectedRevision: revision(store) }), { code: "PLUGIN_IN_USE" });
  await store.configure({ pluginId, projectId: "a", enabled: false, expectedRevision: revision(store) });
  await store.remove({ pluginId, expectedRevision: revision(store) });
  assert.deepEqual(store.list("a").bindings, []);
});
test("plugin tools only expose the bound project, and disabling revokes further calls", async (t) => {
  const { store } = await fixture(t);
  await store.install({ catalogId: "project-context", expectedRevision: 0 });
  await store.configure({ pluginId: "project-context", projectId: "a", enabled: true, expectedRevision: 1 });
  const input = { projectId: "a", pluginId: "project-context", contributionId: "runs", type: "tools" };
  const runs = [{ id: "own", projectId: "a", status: "complete" }, { id: "secret", projectId: "b", prompt: "other project" }];
  assert.deepEqual(store.execute(input, { runs }).data.runs.map((run) => run.id), ["own"]);
  assert.throws(() => store.execute({ ...input, projectId: "b" }, { runs }), { code: "PLUGIN_DISABLED" });
  await store.configure({ pluginId: "project-context", projectId: "a", enabled: false, expectedRevision: 2 });
  assert.throws(() => store.execute(input), { code: "PLUGIN_DISABLED" });
});
test("workflow configuration is validated and materializes a plain draft without launching a Run", async (t) => {
  const { store } = await fixture(t);
  await store.install({ catalogId: "delivery-review", expectedRevision: 0 });
  await assert.rejects(store.configure({ pluginId: "delivery-review", projectId: "a", enabled: true, config: { focus: "bad" }, expectedRevision: 1 }), { code: "PLUGIN_INVALID" });
  await store.configure({ pluginId: "delivery-review", projectId: "a", enabled: true, config: { focus: "用户体验", acceptance: "Evidence $& {{project.title}}" }, expectedRevision: 1 });
  const snapshot = store.snapshot("a");
  const result = store.execute({ pluginId: "delivery-review", projectId: "a", type: "workflows", contributionId: "review" });
  assert.match(result.prompt, /Project a/);
  assert.match(result.prompt, /用户体验/);
  assert.match(result.prompt, /Evidence \$& \{\{project.title\}\}/);
  await store.configure({ pluginId: "delivery-review", projectId: "a", enabled: false, expectedRevision: 2 });
  assert.equal(snapshot[0].config.focus, "用户体验");
  assert.deepEqual(store.snapshot("a"), []);
});
test("manifest rejects executable content, unsupported contributions, prototype keys and invalid settings", () => {
  const base = PLUGIN_CATALOG[0];
  for (const patch of [{ script: "run.js" }, { tools: [{ id: "exec", name: "exec", kind: "shell" }] }, { panels: [{ id: "remote", name: "remote", source: "https://example.com" }] }, { settings: [{ id: "constructor", label: "secret", type: "password", default: "" }] }]) assert.throws(() => normalizePluginManifest({ ...base, ...patch }), { code: "PLUGIN_INVALID" });
  assert.throws(() => normalizePluginManifest(JSON.parse('{"__proto__":{}}')), { code: "PLUGIN_INVALID" });
});
test("custom imports cannot replace a reserved catalog identity", async (t) => {
  const { store } = await fixture(t);
  const spoofed = structuredClone(PLUGIN_CATALOG.find((item) => item.id === "desktop-pet"));
  spoofed.description = "untrusted replacement";
  assert.throws(() => store.install({ manifest: spoofed, expectedRevision: 0 }), { code: "PLUGIN_RESERVED_ID" });
  assert.deepEqual(store.list().installed, []);
});
test("installed catalog plugins migrate forward with binding defaults and a persisted revision", async (t) => {
  const { store, root, projects } = await fixture(t);
  await store.install({ catalogId: "desktop-pet", expectedRevision: 0 });
  await store.configure({ projectId: "a", pluginId: "desktop-pet", enabled: true, config: {}, expectedRevision: 1 });
  const path = join(root, "project-plugins.json");
  const legacy = JSON.parse(await readFile(path, "utf8"));
  const item = legacy.installed[0];
  item.manifest.version = "1.1.0";
  item.manifest.settings = item.manifest.settings.filter((field) => field.id !== "model");
  delete legacy.bindings[0].config.model;
  item.digest = createHash("sha256").update(JSON.stringify(item.manifest)).digest("hex");
  await writeFile(path, JSON.stringify(legacy));
  const restored = await new ProjectPluginStore({ dataRoot: root, projects }).init();
  const snapshot = restored.list("a");
  assert.equal(snapshot.revision, legacy.revision + 1);
  assert.equal(snapshot.installed[0].manifest.version, "1.2.0");
  assert.equal(snapshot.bindings[0].config.model, "standard");
  assert.equal(JSON.parse(await readFile(path, "utf8")).revision, snapshot.revision);
});
test("corrupt or modified plugin stores fail closed and preserve original bytes", async (t) => {
  const { store, root, projects } = await fixture(t);
  await store.install({ catalogId: "project-context", expectedRevision: 0 });
  const path = join(root, "project-plugins.json");
  const data = JSON.parse(await readFile(path, "utf8")); data.installed[0].manifest.name = "changed";
  const bytes = JSON.stringify(data); await writeFile(path, bytes);
  const restored = await new ProjectPluginStore({ dataRoot: root, projects }).init();
  assert.throws(() => restored.list(), { code: "PLUGIN_STORE_UNAVAILABLE" });
  await assert.rejects(restored.install({ catalogId: "delivery-review", expectedRevision: 0 }), { code: "PLUGIN_STORE_UNAVAILABLE" });
  assert.equal(await readFile(path, "utf8"), bytes);
});
test("declarative panels use the same project lifecycle and reject archived writes", async (t) => {
  const { store } = await fixture(t);
  await store.install({ catalogId: "project-overview", expectedRevision: 0 });
  await assert.rejects(store.configure({ projectId: "archived", pluginId: "project-overview", enabled: true, expectedRevision: 1 }), { code: "PLUGIN_PROJECT_ARCHIVED" });
  await store.configure({ projectId: "a", pluginId: "project-overview", enabled: true, expectedRevision: 1 });
  const panel = store.execute({ projectId: "a", pluginId: "project-overview", contributionId: "overview", type: "panels" });
  assert.equal(panel.data.projectId, "a");
  assert.equal(panel.type, "panels");
});
test("project identifiers cannot acquire new bindings after normalization or restart", async (t) => {
  const { store } = await fixture(t);
  await store.install({ catalogId: "project-context", expectedRevision: 0 });
  await assert.rejects(store.configure({ projectId: " a ", pluginId: "project-context", enabled: true, expectedRevision: 1 }), { code: "PLUGIN_INVALID" });
  assert.deepEqual(store.snapshot("a"), []);
});
test("archived projects can revoke a plugin so its package can be removed", async (t) => {
  const { store, projects } = await fixture(t);
  await store.install({ catalogId: "project-context", expectedRevision: 0 });
  await store.configure({ projectId: "a", pluginId: "project-context", enabled: true, expectedRevision: 1 });
  projects.get = (projectId) => ({ projectId, title: "Archived", archivedAt: "2026-01-01" });
  await store.configure({ projectId: "a", pluginId: "project-context", enabled: false, expectedRevision: 2 });
  await store.remove({ pluginId: "project-context", expectedRevision: 3 });
  assert.deepEqual(store.list().installed, []);
});
test("desktop-pet plugin can be installed, configured with pet settings, and executed", async (t) => {
  const { store } = await fixture(t);
  await store.install({ catalogId: "desktop-pet", expectedRevision: 0 });
  await store.configure({
    projectId: "a",
    pluginId: "desktop-pet",
    enabled: true,
    config: {
      enabled: true,
      model: "keyboard",
      "max-fps": "60",
      "model-mirror": false,
      "pointer-mirror": false,
      "random-expression": true,
      interactive: true,
      opacity: 85,
      scale: 120,
      "web-dock": true,
      "mouse-tracking": true,
      "lightning-combo": true,
      sound: true
    },
    expectedRevision: 1
  });
  const snapshot = store.snapshot("a");
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].id, "desktop-pet");
  assert.equal(snapshot[0].config.opacity, 85);
  assert.equal(snapshot[0].config.model, "keyboard");
  assert.equal(snapshot[0].config.interactive, true);
  assert.equal(snapshot[0].config["mouse-tracking"], true);
  assert.equal(snapshot[0].config["lightning-combo"], true);
  assert.equal(snapshot[0].config.sound, true);

  const panel = store.execute({ projectId: "a", pluginId: "desktop-pet", contributionId: "pet-dashboard", type: "panels" });
  assert.equal(panel.type, "panels");
  assert.ok(panel.data.pet, "panel data should include pet status");
  assert.equal(panel.data.pet.opacity, 85);
  assert.equal(panel.data.pet.interactive, true);
  assert.equal(panel.data.pet.mouse_tracking, true);
  assert.equal(panel.data.pet.lightning_combo, true);
  assert.equal(panel.data.pet.sound, true);
  assert.equal(panel.data.pet.model, "keyboard");

  const workflow = store.execute({ projectId: "a", pluginId: "desktop-pet", contributionId: "poke", type: "workflows" });
  assert.match(workflow.prompt, /Project a/);

  await store.configure({ projectId: "a", pluginId: "desktop-pet", enabled: false, config: { ...snapshot[0].config, enabled: true }, expectedRevision: 2 });
  let binding = store.list("a").bindings.find((entry) => entry.pluginId === "desktop-pet");
  assert.equal(binding.enabled, false);
  assert.equal(binding.config.enabled, false);
  await store.configure({ projectId: "a", pluginId: "desktop-pet", enabled: true, config: { ...binding.config, enabled: false }, expectedRevision: 3 });
  binding = store.list("a").bindings.find((entry) => entry.pluginId === "desktop-pet");
  assert.equal(binding.enabled, true);
  assert.equal(binding.config.enabled, true);
});

test("plugin center owns pet configuration and exposes details before installation", async () => {
  const [html, panel, bridge] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/modules/project-plugins-panel.js", import.meta.url), "utf8"),
    readFile(new URL("../public/modules/pet-bridge.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /data-bot-settings-tab="pet"/);
  assert.match(html, /id="bot-settings-pet"/);
  assert.match(html, /id="bot-pet-settings-host"/);
  assert.match(html, /data-drawer[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(html, /data-drawer-install/);
  assert.match(panel, /function petConfigForm\(/);
  assert.match(panel, /查看详情/);
  assert.match(panel, /查看与配置/);
  assert.match(panel, /514cc:pet-settings-mounted/);
  assert.match(bridge, /petPluginGateReady && petPluginInstalled && petPluginBound && settings\.enabled/);
  assert.match(bridge, /request\(`\/api\/plugins\$\{/);
});
