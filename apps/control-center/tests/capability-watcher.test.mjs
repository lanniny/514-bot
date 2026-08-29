// capability-watcher（T4）单元测试：写触发 → 防抖 → 哈希去重 → onChanged payload；
// 缺失态、原子写（rename 替换）、不存在的监听目标降级轮询。全部临时目录驱动，
// 不触碰真实 ~/.grok（该文件含密钥，测试也不读其内容）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import {
  CapabilityWatcher,
  MISSING_CAPABILITY_HASH,
  capabilityWatchTargets,
  diffConfigKeys,
  summarizeConfigKeys,
} from "../src/capability-watcher.mjs";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const roots = [];

async function makeRoot(label) {
  const root = await mkdtemp(resolve(appRoot, label));
  roots.push(root);
  return root;
}

after(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

/** 等到 onChanged 收到第 n 条（超时判失败）。全量套件重负载下 fs 通知可能迟到，
 * 靠 watcher 的复核拍（测试里压到 800ms）兜底收敛，超时给足。 */
function waitForChange(events, count, timeoutMs = 15000) {
  return new Promise((resolveWait, rejectWait) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (events.length >= count) {
        clearInterval(timer);
        resolveWait(events[count - 1]);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        rejectWait(new Error(`timed out waiting for change #${count} (got ${events.length})`));
      }
    }, 20);
  });
}

/** 等基线快照落定（entry.hash 被首次赋值）。基线是异步的：若不等待，
 * start() 后紧挨着的第一次写可能先于基线读落盘，基线会误记写入后的内容，
 * 导致首个变更事件被哈希比对吞掉——测试必须拿到确定性基线。 */
async function waitForBaseline(watcher, id, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const entry = watcher.states.get(id);
    if (entry && entry.hash != null) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 15));
  }
  throw new Error(`baseline for ${id} did not settle within ${timeoutMs}ms`);
}

/** 断言一段时间内没有新事件（哈希去重/防抖合并的否定面）。 */
async function expectNoMoreEvents(events, count, windowMs = 700) {
  await new Promise((resolveWait) => setTimeout(resolveWait, windowMs));
  assert.equal(events.length, count, `expected ${count} events, got ${events.length}`);
}

test("summarizeConfigKeys/diffConfigKeys 只抽键名，值不参与输出", () => {
  const summary = summarizeConfigKeys([
    "# comment",
    "[models]",
    'default = "profile-a"',
    '[model."profile-a"]',
    'api_key = "sk-secret"',
    "context_window = 500000",
  ].join("\n"));
  assert.deepEqual([...summary.keys()].sort(), ["model.\"profile-a\".api_key", "model.\"profile-a\".context_window", "models.default"]);
  // 摘要值全是哈希，不含原文
  for (const digest of summary.values()) assert.match(digest, /^[0-9a-f]{64}$/);
  const next = summarizeConfigKeys([
    "[models]",
    'default = "profile-b"',
    '[model."profile-a"]',
    "context_window = 128000",
  ].join("\n"));
  assert.deepEqual(diffConfigKeys(summary, next), [
    "model.\"profile-a\".api_key",
    "model.\"profile-a\".context_window",
    "models.default",
  ]);
});

test("capabilityWatchTargets 绑定 grok-build 席位", () => {
  const targets = capabilityWatchTargets("C:/Users/lo");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].runtimeProfileId, "grok-build");
  // path.join 风格与 ProviderStore.liveConfigTargets 对齐（Windows 反斜杠）
  assert.equal(targets[0].path, join("C:/Users/lo", ".grok/config.toml"));
});

