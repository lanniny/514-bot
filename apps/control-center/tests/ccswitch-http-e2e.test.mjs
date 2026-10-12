import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnTestServer, stopTestServer, waitForUrl } from "./server-fixture.mjs";
import { PROVIDER_APPS } from "../src/providers.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

async function api(origin, token, path, { method = "GET", body } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

test("CC-Switch HTTP E2E：领域资源、掩码深链、备份和代理生命周期", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-ccswitch-http-"));
  const dataRoot = join(root, "data");
  const runtimeHome = join(root, "home");
  await mkdir(runtimeHome, { recursive: true });
  const token = "ccswitch-http-e2e-token";
  const child = spawnTestServer({ env: { CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_DATA_DIR: dataRoot, CONTROL_CENTER_RUNTIME_HOME: runtimeHome, CONTROL_CENTER_PORT: "0" } });
  const origin = new URL(await waitForUrl(child)).origin;
  t.after(async () => {
    await stopTestServer(child, { token });
    await rm(root, { recursive: true, force: true });
  });

  const unauthorized = await fetch(`${origin}/api/ccswitch/domain`);
  assert.equal(unauthorized.status, 401);

  const domain = await api(origin, token, "/api/ccswitch/domain");
  assert.equal(domain.response.status, 200);
  assert.equal(domain.payload.state.storeStatus.state, "missing");
  // 期望从 PROVIDER_APPS 推导：app 清单是活文档，硬编码数字每次新增 CLI 都会腐坏
  assert.equal(Object.keys(domain.payload.configPaths).length, PROVIDER_APPS.length);

  const createdPrompt = await api(origin, token, "/api/ccswitch/domain/prompts", {
    method: "POST",
    body: { app: "codex", name: "E2E prompt", content: "Read the repository first.", enabled: true },
  });
  assert.equal(createdPrompt.response.status, 200);
  assert.equal(createdPrompt.payload.item.enabled, true);
  assert.equal(await readFile(join(runtimeHome, ".codex", "AGENTS.md"), "utf8"), "Read the repository first.");

  const mcp = await api(origin, token, "/api/ccswitch/domain/mcps", {
    method: "POST",
    body: { id: "e2e-mcp", name: "E2E MCP", config: { command: "node", args: ["server.mjs"] }, apps: { claude: true, codex: true } },
  });
  assert.equal(mcp.response.status, 200);
  assert.equal(mcp.payload.item.apps.codex, true);
  assert.match(await readFile(join(runtimeHome, ".codex", "config.toml"), "utf8"), /514-forge-mcp \(e2e-mcp\)/);

  const preview = await api(origin, token, "/api/ccswitch/domain/deeplink/parse", {
    method: "POST",
    body: { url: "ccswitch://v1/import?resource=provider&app=codex&name=Secret&endpoint=https%3A%2F%2Fapi.example.com&apiKey=sk-super-secret" },
  });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.payload.resource, "provider");
  assert.equal(JSON.stringify(preview.payload).includes("sk-super-secret"), false);
  assert.match(JSON.stringify(preview.payload), /••••cret/);

  const promptLink = "ccswitch://v1/import?resource=prompt&app=claude&name=Deep%20Prompt&content=Hello%20from%20link&enabled=true";
  const imported = await api(origin, token, "/api/ccswitch/domain/deeplink/import", { method: "POST", body: { url: promptLink } });
  assert.equal(imported.response.status, 201);
  assert.equal(imported.payload.resource, "prompt");
  assert.equal(await readFile(join(runtimeHome, ".claude", "CLAUDE.md"), "utf8"), "Hello from link");

  const backup = await api(origin, token, "/api/ccswitch/domain/backups", { method: "POST", body: { name: "e2e" } });
  assert.equal(backup.response.status, 201);
  const backups = await api(origin, token, "/api/ccswitch/domain/backups");
  assert.ok(backups.payload.items.some((item) => item.filename === backup.payload.item.filename));

  const workspace = await api(origin, token, "/api/ccswitch/domain/workspace/openclaw/files/AGENTS.md", { method: "PUT", body: { content: "OpenClaw E2E" } });
  assert.equal(workspace.response.status, 200);
  assert.equal(await readFile(join(runtimeHome, ".openclaw", "workspace", "AGENTS.md"), "utf8"), "OpenClaw E2E");
  await api(origin, token, "/api/ccswitch/domain/workspace/openclaw/daily/2026-07-27.md", { method: "PUT", body: { content: "daily e2e needle" } });
  const searched = await api(origin, token, "/api/ccswitch/domain/workspace/openclaw/daily/search", { method: "POST", body: { query: "needle" } });
  assert.deepEqual(searched.payload.items.map((item) => item.filename), ["2026-07-27.md"]);
  await api(origin, token, "/api/ccswitch/domain/workspace/hermes/memory", { method: "PUT", body: { content: "Hermes E2E" } });
  const hermes = await api(origin, token, "/api/ccswitch/domain/workspace/hermes/memory");
  assert.equal(hermes.payload.item.content, "Hermes E2E");

  const configured = await api(origin, token, "/api/ccswitch/proxy/config", { method: "PUT", body: { listenPort: 0 } });
  assert.equal(configured.response.status, 200);
  const started = await api(origin, token, "/api/ccswitch/proxy/start", { method: "POST", body: {} });
  assert.equal(started.response.status, 200);
  assert.equal(started.payload.status.running, true);
  assert.match(started.payload.status.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const stopped = await api(origin, token, "/api/ccswitch/proxy/stop", { method: "POST", body: { restore: true } });
  assert.equal(stopped.response.status, 200);
  assert.equal(stopped.payload.status.running, false);

  const auth = await api(origin, token, "/api/ccswitch/auth");
  assert.equal(auth.response.status, 200);
  assert.deepEqual(auth.payload.providers.map((item) => item.provider), ["github_copilot", "codex_oauth", "xai_oauth"]);
  assert.equal(JSON.stringify(auth.payload).includes("accessToken"), false);
});

