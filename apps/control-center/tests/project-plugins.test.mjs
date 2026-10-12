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
test("an installed plugin left on an older catalog version is migrated to the current manifest", async (t) => {
  // 复现 2026-10-02 的真实故障：用户机器上装着 9/8 安装的 desktop-pet，
  // 其清单里 model.options 只有三种猫模式。后来目录加了 whale，但已装记录的
  // manifest 是旧的 —— 服务端 validateValue 按**已装清单**校验，选 whale 会被判"选项无效"。
  // 修法是给目录版本号 +1，让 init() 的 newerVersion 迁移把已装清单换成新目录。
  const { store, root, projects } = await fixture(t);
  await store.install({ catalogId: "desktop-pet", expectedRevision: 0 });
  const path = join(root, "project-plugins.json");
  const legacy = JSON.parse(await readFile(path, "utf8"));
  const item = legacy.installed[0];
  item.manifest.version = "1.2.0";
  item.manifest.settings.find((field) => field.id === "model").options = ["standard", "keyboard", "gamepad"];
  item.digest = createHash("sha256").update(JSON.stringify(item.manifest)).digest("hex");
  await writeFile(path, JSON.stringify(legacy));

  const restored = await new ProjectPluginStore({ dataRoot: root, projects }).init();
  const snapshot = restored.list("a");
  const catalogPet = PLUGIN_CATALOG.find((entry) => entry.id === "desktop-pet");
  assert.ok(catalogPet.settings.find((field) => field.id === "model").options.includes("whale"));
  assert.equal(snapshot.installed[0].manifest.version, catalogPet.version);
  assert.ok(
    snapshot.installed[0].manifest.settings.find((field) => field.id === "model").options.includes("whale"),
    "migration must refresh the installed manifest so new model options are accepted",
  );
  // 迁移后必须能真的存下新模型，否则界面选了也会被打回。
  await restored.configure({ projectId: "a", pluginId: "desktop-pet", enabled: true, config: { model: "whale" }, expectedRevision: snapshot.revision });
  assert.equal(restored.list("a").bindings[0].config.model, "whale");
});

test("desktop-pet configuration is global and survives switching projects", async (t) => {
  // 复现 2026-10-03 的真实故障：桌宠按项目存 binding，而 activeProjectId 跟着
  // 「当前可见会话」走 —— 项目 A 配 whale、项目 B 配 standard，用户一切到 B 就
  // "变回猫"。桌宠是桌面级单窗口，配置必须全局单份。
  const { store } = await fixture(t);
  await store.install({ catalogId: "desktop-pet", expectedRevision: 0 });
  await store.configure({ projectId: "a", pluginId: "desktop-pet", enabled: true, config: { model: "whale" }, expectedRevision: 1 });
  // 关键：换一个项目查，绑定仍在，且配置一模一样。
  for (const projectId of ["a", "b"]) {
    const pet = store.list(projectId).bindings.find((entry) => entry.pluginId === "desktop-pet");
    assert.ok(pet, `${projectId} 必须能看到全局桌宠绑定`);
    assert.equal(pet.config.model, "whale");
    assert.equal(pet.projectId, "@desktop", "桌宠绑定必须落在全局槽，不能挂在某个项目上");
    assert.equal(store.snapshot(projectId).find((entry) => entry.id === "desktop-pet").config.model, "whale");
  }
  // 在另一个项目里改配置 = 改全局那一份（这是有意的：只有一个窗口）。
  await store.configure({ projectId: "b", pluginId: "desktop-pet", enabled: true, config: { model: "keyboard" }, expectedRevision: 2 });
  assert.equal(store.list("a").bindings.find((entry) => entry.pluginId === "desktop-pet").config.model, "keyboard");
  assert.equal(store.list().bindings.filter((entry) => entry.pluginId === "desktop-pet").length, 1, "全局只能有一份桌宠绑定");
  // 非桌宠插件仍是每项目独立。
  await store.install({ catalogId: "project-context", expectedRevision: 3 });
  await store.configure({ projectId: "a", pluginId: "project-context", enabled: true, expectedRevision: 4 });
  assert.deepEqual(store.list("b").bindings.filter((entry) => entry.pluginId === "project-context"), []);
});

