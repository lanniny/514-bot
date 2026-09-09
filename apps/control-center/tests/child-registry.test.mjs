import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import {
  configureChildRegistry,
  defaultKillTree,
  parseProcessIdentityOutput,
  queryProcessIdentity,
} from "../src/child-registry.mjs";

const REGISTERED_AT = "2026-07-21T10:00:00.000Z";
const CREATED_BEFORE = "2026-07-21T09:59:00.000Z";
const CREATED_AFTER = "2026-07-21T10:00:10.000Z";

function memoryLedger(children = null, updatedAt = REGISTERED_AT) {
  let raw = children === null
    ? null
    : `${JSON.stringify({ ownerPid: 99999999, updatedAt, children }, null, 2)}\n`;
  return {
    storage: {
      async mkdir() {},
      async readFile() {
        if (raw === null) {
          const error = new Error("not found");
          error.code = "ENOENT";
          throw error;
        }
        return raw;
      },
      async writeFile(_file, value) {
        raw = String(value);
      },
    },
    read() {
      return raw === null ? null : JSON.parse(raw);
    },
  };
}

function child(pid, image = "node.exe", registeredAt = REGISTERED_AT) {
  return { pid, image, registeredAt };
}

function identity(image = "node.exe", createdAt = CREATED_BEFORE) {
  return { image, createdAt };
}

// 默认测试只使用注入式探针/终止器，不创建真实 sleeper，也不会接触机器上的进程。
test("reapPrevious reaps only an attested process and retires pid-reuse guarded entries", async () => {
  const ledger = memoryLedger([
    child(31_001, "Node.EXE"),
    child(31_002, "codex.exe"),
    child(31_003),
    child(31_004, ""),
  ]);
  const states = new Map([
    [31_001, identity()],
    [31_002, identity("node.exe")],
    [31_003, identity("node.exe", CREATED_AFTER)],
    [31_004, identity()],
  ]);
  const killed = [];
  const registry = configureChildRegistry({ dataRoot: "memory-reaper", storage: ledger.storage });
  const result = await registry.reapPrevious({
    probe: async (pid) => states.get(pid),
    kill: async (pid) => {
      killed.push(pid);
      states.set(pid, null);
      return true;
    },
  });

  assert.deepEqual(killed, [31_001]);
  assert.deepEqual(result, { reaped: 1, skipped: 3, failed: 0, pending: 1 });
  assert.deepEqual(ledger.read().children.map(({ pid }) => pid), [31_004]);
});

test("reapPrevious retains nonzero, thrown, and still-alive termination failures", async () => {
  const ledger = memoryLedger([child(32_001), child(32_002), child(32_003)]);
  const states = new Map([
    [32_001, identity()],
    [32_002, identity()],
    [32_003, identity()],
  ]);
  const registry = configureChildRegistry({ dataRoot: "memory-failures", storage: ledger.storage });
  const result = await registry.reapPrevious({
    probe: async (pid) => states.get(pid),
    kill: async (pid) => {
      if (pid === 32_001) return false; // taskkill 非零退出
      if (pid === 32_002) return true; // 命令成功但探针仍确认存活
      throw new Error("terminator failed");
    },
  });

  assert.deepEqual(result, { reaped: 0, skipped: 3, failed: 3, pending: 3 });
  assert.deepEqual(ledger.read().children.map(({ pid }) => pid), [32_001, 32_002, 32_003]);
});

test("reapPrevious retains entries when probe data or required identity fields are unavailable", async () => {
  const ledger = memoryLedger([
    child(33_001),
    child(33_002),
    child(33_003, "node.exe", "not-a-date"),
  ], "not-a-date");
  let killCalled = false;
  const registry = configureChildRegistry({ dataRoot: "memory-unknown", storage: ledger.storage });
  const result = await registry.reapPrevious({
    probe: async (pid) => {
      if (pid === 33_001) return undefined;
      if (pid === 33_002) return identity("node.exe", null);
      return identity();
    },
    kill: async () => {
      killCalled = true;
      return true;
    },
  });

  assert.equal(killCalled, false);
  assert.deepEqual(result, { reaped: 0, skipped: 3, failed: 0, pending: 3 });
  assert.deepEqual(ledger.read().children.map(({ pid }) => pid), [33_001, 33_002, 33_003]);
});