test("写触发 → 防抖合并 → onChanged 收到正确 payload", async () => {
  const root = await makeRoot(".test-caps-watch-");
  const dir = join(root, ".grok");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "config.toml");
  await writeFile(path, '[models]\ndefault = "a"\n', "utf8");

  const events = [];
  const watcher = new CapabilityWatcher({
    targets: [{ id: "grok-config", path, runtimeProfileId: "grok-build" }],
    onChanged: (change) => { events.push(change); },
    debounceMs: 60,
    reconcileMs: 800,
  });
  watcher.start();
  try {
    await waitForBaseline(watcher, "grok-config");
    // 两次写各自独立成拍（间隔大于防抖窗），每拍一次回调且键名如实反映该拍变更；
    // 防抖的合并语义由「同内容重写不发事件」与「原子写单次回调」用例兼证，
    // 不在这里赌两次异步写是否恰好落进同一个 60ms 窗口
    await writeFile(path, '[models]\ndefault = "b"\n', "utf8");
    const first = await waitForChange(events, 1);
    assert.equal(first.runtimeProfileId, "grok-build");
    assert.equal(first.path, path);
    assert.equal(first.degraded, false);
    assert.equal(first.missing, false);
    assert.match(first.hash, /^[0-9a-f]{64}$/);
    assert.ok(first.changedKeys.includes("models.default"));

    await writeFile(path, '[models]\ndefault = "b"\ncompact_mode = true\n', "utf8");
    const second = await waitForChange(events, 2);
    assert.ok(second.changedKeys.includes("models.compact_mode"), `第二拍应报 models.compact_mode，实际 ${JSON.stringify(second.changedKeys)}`);
    assert.ok(!second.changedKeys.includes("models.default"), "第二拍只报新增键，不重复上报");
    await expectNoMoreEvents(events, 2, 400);
    // changedKeys 只有键名：文件内容值（含密钥位）绝不进 payload
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes("profile-a") && !serialized.includes("sk-"));
  } finally {
    watcher.stop();
  }
});

test("内容不变不产生事件（哈希去重）", async () => {
  const root = await makeRoot(".test-caps-watch-");
  const dir = join(root, ".grok");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "config.toml");
  const content = '[models]\ndefault = "a"\n';
  await writeFile(path, content, "utf8");

  const events = [];
  const watcher = new CapabilityWatcher({
    targets: [{ id: "grok-config", path, runtimeProfileId: "grok-build" }],
    onChanged: (change) => { events.push(change); },
    debounceMs: 60,
    reconcileMs: 800,
  });
  watcher.start();
  try {
    await waitForBaseline(watcher, "grok-config");
    await writeFile(path, '[models]\ndefault = "b"\n', "utf8");
    await waitForChange(events, 1);
    // 同内容重写（编辑器存盘/原子触摸）→ 哈希一致 → 不发事件
    await writeFile(path, '[models]\ndefault = "b"\n', "utf8");
    await expectNoMoreEvents(events, 1);
  } finally {
    watcher.stop();
  }
});

test("文件缺失参与比对：删除与重建各发一次事件", async () => {
  const root = await makeRoot(".test-caps-watch-");
  const dir = join(root, ".grok");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "config.toml");
  await writeFile(path, '[models]\ndefault = "a"\n', "utf8");

  const events = [];
  const watcher = new CapabilityWatcher({
    targets: [{ id: "grok-config", path, runtimeProfileId: "grok-build" }],
    onChanged: (change) => { events.push(change); },
    debounceMs: 60,
    reconcileMs: 800,
  });
  watcher.start();
  try {
    await waitForBaseline(watcher, "grok-config");
    await rm(path);
    const removed = await waitForChange(events, 1);
    assert.equal(removed.missing, true);
    assert.equal(removed.hash, MISSING_CAPABILITY_HASH);
    assert.deepEqual(removed.changedKeys, ["models.default"]); // 之前存在的键名如实上报

    await writeFile(path, '[models]\ndefault = "a"\n', "utf8");
    const restored = await waitForChange(events, 2);
    assert.equal(restored.missing, false);
    assert.match(restored.hash, /^[0-9a-f]{64}$/);
  } finally {
    watcher.stop();
  }
});

test("原子写（临时文件 + rename 替换）后仍能继续感知", async () => {
  const root = await makeRoot(".test-caps-watch-");
  const dir = join(root, ".grok");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "config.toml");
  await writeFile(path, '[models]\ndefault = "a"\n', "utf8");

  const events = [];
  const watcher = new CapabilityWatcher({
    targets: [{ id: "grok-config", path, runtimeProfileId: "grok-build" }],
    onChanged: (change) => { events.push(change); },
    debounceMs: 60,
    reconcileMs: 800,
  });
  watcher.start();
  try {
    await waitForBaseline(watcher, "grok-config");
    // Windows 原子写模式：写临时文件再 rename 覆盖目标（文件句柄被替换）
    const temp = join(dir, "config.toml.tmp");
    await writeFile(temp, '[models]\ndefault = "renamed"\n', "utf8");
    await rename(temp, path);
    const change = await waitForChange(events, 1);
    assert.ok(change.changedKeys.includes("models.default"));

    // 替换后目录通道继续兜底：再原子写一次
    await writeFile(temp, '[models]\ndefault = "again"\n', "utf8");
    await rename(temp, path);
    await waitForChange(events, 2);
  } finally {
    watcher.stop();
  }
});

