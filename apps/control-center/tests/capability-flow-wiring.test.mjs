// capability.changed 中段接线测试（T4 watcher onChanged → modelDiscovery.invalidate +
// eventStore.emit）：完整 createControlCenter 装配，临时目录 + CONTROL_CENTER_RUNTIME_HOME
// 隔离，改一次 fixture ~/.grok/config.toml → 断言事件载荷与缓存失效调用都如实发生。
import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createControlCenter } from "../src/app.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRepo = resolve(appRoot, "../..");

// 与 app-close.test.mjs 同款隔离仓：真实配置拷入临时目录，不动仓库本体。
async function createIsolatedRepo(root) {
  const repoRoot = resolve(root, "repo");
  const configRoot = resolve(repoRoot, "config/control-center");
  const schemaRoot = resolve(repoRoot, "schemas/control-center");
  await mkdir(configRoot, { recursive: true });
  await mkdir(schemaRoot, { recursive: true });
  for (const name of ["models.json", "routing.json", "permissions.json", "claude-coordinator.md"]) {
    await cp(resolve(sourceRepo, "config/control-center", name), resolve(configRoot, name));
  }
  await cp(resolve(sourceRepo, "schemas/control-center/contracts.schema.json"), resolve(schemaRoot, "contracts.schema.json"));
  await writeFile(resolve(configRoot, "sources.json"), `${JSON.stringify({
    version: 1,
    explicit: [
      { id: "control.models", path: "config/control-center/models.json", label: "Models", kind: "json", scope: "repo", critical: true },
      { id: "control.routing", path: "config/control-center/routing.json", label: "Routing", kind: "json", scope: "repo", critical: true },
      { id: "control.permissions", path: "config/control-center/permissions.json", label: "Permissions", kind: "json", scope: "repo", critical: true },
      { id: "control.claude-coordinator", path: "config/control-center/claude-coordinator.md", label: "Coordinator", kind: "markdown", scope: "repo", critical: true },
    ],
    discover: [],
    runtime: [],
  }, null, 2)}\n`, "utf8");
  return repoRoot;
}

/** 等 watcher 基线快照落定（与 capability-watcher.test.mjs 同款纪律：
 * 基线未落就写文件，首个变更可能被基线读吞掉，测试必须拿确定性基线）。 */
async function waitForBaseline(state, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const entry = state.capabilityWatcher.states.get("grok-config");
    if (entry && entry.hash != null) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`capability watcher baseline did not settle within ${timeoutMs}ms`);
}

function waitForEvent(events, timeoutMs = 20_000) {
  return new Promise((resolveWait, rejectWait) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (events.length) {
        clearInterval(timer);
        resolveWait(events[0]);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        rejectWait(new Error("timed out waiting for capability.changed event"));
      }
    }, 20);
  });
}

test("改 ~/.grok/config.toml → capability.changed 接线：事件载荷如实、缓存失效被调用", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-capability-flow-wiring-"));
  const runtimeHome = resolve(root, "home");
  await mkdir(join(runtimeHome, ".grok"), { recursive: true });
  const configPath = join(runtimeHome, ".grok", "config.toml");
  await writeFile(configPath, '[ui]\ncompact_mode = false\n', "utf8");

  const previousRuntimeHome = process.env.CONTROL_CENTER_RUNTIME_HOME;
  process.env.CONTROL_CENTER_RUNTIME_HOME = runtimeHome;
  let state = null;
  t.after(async () => {
    if (previousRuntimeHome === undefined) delete process.env.CONTROL_CENTER_RUNTIME_HOME;
    else process.env.CONTROL_CENTER_RUNTIME_HOME = previousRuntimeHome;
    if (state) await state.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const repoRoot = await createIsolatedRepo(root);
  state = await createControlCenter({ repoRoot, dataRoot: resolve(root, "data") });

  // watcher 清单确实盯上了隔离仓的 grok config（非凭据目标，过 liveConfigTargets 过滤）
  const entry = state.capabilityWatcher.states.get("grok-config");
  assert.ok(entry, "grok-config 必须在监听清单内");
  assert.equal(entry.target.path, configPath);
  assert.equal(entry.target.runtimeProfileId, "grok-build");

  // modelDiscovery.invalidate 探针：保留原实现，只记调用（接线的第一段）
  const invalidateCalls = [];
  const originalInvalidate = state.modelDiscovery.invalidate.bind(state.modelDiscovery);
  state.modelDiscovery.invalidate = (agentId) => {
    invalidateCalls.push(agentId);
    return originalInvalidate(agentId);
  };

  // eventStore 订阅收集 capability.changed（接线的第二段）
  const events = [];
  const unsubscribe = state.eventStore.subscribe((event) => {
    if (event.type === "capability.changed") events.push(event);
  });
  t.after(unsubscribe);

  await waitForBaseline(state);
  await writeFile(configPath, '[ui]\ncompact_mode = true\n', "utf8");
  const event = await waitForEvent(events);

  // payload 如实：席位标识 + 变更键名（只有键名，配置值永不进事件流）+ 非降级
  assert.equal(event.data.runtimeProfileId, "grok-build");
  assert.ok(event.data.changedKeys.includes("ui.compact_mode"), `changedKeys 应含 ui.compact_mode，实际 ${JSON.stringify(event.data.changedKeys)}`);
  assert.equal(event.data.degraded, false);
  assert.ok(event.data.changedAt, "事件必须带变更时间戳");
  assert.ok(!JSON.stringify(event).includes("compact_mode = true"), "配置值不得进事件载荷");

  // 缓存失效被调用且指向 grok 席位：5 分钟发现缓存不再挡外改的真值
  assert.ok(invalidateCalls.includes("grok-build"), `modelDiscovery.invalidate 必须被调用，实际 ${JSON.stringify(invalidateCalls)}`);

  // 可见效果断言：失效后缓存签名随配置内容变化（重新发现路径已打开）
  const signature = state.modelDiscovery.signatureOf("grok-build");
  await writeFile(configPath, '[ui]\ncompact_mode = false\nmax_thoughts_width = 99\n', "utf8");
  assert.notEqual(state.modelDiscovery.signatureOf("grok-build"), signature, "配置再变签名必须再变");
});