test("process identity parser preserves unknown for malformed or missing records", () => {
  const parsed = parseProcessIdentityOutput([
    JSON.stringify({ pid: 35_001, exists: true, image: "Node.EXE", createdAt: null }),
    JSON.stringify({ pid: 35_002, exists: false }),
    "not-json",
    JSON.stringify({ pid: 99_999, exists: false }),
    JSON.stringify({ pid: 35_004, exists: true, createdAt: CREATED_BEFORE }),
    JSON.stringify({ pid: 35_005, exists: false }),
    JSON.stringify({ pid: 35_005, exists: true, image: "node.exe", createdAt: CREATED_BEFORE }),
  ].join("\n"), [35_001, 35_002, 35_003, 35_004, 35_005]);

  assert.deepEqual(parsed.get(35_001), { image: "node.exe", createdAt: null });
  assert.equal(parsed.get(35_002), null);
  assert.equal(parsed.get(35_003), undefined);
  assert.equal(parsed.get(35_004), undefined);
  assert.equal(parsed.get(35_005), undefined);
});

test("defaultKillTree reports the real taskkill exit status", async () => {
  const fakeSpawn = (exit) => (command, args, options) => {
    assert.equal(command, "taskkill.exe");
    assert.deepEqual(args, ["/PID", "34001", "/T", "/F"]);
    assert.equal(options.shell, false);
    const process = new EventEmitter();
    queueMicrotask(() => {
      if (exit instanceof Error) process.emit("error", exit);
      else process.emit("close", exit);
    });
    return process;
  };

  assert.equal(await defaultKillTree(34_001, { platform: "win32", spawnImpl: fakeSpawn(0) }), true);
  assert.equal(await defaultKillTree(34_001, { platform: "win32", spawnImpl: fakeSpawn(1) }), false);
  assert.equal(await defaultKillTree(34_001, { platform: "win32", spawnImpl: fakeSpawn(new Error("spawn")) }), false);
  assert.equal(await defaultKillTree(34_001, {
    platform: "win32",
    spawnImpl: () => { throw new Error("sync spawn"); },
  }), false);
});

test("registry persistence serializes registration lifecycle", async () => {
  const ledger = memoryLedger();
  const registry = configureChildRegistry({ dataRoot: "memory-lifecycle", storage: ledger.storage });
  registry.register(12_345, "codex.exe");
  registry.register(23_456, "node.exe");
  registry.unregister(12_345);
  await registry.flush();

  const persisted = ledger.read();
  assert.equal(persisted.ownerPid, process.pid);
  assert.equal(persisted.children.length, 1);
  assert.equal(persisted.children[0].pid, 23_456);
  assert.equal(persisted.children[0].image, "node.exe");
  assert.ok(persisted.children[0].registeredAt);
});

test("defaultKillTree bounds a stuck termination helper and reports failure", async () => {
  let killed = false;
  const helper = new EventEmitter();
  helper.kill = () => { killed = true; };
  assert.equal(await defaultKillTree(34_001, { platform: "win32", timeoutMs: 10, spawnImpl: () => helper }), false);
  assert.equal(killed, true);
  helper.emit("close", 0);
});

test("registry snapshot exposes only bounded process identity metadata", async () => {
  const ledger = memoryLedger();
  const registry = configureChildRegistry({ dataRoot: "memory-snapshot", storage: ledger.storage });
  registry.register(12_345, "codex.exe");
  registry.register(23_456, "node.exe");
  const snapshot = registry.snapshot({ limit: 1 });
  assert.equal(snapshot.length, 1);
  assert.deepEqual(Object.keys(snapshot[0]), ["pid", "image", "startedAt"]);
  assert.equal(snapshot[0].pid, 23_456);
  assert.equal(snapshot[0].image, "node.exe");
  assert.ok(snapshot[0].startedAt);
});

const runRealProcessTest = process.env.CONTROL_CENTER_REAL_PROCESS_TEST === "1" && process.platform === "win32";
test("reapPrevious terminates one real registered process (opt-in)", {
  skip: runRealProcessTest ? false : "set CONTROL_CENTER_REAL_PROCESS_TEST=1 on Windows to run",
}, async (t) => {
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  await once(sleeper, "spawn");
  t.after(() => {
    if (sleeper.exitCode === null) sleeper.kill();
  });

  const live = await queryProcessIdentity(sleeper.pid);
  assert.ok(live?.image && live?.createdAt, "real-process probe must attest image and creation time");
  const ledger = memoryLedger([child(sleeper.pid, live.image, new Date(Date.now() + 60_000).toISOString())]);
  const registry = configureChildRegistry({ dataRoot: "memory-real-process", storage: ledger.storage });
  const result = await registry.reapPrevious();

  assert.equal(result.reaped, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(ledger.read().children, []);
});