test("legacy per-project desktop-pet bindings fold into one global binding", async (t) => {
  const { store, root, projects } = await fixture(t);
  await store.install({ catalogId: "desktop-pet", expectedRevision: 0 });
  await store.configure({ projectId: "a", pluginId: "desktop-pet", enabled: true, config: { model: "standard" }, expectedRevision: 1 });
  await store.configure({ projectId: "b", pluginId: "desktop-pet", enabled: true, config: { model: "whale" }, expectedRevision: 2 });
  // 手工造出「旧版按项目存」的形态：两条绑定分别挂在 a / b。
  const path = join(root, "project-plugins.json");
  const legacy = JSON.parse(await readFile(path, "utf8"));
  const globalPet = legacy.bindings.find((entry) => entry.pluginId === "desktop-pet");
  globalPet.projectId = "a";
  legacy.bindings.push({ ...globalPet, projectId: "b" });
  await writeFile(path, JSON.stringify(legacy));

  const restored = await new ProjectPluginStore({ dataRoot: root, projects }).init();
  const pets = restored.list("a").bindings.filter((entry) => entry.pluginId === "desktop-pet");
  assert.equal(pets.length, 1, "迁移必须把多份按项目的桌宠绑定折叠成一份");
  assert.equal(pets[0].projectId, "@desktop");
  // 折叠取末位：b 是最后配置的，whale 应当胜出。
  assert.equal(pets[0].config.model, "whale");
  // 迁移必须落盘，否则下次重启又散开。
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.bindings.filter((entry) => entry.pluginId === "desktop-pet").length, 1);
  assert.ok(persisted.revision > legacy.revision, "折叠是一次迁移，revision 必须前进");
});

test("legacy interactive:false bindings are raised to the new default without touching other settings", async (t) => {
  // 2026-10-03：互动模式默认值 false → true。已装清单的 default 会随版本迁移刷新，
  // 但**已保存的 binding.config 是显式值**，configFor 原样保留 —— 老用户会继续
  // 停在 interactive:false，拖拽/右键/戳一戳全哑。这是默认值语义变更，要跟着抬。
  const { store, root, projects } = await fixture(t);
  await store.install({ catalogId: "desktop-pet", expectedRevision: 0 });
  await store.configure({ projectId: "a", pluginId: "desktop-pet", enabled: true, config: { interactive: false, opacity: 70 }, expectedRevision: 1 });
  const path = join(root, "project-plugins.json");
  const legacy = JSON.parse(await readFile(path, "utf8"));
  const item = legacy.installed[0];
  // 退回旧版本 + 旧默认值，模拟真实老安装。
  item.manifest.version = "1.2.1";
  item.manifest.settings.find((field) => field.id === "interactive").default = false;
  item.digest = createHash("sha256").update(JSON.stringify(item.manifest)).digest("hex");
  await writeFile(path, JSON.stringify(legacy));

  const restored = await new ProjectPluginStore({ dataRoot: root, projects }).init();
  const pet = restored.list("a").bindings.find((entry) => entry.pluginId === "desktop-pet");
  assert.equal(pet.config.interactive, true, "老配置的 interactive:false 必须被抬到新默认");
  assert.equal(pet.config.opacity, 70, "只抬默认值语义，其余用户配置不得被动");
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.bindings.find((entry) => entry.pluginId === "desktop-pet").config.interactive, true);
  // 迁移只跑一次：再启一次不应继续动 revision。
  const again = await new ProjectPluginStore({ dataRoot: root, projects }).init();
  assert.equal(again.list("a").revision, restored.list("a").revision, "迁移必须幂等");
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
  // 不写死版本号：目录一升版就该跟着走，否则每次加能力都要改测试。
  assert.equal(snapshot.installed[0].manifest.version, PLUGIN_CATALOG.find((item) => item.id === "desktop-pet").version);
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
