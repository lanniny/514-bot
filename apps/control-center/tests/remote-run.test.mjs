/**
 * remote-run 契约测试（v41 波二）：远端命令行组装 / fake child 协议忠实度与 pgid 杀 /
 * runner 准入门闸 / createRemoteAdapter 注入 / orchestrator 远程分支与处置。
 * 不连网：ssh service、openRunChannel、channel 全用假件（EventEmitter 模拟 ssh2 Channel）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRemoteCommandLine, createRemoteRunner } from "../src/ssh/remote-run.mjs";
import { createRemoteAdapter } from "../src/adapters/index.mjs";
import { Orchestrator } from "../src/orchestrator.mjs";

const tick = async (n = 2) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

function fakeChannel() {
  const channel = new EventEmitter();
  channel.stderr = new EventEmitter();
  channel.writes = [];
  channel.closed = false;
  channel.write = (chunk) => { channel.writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; };
  channel.end = (chunk) => { if (chunk != null) channel.write(chunk); channel.ended = true; };
  channel.close = () => { channel.closed = true; };
  return channel;
}

function fakeSsh({ channel = null, execImpl = null, hosts = null } = {}) {
  const execCalls = [];
  const openCalls = [];
  return {
    execCalls,
    openCalls,
    list: () => hosts ?? [{ id: "h1", name: "lanniny-45", host: "45.205.25.155", enabled: true }],
    async openRunChannel(id, commandLine) { openCalls.push({ id, commandLine }); return channel; },
    async exec(id, payload) { execCalls.push({ id, ...payload }); return execImpl ? execImpl(id, payload) : { code: 0, stdout: "ok", stderr: "" }; },
  };
}

test("buildRemoteCommandLine: setsid 包裹 + cd + 单引号转义 + 位置参数", () => {
  const line = buildRemoteCommandLine({ cwd: "/srv/my app", command: "kimi", args: ["--print", "it's"] });
  assert.match(line, /^cd '\/srv\/my app' && setsid sh -c /);
  assert.ok(line.includes(`printf "514CC_PGID=%s\\n" "$$"; exec "$@"`));
  assert.ok(line.includes(`514cc-remote 'kimi' '--print' 'it'\\''s'`)); // 单引号 '\'' 转义
});

test("remoteRunner.validateRemote/assertRunnable：形状校验 + 门闸/404/409/422/成功", async () => {
  const runner = createRemoteRunner({ getService: () => fakeSsh() });
  assert.throws(() => runner.validateRemote(null), { code: "INVALID_REMOTE" });
  assert.throws(() => runner.validateRemote({ path: "/srv" }), { code: "INVALID_REMOTE" });
  assert.throws(() => runner.validateRemote({ hostId: "h1", path: "relative" }), { code: "INVALID_REMOTE_PATH" });
  assert.deepEqual(runner.validateRemote({ hostId: " h1 ", path: "/srv/app" }), { hostId: "h1", path: "/srv/app" });

  const gateBlocked = createRemoteRunner({ getService: () => fakeSsh(), gates: { assert() { throw Object.assign(new Error("blocked"), { code: "REMOTE_GATE_BLOCKED" }); } } });
  await assert.rejects(() => gateBlocked.assertRunnable("h1", "/srv"), { code: "REMOTE_GATE_BLOCKED" });

  await assert.rejects(
    () => createRemoteRunner({ getService: () => null }).assertRunnable("h1", "/srv"),
    { code: "REMOTE_UNAVAILABLE" },
  );
  await assert.rejects(
    () => createRemoteRunner({ getService: () => fakeSsh({ hosts: [] }) }).assertRunnable("ghost", "/srv"),
    { code: "REMOTE_HOST_NOT_FOUND" },
  );
  await assert.rejects(
    () => createRemoteRunner({ getService: () => fakeSsh({ hosts: [{ id: "h1", host: "x", enabled: false }] }) }).assertRunnable("h1", "/srv"),
    { code: "REMOTE_HOST_DISABLED" },
  );
  await assert.rejects(
    () => createRemoteRunner({ getService: () => fakeSsh({ execImpl: async () => ({ code: 1, stdout: "", stderr: "" }) }) }).assertRunnable("h1", "/nope"),
    { code: "INVALID_REMOTE_PATH" },
  );
  const ssh = fakeSsh();
  const ok = await createRemoteRunner({ getService: () => ssh }).assertRunnable("h1", "/srv/app");
  assert.equal(ok.path, "/srv/app");
  assert.ok(ssh.execCalls.some((call) => call.command.includes("test -d '/srv/app'"))); // 远端探针仅此一次
  assert.equal(createRemoteRunner({ getService: () => ssh }).workspaceLabel("h1", "/srv/app"), "ssh://h1/srv/app");

  let gateOpen = true;
  const gatedSsh = fakeSsh({ channel: fakeChannel() });
  const gated = createRemoteRunner({
    getService: () => gatedSsh,
    gates: {
      assert() {
        if (!gateOpen) throw Object.assign(new Error("blocked"), { code: "REMOTE_GATE_BLOCKED" });
      },
    },
  });
  assert.doesNotThrow(() => gated.assertDispatchable("h1", "/srv/app"));
  const spawn = gated.spawnImpl("h1", "/srv/app");
  gateOpen = false;
  assert.throws(() => gated.assertDispatchable("h1", "/srv/app"), { code: "REMOTE_GATE_BLOCKED" });
  assert.throws(() => spawn("kimi", [], {}), { code: "REMOTE_GATE_BLOCKED" });
  assert.equal(gatedSsh.openCalls.length, 0, "gate revoke reached the SSH channel");
});

test("fake child：PGID 首行剥离、协议字节忠实、stdin 缓冲泄入、exit/close 同序、无 pid", async () => {
  const channel = fakeChannel();
  const ssh = fakeSsh({ channel });
  const child = createRemoteRunner({ getService: () => ssh }).spawnImpl("h1", "/srv/app")("kimi", ["--print"], { cwd: "C:\\local", env: { SECRET: "x" } });
  assert.equal(child.pid, undefined); // win32 taskkill 误杀守卫
  assert.equal(ssh.openCalls[0].id, "h1");
  assert.ok(ssh.openCalls[0].commandLine.includes("cd '/srv/app'"));
  const stdout = [];
  const order = [];
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.on("exit", (code) => order.push(`exit:${code}`));
  child.on("close", (code) => order.push(`close:${code}`));
  child.stdin.write("BUFFERED-");
  child.stdin.end("INPUT");
  await tick(); // 异步挂通道
  assert.ok(channel.ended); // stdin end 泄入为通道 EOF
  assert.ok(Buffer.concat(channel.writes).toString("utf8").includes("BUFFERED-INPUT"));
  channel.emit("data", Buffer.from("514CC_PGID=4321\n{\"type\":\"in"));
  channel.emit("data", Buffer.from("it\"}\n")); // 跨 chunk 边界也只在首行剥一次
  channel.emit("exit", 0, null);
  channel.emit("close");
  await tick();
  assert.deepEqual(stdout.join(""), '{"type":"init"}\n'); // 标记行绝不进协议流
  assert.deepEqual(order, ["exit:0", "close:0"]);
});

test("fake child kill：TERM=pgid pkill 不拆通道；二杀升级拆通道；pgid 未知=通道关闭兜底", async () => {
  const channel = fakeChannel();
  const ssh = fakeSsh({ channel });
  const child = createRemoteRunner({ getService: () => ssh }).spawnImpl("h1", "/srv")("kimi", [], {});
  await tick();
  channel.emit("data", Buffer.from("514CC_PGID=777\n"));
  child.kill("SIGTERM");
  await tick();
  assert.ok(ssh.execCalls.some((call) => call.command.includes("pkill -TERM -g 777 2>/dev/null")));
  assert.ok(ssh.execCalls.some((call) => call.command.includes("pgrep -g 777")));
  assert.ok(ssh.execCalls.every((call) => !call.command.includes("|| true")));
  assert.equal(channel.closed, false); // 首杀等远端自然死（保 stdout 尾）
  assert.equal(child.signalCode, "SIGTERM");
  child.kill("SIGKILL");
  await tick();
  assert.ok(ssh.execCalls.some((call) => call.command.includes("pkill -KILL -g 777 2>/dev/null")));
  assert.equal(channel.closed, true); // 升级拆通道（终止器等 close，不能永远等）

  // pgid 未到（启动即死/协议异常）：kill 直接通道关闭兜底
  const early = fakeChannel();
  const earlyChild = createRemoteRunner({ getService: () => fakeSsh({ channel: early }) }).spawnImpl("h1", "/srv")("kimi", [], {});
  await tick();
  earlyChild.kill("SIGTERM");
  assert.equal(early.closed, true);
});

test("fake child：无标记行的远端（协议直出）原样放行不吞字节", async () => {
  const channel = fakeChannel();
  const child = createRemoteRunner({ getService: () => fakeSsh({ channel }) }).spawnImpl("h1", "/srv")("raw-cli", [], {});
  const stdout = [];
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  await tick();
  channel.emit("data", Buffer.from("{\"type\":\"init\"}\nrest"));
  channel.emit("close");
  await tick();
  assert.equal(stdout.join(""), '{"type":"init"}\nrest');
});

test("runProcessImpl：复用 runProcess 契约——input 到 stdin、stdout 收集、code 回传、abort 走 pgid kill", async () => {
  const channel = fakeChannel();
  const ssh = fakeSsh({ channel });
  const runner = createRemoteRunner({ getService: () => ssh });
  const done = runner.runProcessImpl("h1", "/srv/app")("kimi", ["--print"], { input: "PROMPT", timeoutMs: 5_000 });
  await tick();
  channel.emit("data", Buffer.from("514CC_PGID=88\n{\"type\":\"init\"}\n"));
  channel.stderr.emit("data", "warn-line");
  channel.stderr.emit("end");
  channel.emit("exit", 0, null);
  channel.emit("close");
  const result = await done;
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('{"type":"init"}'));
  assert.ok(result.stderr.includes("warn-line"));
  assert.ok(Buffer.concat(channel.writes).toString("utf8").includes("PROMPT"));

  // abort → terminateChildProcessAndWait → kill(SIGTERM) → 远端 pkill pgid → close 收尾 ABORTED
  const killChannel = fakeChannel();
  const killSsh = fakeSsh({ channel: killChannel });
  const controller = new AbortController();
  const aborted = createRemoteRunner({ getService: () => killSsh })
    .runProcessImpl("h1", "/srv")("kimi", [], { signal: controller.signal, timeoutMs: 5_000 });
  await tick();
  killChannel.emit("data", Buffer.from("514CC_PGID=99\n"));
  controller.abort();
  await tick();
  killChannel.emit("exit", null, "SIGTERM");
  killChannel.emit("close");
  await assert.rejects(aborted, { code: "ABORTED" });
  assert.ok(killSsh.execCalls.some((call) => call.command.includes("pkill -TERM -g 99")));
});

test("remote termination waits for the pkill acknowledgement even if the SSH channel closes first", async () => {
  const channel = fakeChannel();
  let acknowledgeKill;
  const killAcknowledged = new Promise((resolve) => { acknowledgeKill = resolve; });
  const ssh = fakeSsh({
    channel,
    execImpl: async () => killAcknowledged,
  });
  const controller = new AbortController();
  const aborted = createRemoteRunner({ getService: () => ssh })
    .runProcessImpl("h1", "/srv")("kimi", [], {
      signal: controller.signal,
      timeoutMs: 5_000,
    });
  let settled = false;
  void aborted.catch(() => { settled = true; });
  await tick();
  channel.emit("data", Buffer.from("514CC_PGID=101\n"));
  controller.abort();
  await tick();
  channel.emit("exit", null, "SIGTERM");
  channel.emit("close");
  await tick();
  assert.equal(settled, false, "channel close alone must not prove the remote process group stopped");
  acknowledgeKill({ code: 0, stdout: "", stderr: "" });
  await assert.rejects(aborted, { code: "ABORTED" });
  assert.ok(ssh.execCalls.some((call) => call.command.includes("pkill -TERM -g 101")));
});

test("remote termination rejects a failed signal request while the process group still exists", async () => {
  const channel = fakeChannel();
  const ssh = fakeSsh({
    channel,
    execImpl: async () => ({ code: 1, stdout: "", stderr: "process group still exists" }),
  });
  const child = createRemoteRunner({ getService: () => ssh }).spawnImpl("h1", "/srv")("kimi", [], {});
  await tick();
  channel.emit("data", Buffer.from("514CC_PGID=102\n"));
  child.kill("SIGTERM");
  await assert.rejects(
    () => child.waitForTerminationRequest(),
    { code: "REMOTE_TERMINATION_FAILED" },
  );
  assert.ok(ssh.execCalls[0].command.includes("pgrep -g 102"));
  assert.ok(!ssh.execCalls[0].command.includes("|| true"));
});

const remoteInject = {
  spawnImpl: () => { throw new Error("spawn must not fire in unit test"); },
  runProcessImpl: () => { throw new Error("runProcess must not fire in unit test"); },
};
const noEmit = { emit: async () => {} };

test("createRemoteAdapter：工厂表同源注入——spawn 型 runProcessImpl / 常驻型 spawnImpl / claude 本地路径清零", async () => {
  const cwd = process.cwd();
  const kimi = createRemoteAdapter({
    profile: { id: "kimi-x", adapter: "kimi-headless-resume", builtin: false, command: "kimi" },
    eventStore: noEmit, cwd, approvalResolver: async () => ({}), remote: remoteInject,
  });
  assert.equal(kimi.adapter.id, "kimi-headless-resume");
  assert.equal(kimi.adapter.runProcessImpl, remoteInject.runProcessImpl);

  const claude = createRemoteAdapter({
    profile: { id: "claude-x", adapter: "claude-stream-json", builtin: false, command: "claude", systemPromptFile: "soul/CLAUDE.md" },
    eventStore: noEmit, cwd, approvalResolver: async () => ({}), remote: remoteInject,
  });
  assert.equal(claude.adapter.runProcessImpl, remoteInject.runProcessImpl);
  assert.equal(claude.adapter.settingsFile, null); // 本机路径绝不进远端命令行
  assert.equal(claude.adapter.systemPromptFile, null);

  const codex = createRemoteAdapter({
    profile: { id: "codex-x", adapter: "codex-app-server", builtin: false, command: "codex" },
    eventStore: noEmit, cwd, approvalResolver: async () => ({}), remote: remoteInject,
  });
  assert.equal(codex.adapter.spawnImpl, remoteInject.spawnImpl);
  assert.equal(codex.fallback?.runProcessImpl, remoteInject.runProcessImpl); // fallback 同样远程（绝不回本机）

  assert.throws(() => createRemoteAdapter({
    profile: { id: "grok-x", adapter: "grok-mcp-via-codex-app-server", builtin: false, command: "grok" },
    eventStore: noEmit, cwd, approvalResolver: async () => ({}), remote: remoteInject,
  }), (error) => ["REMOTE_ADAPTER_UNSUPPORTED", "ADAPTER_MANIFEST_INVALID"].includes(error.code)); // grok-mcp 远程如实拒绝
});

function fakeRunner(calls = [], dispatchCalls = []) {
  return {
    validateRemote: (input) => ({ hostId: String(input.hostId), path: String(input.path) }),
    assertRunnable: async (hostId, path) => { calls.push([hostId, path]); },
    assertDispatchable: (hostId, path) => { dispatchCalls.push([hostId, path]); },
    workspaceLabel: (hostId, path) => `ssh://${hostId}${path}`,
    spawnImpl: () => () => { throw new Error("not in this test"); },
    runProcessImpl: () => () => { throw new Error("not in this test"); },
  };
}

function orchestratorFixture(root, { remoteRunner = null, profiles = [] } = {}) {
  return new Orchestrator({
    router: { preview: async () => ({ taskType: "coding", risk: "medium", selected: { id: "kimi-x", label: "K" }, independent: null, reason: "t" }) },
    adapters: new Map(),
    eventStore: { emit: async () => {} },
    dataRoot: root,
    policy: { version: 1, modes: { plan: {}, review: {}, build: {} }, limits: { maxRounds: 3, maxBudgetUsdPerTurn: 2, turnTimeoutMs: 5_000 } },
    approvalBroker: { request: async () => ({}), denyRun() {} },
    capabilities: { agentDisabledSkills: async () => new Set() },
    models: { profiles },
    remoteRunner,
  });
}

test("orchestrator.create 远程分支：remote 持久化 / 与 cwd 互斥 / 无 runner 如实 503", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "514cc-remote-run-orch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const orchestrator = await orchestratorFixture(root, { remoteRunner: fakeRunner(calls) }).init();
  const run = await orchestrator.create({ prompt: "hello remote", remote: { hostId: "h1", path: "/srv/app" }, permissionMode: "plan" });
  assert.deepEqual(run.remote, { hostId: "h1", path: "/srv/app" });
  assert.equal(run.cwd, null);
  assert.deepEqual(calls, [["h1", "/srv/app"]]); // 建 run 时远端 test -d 探针仅此一次
  await assert.rejects(
    () => orchestrator.create({ prompt: "x", cwd: root, remote: { hostId: "h1", path: "/srv" }, permissionMode: "plan" }),
    { code: "VALIDATION_FAILED" }, // 两套 cwd 语义绝不混用
  );
  await orchestrator.close();

  const noRunner = await orchestratorFixture(root).init();
  await assert.rejects(
    () => noRunner.create({ prompt: "x", remote: { hostId: "h1", path: "/srv" }, permissionMode: "plan" }),
    { code: "REMOTE_UNAVAILABLE" },
  );
  await noRunner.close();

  const legacyRunner = fakeRunner();
  delete legacyRunner.assertDispatchable;
  const legacyOrchestrator = await orchestratorFixture(root, { remoteRunner: legacyRunner }).init();
  await assert.rejects(
    () => legacyOrchestrator.create({ prompt: "x", remote: { hostId: "h1", path: "/srv" }, permissionMode: "plan" }),
    { code: "REMOTE_UNAVAILABLE" },
  );
  await legacyOrchestrator.close();
});

test("orchestrator.remoteAdapterFor 缓存同一只 / dispose 调 close；审批消息远程口径", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "514cc-remote-run-pair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const orchestrator = orchestratorFixture(root, {
    remoteRunner: fakeRunner(),
    profiles: [{ id: "kimi-x", adapter: "kimi-headless-resume", builtin: false, command: "kimi" }],
  });
  const run = { id: "r1", remote: { hostId: "h1", path: "/srv/app" } };
  const pair = await orchestrator.remoteAdapterFor(run, "kimi-x");
  assert.equal(pair.adapter.id, "kimi-headless-resume");
  const again = await orchestrator.remoteAdapterFor(run, "kimi-x");
  assert.equal(again.adapter, pair.adapter); // 缓存 Promise 防并发双建（远端常驻进程不泄漏）
  let closed = 0;
  pair.adapter.close = async () => { closed += 1; };
  await orchestrator.disposeRemoteAdapters("r1");
  assert.equal(closed, 1);
  assert.equal(orchestrator.remoteAdapters.size, 0);

  const approvalRun = {
    id: "r2",
    remote: { hostId: "h1", path: "/srv/app" },
    cwd: null,
    route: { selected: { id: "kimi-x" } },
    sessions: {},
    coordinatorId: "kimi-x",
    startAgentId: "kimi-x",
    executionOwnerId: "kimi-x",
    teamRoster: null,
    prompt: "build it",
    permissionMode: "build",
  };
  const message = orchestrator.buildApprovalMessage(approvalRun);
  assert.equal(message.params.workspace, "ssh://h1/srv/app"); // 规范化串，绝不进本机 resolve()
  assert.equal(message.params.workspaceSource, "run.remote");
  assert.equal(message.params.isolation, "remote-unsupported");
});

test("orchestrator.remoteAdapterFor evicts a rejected constructor so the same run can recover", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "514cc-remote-run-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = {
    id: "remote-retry",
    adapter: "grok-mcp-via-codex-app-server",
    builtin: false,
    command: "grok",
  };
  const orchestrator = orchestratorFixture(root, {
    remoteRunner: fakeRunner(),
    profiles: [profile],
  });
  const run = { id: "r-retry", remote: { hostId: "h1", path: "/srv/app" } };
  await assert.rejects(
    () => orchestrator.remoteAdapterFor(run, profile.id),
    (error) => ["REMOTE_ADAPTER_UNSUPPORTED", "ADAPTER_MANIFEST_INVALID"].includes(error.code),
  );
  assert.equal(orchestrator.remoteAdapters.size, 0);

  profile.adapter = "kimi-headless-resume";
  profile.command = "kimi";
  const recovered = await orchestrator.remoteAdapterFor(run, profile.id);
  assert.equal(recovered.adapter.id, "kimi-headless-resume");
  assert.equal(orchestrator.remoteAdapters.size, 1);
  await orchestrator.disposeRemoteAdapters(run.id);
});

test("orchestrator rechecks remote authorization at every provider dispatch boundary", async () => {
  const dispatchCalls = [];
  const orchestrator = orchestratorFixture("C:/bounded", { remoteRunner: fakeRunner([], dispatchCalls) });
  const run = { id: "r-dispatch", remote: { hostId: "h1", path: "/srv/app" } };
  orchestrator.assertRemoteDispatchable(run);
  assert.deepEqual(dispatchCalls, [["h1", "/srv/app"]]);

  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/orchestrator.mjs", import.meta.url), "utf8"));
  const turn = source.slice(source.indexOf("async turn("), source.indexOf("async execute("));
  assert.match(turn, /this\.assertRemoteDispatchable\(run\);\s*response = await adapter\.send/);
  assert.match(turn, /this\.assertRemoteDispatchable\(run\);\s*const compacted = await adapter\.compactThread/);
  const fallbackOwner = turn.indexOf("this.assertLifecycleOwner(run, controller);", turn.indexOf('"adapter.fallback"'));
  const fallbackGate = turn.indexOf("this.assertRemoteDispatchable(run);", fallbackOwner);
  const fallbackSend = turn.indexOf("response = await fallback.send(sendInput);", fallbackGate);
  assert.ok(fallbackOwner >= 0 && fallbackOwner < fallbackGate && fallbackGate < fallbackSend);
});