test("不存在的监听目标不炸：降级为惰性轮询并标 degraded", async () => {
  const root = await makeRoot(".test-caps-watch-");
  const dir = join(root, "does-not-exist-yet", ".grok");
  const path = join(dir, "config.toml");

  const events = [];
  const watcher = new CapabilityWatcher({
    targets: [{ id: "ghost-config", path, runtimeProfileId: "grok-build" }],
    onChanged: (change) => { events.push(change); },
    debounceMs: 60,
    degradedPollMs: 300,
  });
  watcher.start();
  try {
    // start 不抛；降级拍先把「缺失」记为基线，之后目标出现 → 事件标 degraded
    await waitForBaseline(watcher, "ghost-config");
    await mkdir(dir, { recursive: true });
    await writeFile(path, '[models]\ndefault = "late"\n', "utf8");
    const change = await waitForChange(events, 1, 5000);
    assert.equal(change.degraded, true);
    assert.equal(change.runtimeProfileId, "grok-build");
    assert.ok(change.changedKeys.includes("models.default"));
  } finally {
    watcher.stop();
  }
});

test("stop 之后不再回调", async () => {
  const root = await makeRoot(".test-caps-watch-");
  const dir = join(root, ".grok");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "config.toml");
  await writeFile(path, '[models]\ndefault = "a"\n', "utf8");

  const events = [];
  const watcher = new CapabilityWatcher({
    targets: [{ id: "grok-config", path, runtimeProfileId: "grok-build" }],
    onChanged: (change) => { events.push(change); },
    debounceMs: 60,
    reconcileMs: 800,
  });
  watcher.start();
  watcher.stop();
  await writeFile(path, '[models]\ndefault = "b"\n', "utf8");
  await expectNoMoreEvents(events, 0);
});

test("onChanged 首次抛错不丢事件：旧哈希保留，下一拍重试如实送达且内容正确", async () => {
  const root = await makeRoot(".test-caps-watch-");
  const dir = join(root, ".grok");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "config.toml");
  await writeFile(path, '[models]\ndefault = "a"\n', "utf8");

  let attempts = 0;
  const events = [];
  const watcher = new CapabilityWatcher({
    targets: [{ id: "grok-config", path, runtimeProfileId: "grok-build" }],
    // 第一次回调抛错：若哈希先提交，该次变更会被 hash === entry.hash 吞掉永久丢失；
    // 修复后旧哈希保留，安全网/复核拍重试把同一事件发出。
    onChanged: (change) => {
      attempts += 1;
      if (attempts === 1) throw new Error("downstream boom");
      events.push(change);
    },
    debounceMs: 60,
    reconcileMs: 800,
  });
  watcher.start();
  try {
    await waitForBaseline(watcher, "grok-config");
    await writeFile(path, '[models]\ndefault = "b"\n', "utf8");
    const retried = await waitForChange(events, 1);
    assert.equal(attempts, 2, "首次抛错后必须由下一拍重试成功");
    // 重试发出的就是那次被吞掉的变更：内容如实，不多不少
    assert.equal(retried.runtimeProfileId, "grok-build");
    assert.equal(retried.missing, false);
    assert.ok(retried.changedKeys.includes("models.default"), `重试事件应报 models.default，实际 ${JSON.stringify(retried.changedKeys)}`);
    await expectNoMoreEvents(events, 1, 1200);
    // 监听循环存活：重试提交哈希后，下一次真实变更照常送达（不重复不丢失）
    await writeFile(path, '[models]\ndefault = "c"\n', "utf8");
    const third = await waitForChange(events, 2);
    assert.ok(third.changedKeys.includes("models.default"));
  } finally {
    watcher.stop();
  }
});