test("CC-Switch UI 契约：可见四面、八应用、三账户和原生深链交接", async () => {
  const [html, app, panel, css, iconManifest] = await Promise.all([
    readFile(join(appRoot, "public", "index.html"), "utf8"),
    readFile(join(appRoot, "public", "app.js"), "utf8"),
    readFile(join(appRoot, "public", "modules", "ccswitch-panel.js"), "utf8"),
    readFile(join(appRoot, "public", "styles.css"), "utf8"),
    readFile(join(appRoot, "public", "lucide-icons.json"), "utf8").then(JSON.parse),
  ]);
  assert.match(html, /id="ccswitch-workbench"/);
  for (const tab of ["proxy", "resources", "sync", "accounts"]) assert.match(panel, new RegExp(`\\["${tab}"`));
  for (const appId of ["claude", "claude-desktop", "codex", "gemini", "grokbuild", "kimi", "opencode", "openclaw", "hermes"]) assert.match(panel, new RegExp(`"${appId}"`));
  for (const provider of ["github_copilot", "codex_oauth", "xai_oauth"]) assert.match(panel, new RegExp(provider));
  for (const command of ["get_native_capabilities", "set_auto_launch", "update_tray_menu", "restart_app", "enter_lightweight_mode", "exit_lightweight_mode"]) assert.match(panel, new RegExp(command));
  for (const surface of ["WebDAV", "S3", "Stream Check", "环境冲突", "配置目录", "统一深链", "Workspace", "Daily Memory", "Hermes Memory", "出站代理"]) assert.ok(panel.includes(surface), `missing UI surface: ${surface}`);
  for (const label of ["超时 ms", "降级阈值 ms", "并发数"]) assert.ok(panel.includes(`field-label">${label}`), `missing Stream Check label: ${label}`);
  assert.match(app, /window\.__forgeCcSwitchPanel\?\.openDeeplink/);
  assert.match(app, /mountCcSwitchPanel\(\{ root: byId\("ccswitch-workbench"\)/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.doesNotMatch(panel, /window\.prompt\s*\(/);
  const availableIcons = new Set(iconManifest.icons);
  const panelIcons = [...new Set([...panel.matchAll(/icon\("([^"]+)"\)/g)].map((match) => match[1]))];
  assert.deepEqual(panelIcons.filter((name) => !availableIcons.has(name)), [], "CC-Switch panel references missing Lucide symbols");
});
