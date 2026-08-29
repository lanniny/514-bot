import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { attachLfJsonl, encodeJsonLine } from "../src/jsonl.mjs";
import {
  createScrubbedLineCollector,
  DEFAULT_MAX_TURN_OUTPUT_BYTES,
  measureUtf8Append,
  publicClaudeEvent,
  publicCodexEvent,
} from "../src/adapters/stream-utils.mjs";
import { buildIsolatedMcpArgs, CodexAppServerAdapter } from "../src/adapters/codex-app-server.mjs";
import { buildClaudeArgs } from "../src/adapters/claude-cli.mjs";
import { GrokMcpAdapter } from "../src/adapters/grok-mcp.mjs";
import { PiRpcAdapter, piProviderEnvPolicy } from "../src/adapters/pi-rpc.mjs";
import { createAdapters } from "../src/adapters/index.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("adapter normalizers keep public output and omit thinking", () => {
  assert.equal(publicClaudeEvent({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hidden" }] } }), null);
  assert.deepEqual(publicClaudeEvent({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }), { type: "assistant.message", text: "done", tools: [] });
  assert.deepEqual(publicCodexEvent({ type: "thread.started", thread_id: "t1" }), { type: "session.started", sessionId: "t1" });
});

test("incremental UTF-8 accounting joins surrogate pairs split across deltas", () => {
  const high = measureUtf8Append(0, false, "\ud83d");
  assert.deepEqual(high, { bytes: 3, endsWithHighSurrogate: true });
  const pair = measureUtf8Append(high.bytes, high.endsWithHighSurrogate, "\ude00");
  assert.deepEqual(pair, { bytes: 4, endsWithHighSurrogate: false });
});

test("provider turn-output policy defaults to 8 MiB and rejects invalid limits", () => {
  const options = { cwd: "C:/repo", eventStore: { emit: async () => {} } };
  assert.equal(DEFAULT_MAX_TURN_OUTPUT_BYTES, 8 * 1024 * 1024);
  assert.equal(new PiRpcAdapter(options).maxTurnOutputBytes, DEFAULT_MAX_TURN_OUTPUT_BYTES);
  assert.equal(new CodexAppServerAdapter(options).maxTurnOutputBytes, DEFAULT_MAX_TURN_OUTPUT_BYTES);
  assert.throws(() => new PiRpcAdapter({ ...options, maxTurnOutputBytes: 0 }), { code: "INVALID_OUTPUT_POLICY" });
  assert.throws(() => new CodexAppServerAdapter({ ...options, outputLimitSettleMs: 0 }), { code: "INVALID_OUTPUT_POLICY" });
  assert.throws(() => new CodexAppServerAdapter({ ...options, eventPersistenceTimeoutMs: 0 }), { code: "INVALID_EVENT_POLICY" });
  assert.throws(() => new CodexAppServerAdapter({ ...options, lifecycleTimeoutMs: 0 }), { code: "INVALID_EVENT_POLICY" });
});

test("tool and stream payloads scrub before clipping", () => {
  const secret = "split-sensitive-value";
  const padding = "x".repeat(580);
  const claude = publicClaudeEvent({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: `result OPENAI_API_KEY=${secret}` },
        { type: "tool_use", id: "tool-1", name: "Shell", input: `${padding} OPENAI_API_KEY=${secret}` },
      ],
    },
  });
  assert.ok(!claude.text.includes(secret));
  assert.ok(!claude.tools[0].input.includes(secret));
  assert.match(claude.tools[0].input, /\[REDACTED\]/);
  assert.doesNotMatch(claude.tools[0].input, /截断 0 字符/);

  const result = publicClaudeEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: `client_secret='${secret}'` }] },
  });
  assert.ok(!result.results[0].text.includes(secret));

  const codex = publicCodexEvent({
    type: "item.completed",
    item: { type: "command_execution", status: "completed", command: `${padding} --refresh_token=${secret}` },
  });
  assert.ok(!codex.command.includes(secret));
  assert.match(codex.command, /\[REDACTED\]/);
});

test("scrubbed line collector does not leak credentials split across chunks", () => {
  const output = [];
  const collector = createScrubbedLineCollector((chunk) => output.push(chunk));
  collector.push(Buffer.from("warning OPENAI_API_"));
  assert.deepEqual(output, [], "an incomplete logical line is not persisted");
  collector.push(Buffer.from("KEY=chunked-"));
  collector.push(Buffer.from("secret\r\nnext client_"));
  collector.push(Buffer.from("secret='second-value'"));
  collector.end();
  const safe = output.join("");
  assert.ok(!safe.includes("chunked-secret"), safe);
  assert.ok(!safe.includes("second-value"), safe);
  assert.equal((safe.match(/\[REDACTED\]/g) || []).length, 2);
  assert.match(safe, /^warning OPENAI_API_KEY=\[REDACTED\]\r\nnext client_secret='\[REDACTED\]'$/);
});

test("scrubbed line collector bounds and drops an oversized logical line", () => {
  const output = [];
  const collector = createScrubbedLineCollector((chunk) => output.push(chunk), { maxLineChars: 32 });
  collector.push(`OPENAI_API_KEY=${"z".repeat(200)}\nvisible next line\n`);
  collector.end();
  const safe = output.join("");
  assert.doesNotMatch(safe, /z/);
  assert.match(safe, /\[REDACTED\]/);
  assert.match(safe, /line truncated/);
  assert.match(safe, /visible next line/);
});

test("scrubbed line collector suppresses a multi-line PEM private key", () => {
  const output = [];
  const collector = createScrubbedLineCollector((chunk) => output.push(chunk));
  collector.push("before\n-----BEGIN PRIVATE KEY-----\nYWJjZGVm"); // gitleaks:allow 测试夹具：PEM 边界用于验证多行密钥被吞掉
  collector.push("Z2hpamtsbW5vcA==\n-----END PRIVATE KEY-----\nafter\n");
  collector.end();
  const safe = output.join("");
  assert.match(safe, /^before\n\[REDACTED\]\nafter\n$/);
  assert.doesNotMatch(safe, /YWJj|BEGIN PRIVATE KEY|END PRIVATE KEY/);
});

test("scrubbed line collector fail-closes split encrypted and DSA PEM blocks", () => {
  for (const label of ["ENCRYPTED PRIVATE KEY", "DSA PRIVATE KEY"]) {
    const output = [];
    const collector = createScrubbedLineCollector((chunk) => output.push(chunk));
    collector.push(`before\n-----BEGIN ${label.slice(0, 8)}`);
    collector.push(`${label.slice(8)}-----\nsecret-`);
    collector.push("body\n");
    if (label === "DSA PRIVATE KEY") collector.push(`-----END ${label}-----\nafter\n`);
    collector.end();
    const safe = output.join("");
    assert.match(safe, /^before\n\[REDACTED\]\n/);
    assert.doesNotMatch(safe, /secret-body|BEGIN|END/);
    if (label === "DSA PRIVATE KEY") assert.match(safe, /after\n$/);
  }
});

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    attachLfJsonl(this.stdin, (message) => this.handle(message));
  }

  reply(id, result) {
    queueMicrotask(() => this.stdout.write(encodeJsonLine({ id, result })));
  }

  handle(message) {
    this.messages.push(message);
    if (message.method === "initialize") return this.reply(message.id, { codexHome: "C:/mock", platformFamily: "windows", platformOs: "windows", userAgent: "mock" });
    if (message.method === "thread/start") return this.reply(message.id, { thread: { id: "thread-1" } });
    if (message.method === "turn/start") {
      this.reply(message.id, { turn: { id: "turn-1", status: "inProgress", items: [] } });
      setTimeout(() => {
        this.stdout.write(encodeJsonLine({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "verified" } }));
        this.stdout.write(encodeJsonLine({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } }));
      }, 5);
    }
  }

  kill() {
    this.emit("exit", 0);
    this.emit("close", 0);
  }
}

test("Pi RPC defaults to credential-free CLI auth and handles rejected diagnostic persistence", async () => {
  class PiChild extends EventEmitter {
    constructor() {
      super();
      this.stdin = new PassThrough();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.exitCode = null;
      this.signalCode = null;
    }

    kill() {
      if (this.exitCode != null) return;
      this.exitCode = 0;
      this.emit("exit", 0);
      this.emit("close", 0);
    }
  }

  const child = new PiChild();
  const attempts = [];
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  let spawnOptions = null;
  const adapter = new PiRpcAdapter({
    cwd: "C:/repo",
    environmentBase: {
      PATH: "C:/runtime/bin",
      SYSTEMROOT: "C:/Windows",
      PI_API_KEY: "pi-secret",
      INFLECTION_API_KEY: "inflection-secret",
      INFLECTION_BASE_URL: "https://inflection.test/v1",
      OPENAI_API_KEY: "foreign-secret",
    },
    spawnImpl: (command, args, options) => {
      spawnOptions = options;
      return child;
    },
    eventStore: {
      emit: async (type) => {
        attempts.push(type);
        throw new Error("event store unavailable");
      },
    },
  });

  try {
    const sessionId = await adapter.createSession("run-pi");
    assert.ok(sessionId);
    assert.equal(Object.hasOwn(spawnOptions.env, "PI_API_KEY"), false);
    assert.equal(Object.hasOwn(spawnOptions.env, "INFLECTION_API_KEY"), false);
    assert.equal(Object.hasOwn(spawnOptions.env, "INFLECTION_BASE_URL"), false);
    assert.equal(Object.hasOwn(spawnOptions.env, "OPENAI_API_KEY"), false);

    child.stdout.write("not-json\n");
    child.stdout.write(encodeJsonLine({ type: "tool_execution_start", toolName: "read" }));
    child.stderr.end("diagnostic\n");
    await new Promise((resolve) => setImmediate(resolve));
    await adapter.close();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(attempts.includes("adapter.parse_error"));
    assert.ok(attempts.includes("tool.event"));
    assert.ok(attempts.includes("adapter.stderr"));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await adapter.close();
  }
});

test("Pi RPC exposes only the selected model provider credentials and rejects unknown explicit providers", async () => {
  class PolicyChild extends EventEmitter {
    constructor() {
      super();
      this.stdin = new PassThrough();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.exitCode = null;
      this.signalCode = null;
    }
    kill() {
      if (this.exitCode != null) return;
      this.exitCode = 0;
      this.emit("exit", 0);
      this.emit("close", 0);
    }
  }

  const environmentBase = {
    PATH: "C:/runtime/bin",
    SYSTEMROOT: "C:/Windows",
    OPENAI_API_KEY: "openai-secret",
    OPENAI_BASE_URL: "https://openai.test/v1",
    ANTHROPIC_API_KEY: "anthropic-secret",
    ANTHROPIC_BASE_URL: "https://anthropic.test",
    GEMINI_API_KEY: "gemini-secret",
    XAI_API_KEY: "xai-secret",
    PI_API_KEY: "legacy-pi-secret",
  };
  const cases = [
    { model: null, keep: ["GEMINI_API_KEY"] },
    { model: "openai/gpt-5.6-sol", keep: ["OPENAI_API_KEY", "OPENAI_BASE_URL"] },
    { model: "anthropic/claude-fable-5", keep: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] },
    { model: "google/gemini-3.1-pro", keep: ["GEMINI_API_KEY"] },
  ];
  for (const entry of cases) {
    let spawnOptions;
    const adapter = new PiRpcAdapter({
      cwd: "C:/repo",
      model: entry.model,
      environmentBase,
      spawnImpl: (_command, _args, options) => { spawnOptions = options; return new PolicyChild(); },
      eventStore: { emit: async () => {} },
    });
    await adapter.createSession(`run-${entry.model?.split("/", 1)[0] || "default"}`);
    for (const key of entry.keep) assert.equal(Object.hasOwn(spawnOptions.env, key), true, `${entry.model} keeps ${key}`);
    for (const foreign of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "PI_API_KEY"].filter((key) => !entry.keep.includes(key))) {
      assert.equal(Object.hasOwn(spawnOptions.env, foreign), false, `${entry.model} excludes ${foreign}`);
    }
    await adapter.close();
  }

  assert.deepEqual(piProviderEnvPolicy("openai-codex/gpt-5.5"), {
    modelProvider: "openai-codex", provider: "pi", providerKeys: [],
  });
  assert.deepEqual(piProviderEnvPolicy(null), {
    modelProvider: null, provider: "gemini", providerKeys: ["GEMINI_API_KEY"],
  });
  assert.throws(() => piProviderEnvPolicy("custom-provider/model-a"), {
    code: "PI_MODEL_PROVIDER_UNSUPPORTED",
    modelProvider: "custom-provider",
  });
});

test("Pi RPC attributes session and active events to the logical member id", async () => {
  class LogicalMemberPiChild extends EventEmitter {
    constructor() {
      super();
      this.stdin = new PassThrough();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.exitCode = null;
      this.signalCode = null;
      attachLfJsonl(this.stdin, (message) => this.handle(message));
    }

    handle(message) {
      if (message.type !== "prompt") return;
      this.stdout.write(encodeJsonLine({ type: "response", id: message.id, success: true }));
      setImmediate(() => {
        this.stderr.write("logical session diagnostic\n");
        this.stdout.write(encodeJsonLine({ type: "tool_execution_start", toolName: "read" }));
        this.stdout.write(encodeJsonLine({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "logical result" },
        }));
        this.stdout.write(encodeJsonLine({ type: "agent_end" }));
      });
    }

    kill() {
      if (this.exitCode != null) return;
      this.exitCode = 0;
      this.emit("exit", 0);
      this.emit("close", 0);
    }
  }

  const logicalMemberId = "pi-builder-seat";
  const runId = "run-pi-logical";
  const child = new LogicalMemberPiChild();
  const events = [];
  const adapter = new PiRpcAdapter({
    cwd: "C:/repo",
    spawnImpl: () => child,
    eventStore: { emit: async (type, data, context) => events.push({ type, data, context }) },
  });

  const result = await adapter.send({
    prompt: "inspect logical ownership",
    runId,
    agentId: logicalMemberId,
  });
  assert.equal(adapter.id, "pi-rpc");
  assert.equal(result.text, "logical result");
  assert.equal(adapter.processes.get(result.sessionId)?.agentId, logicalMemberId);

  const attributed = events.filter((event) => ["adapter.stderr", "tool.event", "assistant.message"].includes(event.type));
  assert.deepEqual(attributed.map((event) => event.type).sort(), ["adapter.stderr", "assistant.message", "tool.event"].sort());
  for (const event of attributed) {
    assert.deepEqual(
      {
        runId: event.context.runId,
        sessionId: event.context.sessionId,
        agentId: event.context.agentId,
      },
      { runId, sessionId: result.sessionId, agentId: logicalMemberId },
    );
  }
  await adapter.close();
});

test("Pi RPC bounds cumulative UTF-8 output, aborts once and waits for agent_end", async () => {
  class OutputLimitedPiChild extends EventEmitter {
    constructor() {
      super();
      this.stdin = new PassThrough();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.exitCode = null;
      this.signalCode = null;
      this.abortCount = 0;
      this.abortObserved = deferred();
      this.burstSent = deferred();
      attachLfJsonl(this.stdin, (message) => this.handle(message));
    }

    handle(message) {
      if (message.type === "prompt") {
        this.stdout.write(encodeJsonLine({ type: "response", id: message.id, success: true }));
        setImmediate(() => {
          for (const delta of ["你", "你", "你"]) {
            this.stdout.write(encodeJsonLine({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta },
            }));
          }
          this.burstSent.resolve();
        });
      } else if (message.type === "abort") {
        this.abortCount += 1;
        this.abortObserved.resolve();
      }
    }

    kill() {
      if (this.exitCode != null) return;
      this.exitCode = 0;
      this.emit("exit", 0);
      this.emit("close", 0);
    }
  }

  const child = new OutputLimitedPiChild();
  const events = [];
  const adapter = new PiRpcAdapter({
    cwd: "C:/repo",
    spawnImpl: () => child,
    maxTurnOutputBytes: 5,
    outputLimitSettleMs: 250,
    eventStore: { emit: async (type, data) => { events.push({ type, data }); } },
  });
  assert.equal(adapter.maxTurnOutputBytes, 5);
  const sendPromise = adapter.send({ prompt: "bounded", runId: "run-pi-limit" });
  let settled = false;
  void sendPromise.then(() => { settled = true; }, () => { settled = true; });
  await child.abortObserved.promise;
  await child.burstSent.promise;

  child.stdout.write(encodeJsonLine({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "ignored" },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.abortCount, 1);
  assert.equal(settled, false, "the output-limit rejection waits for Pi's terminal boundary");

  child.stdout.write(encodeJsonLine({ type: "agent_end" }));
  await assert.rejects(
    sendPromise,
    (error) => error.code === "OUTPUT_LIMIT" && error.maxOutputBytes === 5,
  );
  assert.equal(events.some((event) => event.type === "assistant.message"), false);
  await adapter.close();
});

test("Pi pre-ACK output-limit escalation preserves the cause and waits for process close", async () => {
  class StuckPiChild extends EventEmitter {
    constructor() {
      super();
      this.stdin = new PassThrough();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.exitCode = null;
      this.signalCode = null;
      this.abortCount = 0;
      this.killCount = 0;
      this.abortObserved = deferred();
      this.exitObserved = deferred();
      attachLfJsonl(this.stdin, (message) => this.handle(message));
    }

    handle(message) {
      if (message.type === "prompt") {
        for (const delta of ["你", "你"]) {
          this.stdout.write(encodeJsonLine({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta },
          }));
        }
      } else if (message.type === "abort") {
        this.abortCount += 1;
        this.abortObserved.resolve();
      }
    }

    kill() {
      if (this.exitCode != null) return;
      this.killCount += 1;
      setTimeout(() => {
        this.exitCode = 0;
        this.emit("exit", 0);
        this.exitObserved.resolve();
        setTimeout(() => this.emit("close", 0), 20);
      }, 5);
    }
  }

  const child = new StuckPiChild();
  const adapter = new PiRpcAdapter({
    cwd: "C:/repo",
    spawnImpl: () => child,
    maxTurnOutputBytes: 5,
    outputLimitSettleMs: 5,
    eventStore: { emit: async () => {} },
  });
  const sendPromise = adapter.send({ prompt: "stuck", runId: "run-pi-stuck" });
  let settled = false;
  void sendPromise.then(() => { settled = true; }, () => { settled = true; });
  await child.abortObserved.promise;
  await child.exitObserved.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.abortCount, 1);
  assert.equal(child.killCount, 1);
  assert.equal(settled, false, "Pi process exit is not enough; rejection waits for stdio close");
  await assert.rejects(sendPromise, { code: "OUTPUT_LIMIT" });
  await adapter.close();
});

test("Pi pre-ACK output limit cancels the pending prompt request after early agent_end", async () => {
  class EarlyTerminalPiChild extends EventEmitter {
    constructor() {
      super();
      this.stdin = new PassThrough();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.exitCode = null;
      this.signalCode = null;
      this.abortCount = 0;
      this.killCount = 0;
      attachLfJsonl(this.stdin, (message) => this.handle(message));
    }

    handle(message) {
      if (message.type === "prompt") {
        for (const delta of ["你", "你"]) {
          this.stdout.write(encodeJsonLine({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta },
          }));
        }
      } else if (message.type === "abort") {
        this.abortCount += 1;
        setImmediate(() => this.stdout.write(encodeJsonLine({ type: "agent_end" })));
      }
    }

    kill() {
      if (this.exitCode != null) return;
      this.killCount += 1;
      this.exitCode = 0;
      this.emit("exit", 0);
      this.emit("close", 0);
    }
  }

  const child = new EarlyTerminalPiChild();
  const adapter = new PiRpcAdapter({
    cwd: "C:/repo",
    spawnImpl: () => child,
    maxTurnOutputBytes: 5,
    outputLimitSettleMs: 250,
    eventStore: { emit: async () => {} },
  });
  await assert.rejects(
    () => Promise.race([
      adapter.send({ prompt: "early terminal", runId: "run-pi-early-terminal" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("send stayed pending")), 100)),
    ]),
    { code: "OUTPUT_LIMIT" },
  );
  const state = [...adapter.processes.values()][0];
  assert.equal(child.abortCount, 1);
  assert.equal(child.killCount, 0, "agent_end avoids process termination escalation");
  assert.equal(state.pending.size, 0, "the prompt ACK timer and pending entry are cancelled");
  await adapter.close();
});

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

class ManualScheduler {
  constructor() {
    this.nextId = 1;
    this.tasks = new Map();
  }

  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.tasks.set(id, { callback, delay });
    return id;
  }

  clearTimeout(id) {
    this.tasks.delete(id);
  }

  runAll() {
    const tasks = [...this.tasks.values()];
    this.tasks.clear();
    for (const task of tasks) task.callback();
  }

  get pending() {
    return this.tasks.size;
  }
}

class BurstChild extends FakeChild {
  constructor(parts) {
    super();
    this.parts = parts;
    this.burstReady = deferred();
    this.threadId = null;
    this.turnId = null;
  }

  handle(message) {
    if (message.method !== "turn/start") return super.handle(message);
    this.threadId = message.params.threadId;
    this.turnId = `turn-${this.threadId}`;
    this.reply(message.id, { turn: { id: this.turnId, status: "inProgress", items: [] } });
    setImmediate(() => {
      for (const delta of this.parts) {
        this.stdout.write(encodeJsonLine({
          method: "item/agentMessage/delta",
          params: { threadId: this.threadId, turnId: this.turnId, delta },
        }));
      }
      this.burstReady.resolve();
    });
  }

  complete(errorMessage = null) {
    const turn = { id: this.turnId, status: errorMessage ? "failed" : "completed", items: [] };
    if (errorMessage) turn.error = { message: errorMessage };
    this.stdout.write(encodeJsonLine({
      method: "turn/completed",
      params: { threadId: this.threadId, turn },
    }));
  }

  failTransport(code = 17) {
    this.emit("exit", code);
    this.emit("close", code);
  }
}

test("Codex delta coalescer batches 100 chunks and persists them before terminal", async () => {
  const parts = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, "0")}|`);
  const expected = parts.join("");
  const scheduler = new ManualScheduler();
  const deltaStarted = deferred();
  const releasePersistence = deferred();
  const events = [];
  const child = new BurstChild(parts);
  const adapter = new CodexAppServerAdapter({
    cwd: "C:/repo",
    spawnImpl: () => child,
    deltaScheduler: scheduler,
    deltaFlushMs: 40,
    deltaFlushChars: 4096,
    eventStore: {
      async emit(type, data, context) {
        if (type === "codex.item/agentMessage/delta") {
          deltaStarted.resolve();
          await releasePersistence.promise;
        }
        events.push({ type, data, context });
      },
    },
  });

  const sendPromise = adapter.send({ prompt: "burst", runId: "run-burst", permissionMode: "read-only" });
  await child.burstReady.promise;
  assert.equal(scheduler.pending, 1, "one time-based flush is scheduled for the whole burst");
  scheduler.runAll();
  await deltaStarted.promise;
  child.complete();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some((event) => event.type === "codex.turn/completed"), false, "terminal persistence waits behind the delta barrier");

  releasePersistence.resolve();
  const result = await sendPromise;
  const persistedDeltas = events.filter((event) => event.type === "codex.item/agentMessage/delta");
  assert.ok(persistedDeltas.length < 10, `100 chunks produced only ${persistedDeltas.length} persisted batches`);
  assert.equal(persistedDeltas.map((event) => event.data.delta).join(""), expected);
  assert.equal(result.text, expected);
  assert.ok(events.findIndex((event) => event.type === "codex.turn/completed") > events.findIndex((event) => event.type === "codex.item/agentMessage/delta"));
  assert.equal(scheduler.pending, 0);
  await adapter.close();
});

test("Codex bounds cumulative UTF-8 output, interrupts once and waits for acknowledgement", async () => {
  class OutputLimitedCodexChild extends BurstChild {
    constructor() {
      super(["你", "你", "你"]);
      this.interruptCount = 0;
      this.interruptRequest = null;
      this.interruptObserved = deferred();
    }

    handle(message) {
      if (message.method === "turn/interrupt") {
        this.interruptCount += 1;
        this.interruptRequest = message;
        this.interruptObserved.resolve();
        return;
      }
      return super.handle(message);
    }

    acknowledgeInterrupt() {
      this.reply(this.interruptRequest.id, {});
    }
  }

  const child = new OutputLimitedCodexChild();
  const events = [];
  const adapter = new CodexAppServerAdapter({
    cwd: "C:/repo",
    spawnImpl: () => child,
    maxTurnOutputBytes: 5,
    outputLimitSettleMs: 250,
    eventStore: { emit: async (type, data) => { events.push({ type, data }); } },
  });
  assert.equal(adapter.maxTurnOutputBytes, 5);
  const sendPromise = adapter.send({ prompt: "bounded", runId: "run-codex-limit" });
  let settled = false;
  void sendPromise.then(() => { settled = true; }, () => { settled = true; });
  await child.interruptObserved.promise;
  await child.burstReady.promise;

  const active = adapter.activeByThread.get(child.threadId);
  assert.equal(active.text, "你");
  assert.equal(active.outputBytes, 3, "the second one-character delta exceeds a five-byte UTF-8 budget");
  child.stdout.write(encodeJsonLine({
    method: "item/agentMessage/delta",
    params: { threadId: child.threadId, turnId: child.turnId, delta: "ignored" },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.interruptCount, 1);
  assert.equal(settled, false, "the output-limit rejection waits for the interrupt boundary");

  child.acknowledgeInterrupt();
  await assert.rejects(
    sendPromise,
    (error) => error.code === "OUTPUT_LIMIT" && error.maxOutputBytes === 5,
  );
  assert.equal(events.filter((event) => event.type === "codex.item/agentMessage/delta")
    .map((event) => event.data.delta).join(""), "你");
  await adapter.close();
});

test("Codex output limit settles after an unacknowledged interrupt timeout", async () => {
  class UnacknowledgedInterruptChild extends BurstChild {
    constructor() {
      super(["你", "你", "你"]);
      this.interruptCount = 0;
      this.interruptObserved = deferred();
    }

    handle(message) {
      if (message.method === "turn/interrupt") {
        this.interruptCount += 1;
        this.interruptObserved.resolve();
        return;
      }
      return super.handle(message);
    }
  }

  const child = new UnacknowledgedInterruptChild();
  const adapter = new CodexAppServerAdapter({
    cwd: "C:/repo",
    spawnImpl: () => child,
    maxTurnOutputBytes: 5,
    outputLimitSettleMs: 20,
    eventStore: { emit: async () => {} },
  });
  const sendPromise = adapter.send({ prompt: "timeout", runId: "run-codex-limit-timeout" });
  let settled = false;
  void sendPromise.then(() => { settled = true; }, () => { settled = true; });
  await child.interruptObserved.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.interruptCount, 1);
  assert.equal(settled, false, "Codex rejection waits for the interrupt timeout boundary");
  await assert.rejects(sendPromise, { code: "OUTPUT_LIMIT" });
  assert.equal(adapter.pending.size, 0);
  await adapter.close();
});

test("Codex pre-ACK output overflow wins over a later acceptance callback failure", async () => {
  class PreAckOutputChild extends FakeChild {
    constructor() {
      super();
      this.interruptCount = 0;
    }

    handle(message) {
      if (message.method === "turn/interrupt") {
        this.interruptCount += 1;
        return this.reply(message.id, {});
      }
      if (message.method !== "turn/start") return super.handle(message);
      const threadId = message.params.threadId;
      for (const delta of ["你", "你", "你"]) {
        this.stdout.write(encodeJsonLine({
          method: "item/agentMessage/delta",
          params: { threadId, turnId: "pre-ack-limit", delta },
        }));
      }
      this.reply(message.id, { turn: { id: "pre-ack-limit", status: "inProgress", items: [] } });
    }
  }

  const child = new PreAckOutputChild();
  const adapter = new CodexAppServerAdapter({
    cwd: "C:/repo",
    spawnImpl: () => child,
    maxTurnOutputBytes: 5,
    outputLimitSettleMs: 250,
    eventStore: { emit: async () => {} },
  });
  let acceptanceCallbackCalled = false;
  await assert.rejects(
    () => adapter.send({
      prompt: "pre-ack overflow",
      runId: "run-codex-pre-ack-limit",
      onTurnAccepted: async () => {
        acceptanceCallbackCalled = true;
        throw Object.assign(new Error("checkpoint failed"), { code: "CHECKPOINT_FAILED" });
      },
    }),
    { code: "OUTPUT_LIMIT" },
  );
  assert.equal(acceptanceCallbackCalled, false, "an already-failed turn is never checkpointed as accepted");
  assert.equal(child.interruptCount, 1);
  await adapter.close();
});

test("Codex output-limit finalization bounds a never-settling EventStore", async () => {
  class HangingPersistenceChild extends BurstChild {
    constructor() {
      super(["你", "你", "你"]);
      this.interruptCount = 0;
    }

    handle(message) {
      if (message.method === "turn/interrupt") {
        this.interruptCount += 1;
        return this.reply(message.id, {});
      }
      return super.handle(message);
    }
  }

  const child = new HangingPersistenceChild();
  const adapter = new CodexAppServerAdapter({
    cwd: "C:/repo",
    spawnImpl: () => child,
    maxTurnOutputBytes: 5,
    outputLimitSettleMs: 250,
    eventPersistenceTimeoutMs: 20,
    eventStore: {
      emit: async (type) => type === "prompt.transport" ? undefined : new Promise(() => {}),
    },
  });
  await assert.rejects(
    () => adapter.send({ prompt: "hanging persistence", runId: "run-codex-persistence-timeout" }),
    { code: "OUTPUT_LIMIT" },
  );
  assert.equal(child.interruptCount, 1);
  assert.equal(adapter.pending.size, 0);
  assert.equal(adapter.activeByThread.size, 0);
  await adapter.close();
});

test("Codex delta coalescer keeps concurrent thread buffers isolated", async () => {
  class ConcurrentChild extends FakeChild {
    constructor() {
      super();
      this.started = new Map();
      this.ready = deferred();
    }

    handle(message) {
      if (message.method === "thread/resume") return this.reply(message.id, { thread: { id: message.params.threadId } });
      if (message.method !== "turn/start") return super.handle(message);
      const threadId = message.params.threadId;
      const turnId = `turn-${threadId}`;
      this.started.set(threadId, turnId);
      this.reply(message.id, { turn: { id: turnId, status: "inProgress", items: [] } });
      if (this.started.size === 2) setImmediate(() => this.ready.resolve());
    }

    delta(threadId, delta) {
      this.stdout.write(encodeJsonLine({
        method: "item/agentMessage/delta",
        params: { threadId, turnId: this.started.get(threadId), delta },
      }));
    }

    complete(threadId) {
      this.stdout.write(encodeJsonLine({
        method: "turn/completed",
        params: { threadId, turn: { id: this.started.get(threadId), status: "completed", items: [] } },
      }));
    }
  }

  const events = [];
  const child = new ConcurrentChild();
  const scheduler = new ManualScheduler();
  const adapter = new CodexAppServerAdapter({
    cwd: "C:/repo",
    spawnImpl: () => child,
    deltaScheduler: scheduler,
    eventStore: { emit: async (type, data, context) => { events.push({ type, data, context }); } },
  });
  const sendA = adapter.send({ sessionId: "thread-a", prompt: "A", runId: "run-a" });
  const sendB = adapter.send({ sessionId: "thread-b", prompt: "B", runId: "run-b" });
  await child.ready.promise;
  for (let index = 0; index < 50; index += 1) {
    child.delta("thread-a", "A");
    child.delta("thread-b", "B");
  }
  child.complete("thread-a");
  child.complete("thread-b");
  const [resultA, resultB] = await Promise.all([sendA, sendB]);
  assert.equal(resultA.text, "A".repeat(50));
  assert.equal(resultB.text, "B".repeat(50));
  const deltasA = events.filter((event) => event.type === "codex.item/agentMessage/delta" && event.context.sessionId === "thread-a");
  const deltasB = events.filter((event) => event.type === "codex.item/agentMessage/delta" && event.context.sessionId === "thread-b");
  assert.equal(deltasA.map((event) => event.data.delta).join(""), "A".repeat(50));
  assert.equal(deltasB.map((event) => event.data.delta).join(""), "B".repeat(50));
  assert.ok(deltasA.length < 10 && deltasB.length < 10);
  assert.equal(scheduler.pending, 0);
  await adapter.close();
});

test("Codex close flushes pending delta once and cancels its timer", async () => {
  const scheduler = new ManualScheduler();
  const events = [];
  const child = new BurstChild(["pending", "-delta"]);
  const adapter = new CodexAppServerAdapter({
    cwd: "C:/repo",
    spawnImpl: () => child,
    deltaScheduler: scheduler,
    eventStore: { emit: async (type, data, context) => { events.push({ type, data, context }); } },
  });
  const sendPromise = adapter.send({ prompt: "close", runId: "run-close" });
  await child.burstReady.promise;
  assert.equal(scheduler.pending, 1);
  const closePromise = adapter.close();
  await assert.rejects(sendPromise, { code: "ABORTED" });
  await closePromise;
  const beforeLateTick = events.filter((event) => event.type === "codex.item/agentMessage/delta");
  assert.equal(beforeLateTick.length, 1);
  assert.equal(beforeLateTick[0].data.delta, "pending-delta");
  assert.equal(scheduler.pending, 0);
  scheduler.runAll();
  await Promise.resolve();
  assert.equal(events.filter((event) => event.type === "codex.item/agentMessage/delta").length, beforeLateTick.length);
});

test("Codex terminal error flushes text before rejecting the turn", async () => {
  const scheduler = new ManualScheduler();
  const events = [];
  const child = new BurstChild(["before", "-error"]);
  const adapter = new CodexAppServerAdapter({
    cwd: "C:/repo",
    spawnImpl: () => child,
    deltaScheduler: scheduler,
    eventStore: { emit: async (type, data) => { events.push({ type, data }); } },
  });
  const sendPromise = adapter.send({ prompt: "error", runId: "run-error" });
  await child.burstReady.promise;
  child.complete("model failed");
  await assert.rejects(sendPromise, /model failed/);
  const deltaIndex = events.findIndex((event) => event.type === "codex.item/agentMessage/delta");
  const terminalIndex = events.findIndex((event) => event.type === "codex.turn/completed");
  assert.equal(events[deltaIndex].data.delta, "before-error");
  assert.ok(deltaIndex >= 0 && terminalIndex > deltaIndex);
  assert.equal(scheduler.pending, 0);
  await adapter.close();
});

test("Codex transport failure drains pending delta before rejecting", async () => {
  const scheduler = new ManualScheduler();
  const events = [];
  const child = new BurstChild(["transport", "-tail"]);
  const adapter = new CodexAppServerAdapter({
    cwd: "C:/repo",
    spawnImpl: () => child,
    deltaScheduler: scheduler,
    eventStore: { emit: async (type, data) => { events.push({ type, data }); } },
  });
  const sendPromise = adapter.send({ prompt: "transport", runId: "run-transport" });
  await child.burstReady.promise;
  child.failTransport(17);
  await assert.rejects(sendPromise, { code: "APP_SERVER_EXIT" });
  const deltas = events.filter((event) => event.type === "codex.item/agentMessage/delta");
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].data.delta, "transport-tail");
  assert.equal(scheduler.pending, 0);
  await adapter.close();
});

test("Codex pre-ack isolation rejects stale notifications from the prior turn", async () => {
  class StaleTurnChild extends FakeChild {
    handle(message) {
      if (message.method !== "turn/start") return super.handle(message);
      const threadId = message.params.threadId;
      this.stdout.write(encodeJsonLine({
        method: "item/agentMessage/delta",
        params: { threadId, turnId: "old-turn", delta: "STALE" },
      }));
      this.stdout.write(encodeJsonLine({
        method: "turn/completed",
        params: { threadId, turn: { id: "old-turn", status: "completed", items: [] } },
      }));
      this.reply(message.id, { turn: { id: "new-turn", status: "inProgress", items: [] } });
      setImmediate(() => {
        this.stdout.write(encodeJsonLine({
          method: "item/agentMessage/delta",
          params: { threadId, turnId: "new-turn", delta: "FRESH" },
        }));
        this.stdout.write(encodeJsonLine({
          method: "turn/completed",
          params: { threadId, turn: { id: "new-turn", status: "completed", items: [] } },
        }));
      });
    }
  }

  const events = [];
  const child = new StaleTurnChild();
  const adapter = new CodexAppServerAdapter({
    cwd: "C:/repo",
    spawnImpl: () => child,
    eventStore: { emit: async (type, data, context) => { events.push({ type, data, context }); } },
  });

  const result = await adapter.send({ prompt: "new request", runId: "new-run" });
  assert.equal(result.text, "FRESH");
  assert.equal(result.turn.id, "new-turn");
  const runDeltas = events.filter((event) =>
    event.type === "codex.item/agentMessage/delta" && event.context.runId === "new-run");
  assert.equal(runDeltas.map((event) => event.data.delta).join(""), "FRESH");
  assert.equal(events.some((event) => event.context.runId === "new-run" && event.data.turnId === "old-turn"), false);
  await adapter.close();
});

test("Codex pre-ack isolation fails closed on an oversized non-delta payload", async () => {
  class OversizedPreAckChild extends FakeChild {
    constructor() {
      super();
      this.methods = [];
    }

    handle(message) {
      this.methods.push(message.method);
      if (message.method === "turn/interrupt") return this.reply(message.id, {});
      if (message.method !== "turn/start") return super.handle(message);
      const threadId = message.params.threadId;
      this.stdout.write(encodeJsonLine({
        method: "item/completed",
        params: {
          threadId,
          turnId: "oversized-turn",
          item: { type: "agentMessage", text: "x".repeat(600 * 1024) },
        },
      }));
      this.reply(message.id, { turn: { id: "oversized-turn", status: "inProgress", items: [] } });
    }
  }

  const child = new OversizedPreAckChild();
  const adapter = new CodexAppServerAdapter({
    cwd: "C:/repo",
    spawnImpl: () => child,
    eventStore: { emit: async () => {} },
  });
  await assert.rejects(
    () => adapter.send({ prompt: "bounded", runId: "bounded-run" }),
    { code: "APP_SERVER_PROTOCOL" },
  );
  assert.ok(child.methods.includes("turn/interrupt"));
  await adapter.close();
});

test("Codex interrupts an accepted turn when onTurnAccepted fails", async () => {
  class AcceptedChild extends FakeChild {
    constructor() {
      super();
      this.methods = [];
    }

    handle(message) {
      this.methods.push(message.method);
      if (message.method === "turn/start") {
        return this.reply(message.id, { turn: { id: "accepted-turn", status: "inProgress", items: [] } });
      }
      if (message.method === "turn/interrupt") return this.reply(message.id, {});
      return super.handle(message);
    }
  }

  const child = new AcceptedChild();
  const adapter = new CodexAppServerAdapter({
    cwd: "C:/repo",
    spawnImpl: () => child,
    eventStore: { emit: async () => {} },
  });
  await assert.rejects(
    () => adapter.send({
      prompt: "accepted callback failure",
      runId: "run-callback-failure",
      onTurnAccepted: async () => { throw new Error("checkpoint persistence failed"); },
    }),
    /checkpoint persistence failed/,
  );
  assert.ok(child.methods.includes("turn/interrupt"));
  await adapter.close();
});

test("Codex rejects a turn-scoped delta without turnId and never attributes it to the active run", async () => {
  class UnscopedDeltaChild extends FakeChild {
    constructor() {
      super();
      this.methods = [];
    }

    handle(message) {
      this.methods.push(message.method);
      if (message.method === "turn/start") {
        const threadId = message.params.threadId;
        this.reply(message.id, { turn: { id: "scoped-turn", status: "inProgress", items: [] } });
        setImmediate(() => this.stdout.write(encodeJsonLine({
          method: "response/output_text/delta",
          params: { threadId, delta: "UNSCOPED" },
        })));
        return;
      }
      if (message.method === "turn/interrupt") return this.reply(message.id, {});
      return super.handle(message);
    }
  }

  const child = new UnscopedDeltaChild();
  const events = [];
  const adapter = new CodexAppServerAdapter({
    cwd: "C:/repo",
    spawnImpl: () => child,
    eventStore: { emit: async (type, data, context) => { events.push({ type, data, context }); } },
  });
  await assert.rejects(
    () => adapter.send({ prompt: "unscoped", runId: "run-unscoped" }),
    { code: "APP_SERVER_PROTOCOL" },
  );
  assert.ok(child.methods.includes("turn/interrupt"));
  assert.equal(events.some((event) => event.data?.delta === "UNSCOPED"), false);
  await adapter.close();
});

test("Codex MCP host clears user servers, exposes one target and scrubs split stderr", async () => {
  const events = [];
  const child = new FakeChild();
  const baseEnv = {
    PATH: "C:/runtime/bin",
    SystemRoot: "C:/Windows",
    ComSpec: "C:/Windows/System32/cmd.exe",
    TEMP: "C:/Temp",
    USERPROFILE: "C:/Users/test",
    OPENAI_API_KEY: "openai-secret",
    ANTHROPIC_AUTH_TOKEN: "anthropic-secret",
    GROK_API_KEY: "grok-build-secret",
    GROK_SEARCH_RS_COMPAT_API_URL: "https://grok.test/v1",
    GROK_SEARCH_RS_COMPAT_API_KEY: "grok-search-secret",
    GROK_SEARCH_RS_COMPAT_MODEL: "grok-search-model",
    KIMI_API_KEY: "kimi-secret",
    CONTROL_CENTER_TOKEN: "control-secret",
    CODEX_SESSION_ID: "desktop-session",
  };
  const requiredEnv = [
    "GROK_SEARCH_RS_COMPAT_API_URL",
    "GROK_SEARCH_RS_COMPAT_API_KEY",
    "GROK_SEARCH_RS_COMPAT_MODEL",
  ];
  let spawnCall = null;
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async (type, data) => { events.push({ type, data }); } },
    cwd: "C:/repo",
    environmentProvider: "grok",
    environmentAllowlist: requiredEnv,
    environmentBase: baseEnv,
    disableMcp: true,
    mcpServers: [{
      name: "grok-search-rs",
      command: "C:/runtime/node.exe",
      args: ["C:/repo/scripts/grok_search_chat_compat.mjs"],
      envVars: requiredEnv,
      startupTimeoutSec: 30,
      toolTimeoutSec: 120,
    }],
    spawnImpl: (command, args, options) => {
      spawnCall = { command, args, options };
      return child;
    },
  });

  await adapter.start();
  assert.ok(spawnCall);
  const overrides = spawnCall.args.filter((value, index) => spawnCall.args[index - 1] === "-c");
  assert.ok(overrides.includes("mcp_servers={}"));
  assert.ok(overrides.some((value) => value.startsWith("mcp_servers.grok-search-rs.command=")));
  assert.ok(overrides.some((value) => value.includes("mcp_servers.grok-search-rs.env_vars=")));
  assert.equal(overrides.some((value) => /context7|playwright|serena/i.test(value)), false);
  assert.equal(spawnCall.options.env.GROK_SEARCH_RS_COMPAT_API_KEY, "grok-search-secret");
  assert.equal(Object.hasOwn(spawnCall.options.env, "GROK_API_KEY"), false);
  assert.equal(Object.hasOwn(spawnCall.options.env, "OPENAI_API_KEY"), false);
  assert.equal(Object.hasOwn(spawnCall.options.env, "ANTHROPIC_AUTH_TOKEN"), false);
  assert.equal(Object.hasOwn(spawnCall.options.env, "KIMI_API_KEY"), false);
  assert.equal(Object.hasOwn(spawnCall.options.env, "CONTROL_CENTER_TOKEN"), false);
  assert.equal(Object.hasOwn(spawnCall.options.env, "CODEX_SESSION_ID"), false);

  const stderrEnded = once(child.stderr, "end");
  child.stderr.write("warning OPENAI_API_");
  child.stderr.write("KEY=split-secret\n");
  child.stderr.end();
  await stderrEnded;
  const stderrEvent = events.find((event) => event.type === "adapter.stderr");
  assert.ok(stderrEvent);
  assert.equal(stderrEvent.data.message.includes("split-secret"), false);
  assert.match(stderrEvent.data.message, /\[REDACTED\]/);
  await adapter.close();
});

test("Codex diagnostic persistence rejections are handled", async () => {
  const child = new FakeChild();
  const unhandled = [];
  const attempts = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const adapter = new CodexAppServerAdapter({
    cwd: "C:/repo",
    spawnImpl: () => child,
    eventStore: {
      emit: async (type) => {
        if (type === "adapter.stderr" || type === "adapter.parse_error") {
          attempts.push(type);
          throw new Error("event store unavailable");
        }
      },
    },
  });

  try {
    await adapter.start();
    const stderrEnded = once(child.stderr, "end");
    child.stderr.end("diagnostic line\n");
    await stderrEnded;
    child.stdout.write("not-json\n");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(attempts.sort(), ["adapter.parse_error", "adapter.stderr"]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await adapter.close();
  }
});

test("isolated MCP config rejects unsafe names before spawning", () => {
  assert.throws(
    () => buildIsolatedMcpArgs([{ name: "grok;inject", command: "node" }]),
    { code: "INVALID_MCP_CONFIG" },
  );
});

test("adapter registry wires Grok to the repository-controlled MCP only", () => {
  const adapters = createAdapters({
    profiles: [
      { id: "codex-technical", adapter: "codex-app-server", command: "codex", model: "gpt-test" },
      { id: "claude-fable", adapter: "claude-stream-json", command: "claude", model: "fable-test" },
      { id: "grok-search", adapter: "grok-mcp-via-codex-app-server", command: null, model: null },
    ],
    eventStore: { emit: async () => {} },
    cwd: repoRoot,
    approvalResolver: null,
  });
  const host = adapters.get("grok-search").host;
  assert.equal(adapters.has("kimi-frontend"), false, "unconfigured primary bindings must not create default-command adapters");
  assert.equal(host.disableMcp, true);
  assert.equal(host.environmentProvider, "grok");
  assert.deepEqual(host.environmentAllowlist, [
    "GROK_SEARCH_RS_COMPAT_API_URL",
    "GROK_SEARCH_RS_COMPAT_API_KEY",
    "GROK_SEARCH_RS_COMPAT_MODEL",
  ]);
  assert.equal(host.mcpServers.length, 1);
  assert.equal(host.mcpServers[0].name, "grok-search-rs");
  assert.equal(host.mcpServers[0].command, process.execPath);
  assert.match(host.mcpServers[0].args[0], /scripts[\\/]grok_search_chat_compat\.mjs$/);
});

test("adapter registry never restores required commands through constructor defaults", () => {
  const adapters = createAdapters({
    profiles: [
      { id: "codex-technical", adapter: "codex-app-server", command: null, enabled: true },
      { id: "gemini-research", adapter: "gemini-stream-json", enabled: true },
    ],
    eventStore: { emit: async () => {} },
    cwd: repoRoot,
    approvalResolver: null,
  });

  assert.equal(adapters.has("codex-technical"), false);
  assert.equal(adapters.has("codex-technical-fallback"), false, "fallback must inherit the primary profile's command requirement");
  assert.equal(adapters.has("gemini-research"), false);
});

test("adapter registry rejects a primary profile key that collides with a derived fallback key", () => {
  assert.throws(
    () => createAdapters({
      profiles: [
        { id: "foo", builtin: false, adapter: "codex-app-server", command: "codex", capabilities: [] },
        { id: "foo-fallback", builtin: false, adapter: "claude-stream-json", command: "claude", capabilities: [] },
      ],
      eventStore: { emit: async () => {} },
      cwd: repoRoot,
      approvalResolver: null,
    }),
    (error) => error.code === "ADAPTER_MANIFEST_INVALID" && /foo-fallback/.test(error.message),
  );
});

test("two custom Codex runtime seats receive independent fallback adapters", () => {
  const adapters = createAdapters({
    profiles: [
      { id: "codex-alpha", builtin: false, adapter: "codex-app-server", command: "codex", capabilities: [] },
      { id: "codex-beta", builtin: false, adapter: "codex-app-server", command: "codex", capabilities: [] },
    ],
    eventStore: { emit: async () => {} },
    cwd: repoRoot,
    approvalResolver: null,
  });

  assert.equal(adapters.get("codex-alpha")?.id, "codex-app-server");
  assert.equal(adapters.get("codex-beta")?.id, "codex-app-server");
  assert.equal(adapters.get("codex-alpha-fallback")?.id, "codex-exec-json");
  assert.equal(adapters.get("codex-beta-fallback")?.id, "codex-exec-json");
  assert.notEqual(adapters.get("codex-alpha-fallback"), adapters.get("codex-beta-fallback"));
});

test("Codex app-server adapter initializes, starts a native thread and receives a turn", async () => {
  const events = [];
  const child = new FakeChild();
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async (type, data) => { events.push({ type, data }); } },
    cwd: "C:/repo",
    spawnImpl: () => child,
  });
  const checkpoints = [];
  const result = await adapter.send({
    prompt: "review",
    runId: "run-1",
    permissionMode: "read-only",
    onSessionStarted: async (value) => { checkpoints.push(["session", value.sessionId]); },
    onTurnSubmitting: async (value) => { checkpoints.push(["submitting", value.clientUserMessageId]); },
    onTurnAccepted: async (value) => { checkpoints.push(["accepted", value.turnId]); },
  });
  assert.equal(result.sessionId, "thread-1");
  assert.equal(result.text, "verified");
  assert.equal(result.protocol, "app-server-v2");
  assert.ok(events.some((event) => event.type === "codex.turn/completed"));
  assert.deepEqual(checkpoints.map(([phase]) => phase), ["session", "submitting", "accepted"]);
  const threadStart = child.messages.find((message) => message.method === "thread/start");
  assert.match(threadStart.params.developerInstructions, /current turn prompt is authoritative/);
  assert.doesNotMatch(threadStart.params.developerInstructions, /Claude-led|technical executor and verifier/);
  await adapter.close();
});

// LO 2026-08-09：Codex 官方权限档（桌面批准菜单同款）必须如实映射到 thread/start 的
// sandbox+approvalPolicy 组合；config-default（自定义 config.toml）不下发任何覆盖；
// 未知/只读档 fail-closed 到 read-only + on-request。
test("Codex app-server maps official permission presets onto thread/start and turn/start", async () => {
  const cases = [
    ["read-only", { sandbox: "read-only", approvalPolicy: "on-request" }],
    ["plan", { sandbox: "read-only", approvalPolicy: "on-request" }],
    ["workspace-write", { sandbox: "workspace-write", approvalPolicy: "on-request" }],
    ["workspace-write:on-failure", { sandbox: "workspace-write", approvalPolicy: "on-failure" }],
    ["danger-full-access", { sandbox: "danger-full-access", approvalPolicy: "never" }],
    ["mystery-mode", { sandbox: "read-only", approvalPolicy: "on-request" }],
    ["config-default", null],
  ];
  for (const [mode, expected] of cases) {
    const child = new FakeChild();
    const adapter = new CodexAppServerAdapter({
      eventStore: { emit: async () => {} },
      cwd: "C:/repo",
      spawnImpl: () => child,
    });
    await adapter.send({ prompt: "work", runId: `run-${mode}`, permissionMode: mode });
    const threadStart = child.messages.find((message) => message.method === "thread/start");
    const turnStart = child.messages.find((message) => message.method === "turn/start");
    if (expected) {
      assert.equal(threadStart.params.sandbox, expected.sandbox, `${mode}: thread sandbox`);
      assert.equal(threadStart.params.approvalPolicy, expected.approvalPolicy, `${mode}: thread approvalPolicy`);
      assert.equal(turnStart.params.approvalPolicy, expected.approvalPolicy, `${mode}: turn approvalPolicy`);
    } else {
      assert.ok(!("sandbox" in threadStart.params), "config-default 不得下发 sandbox 覆盖");
      assert.ok(!("approvalPolicy" in threadStart.params), "config-default 不得下发 thread approvalPolicy 覆盖");
      assert.ok(!("approvalPolicy" in turnStart.params), "config-default 不得下发 turn approvalPolicy 覆盖");
    }
    await adapter.close();
  }
});

// LO 2026-08-10：模型热改实证——turn/start 的 model 参数在 codex 0.146.0 实测可会话中切换
// （thread 绑 A、turn 要 B 被接受并触发 thread/settings/updated），与 CLI /model 同一机制。
// Adapter 必须把它带进 turn/start；无 override 时不下发，跟 thread 默认走。
test("Codex app-server passes per-turn model override to turn/start and omits it when unset", async () => {
  const withModel = new FakeChild();
  const adapterA = new CodexAppServerAdapter({
    eventStore: { emit: async () => {} },
    cwd: "C:/repo",
    spawnImpl: () => withModel,
  });
  await adapterA.send({ prompt: "work", runId: "run-model", permissionMode: "read-only", model: "gpt-5.5" });
  const turnA = withModel.messages.find((message) => message.method === "turn/start");
  assert.equal(turnA.params.model, "gpt-5.5");
  await adapterA.close();

  const bare = new FakeChild();
  const adapterB = new CodexAppServerAdapter({
    eventStore: { emit: async () => {} },
    cwd: "C:/repo",
    spawnImpl: () => bare,
  });
  await adapterB.send({ prompt: "work", runId: "run-bare", permissionMode: "read-only" });
  const turnB = bare.messages.find((message) => message.method === "turn/start");
  assert.ok(!("model" in turnB.params), "无 override 不得下发 model，跟 thread 默认走");
  await adapterB.close();
});

test("Codex app-server keeps logical member ownership across notification, approval and interrupt", async () => {
  class LogicalMemberCodexChild extends FakeChild {
    constructor() {
      super();
      this.approvalResponse = deferred();
      this.interruptObserved = deferred();
    }

    handle(message) {
      if (message.id === "approval-logical" && !message.method) {
        this.messages.push(message);
        this.approvalResponse.resolve(message);
        return;
      }
      if (message.method === "turn/start") {
        this.messages.push(message);
        const threadId = message.params.threadId;
        this.reply(message.id, { turn: { id: "turn-logical", status: "inProgress", items: [] } });
        setImmediate(() => {
          this.stdout.write(encodeJsonLine({
            method: "item/started",
            params: { threadId, turnId: "turn-logical", item: { type: "commandExecution" } },
          }));
          this.stdout.write(encodeJsonLine({
            id: "approval-logical",
            method: "item/commandExecution/requestApproval",
            params: { threadId, turnId: "turn-logical", command: "rg identity" },
          }));
        });
        return;
      }
      if (message.method === "turn/interrupt") {
        this.messages.push(message);
        this.interruptObserved.resolve(message);
        this.reply(message.id, {});
        return;
      }
      return super.handle(message);
    }
  }

  const logicalMemberId = "builder-seat";
  const runtimeProfileId = "codex-technical";
  const runId = "run-builder-seat";
  const events = [];
  const approvalContexts = [];
  const child = new LogicalMemberCodexChild();
  const adapter = new CodexAppServerAdapter({
    cwd: "C:/repo",
    runtimeProfileId,
    spawnImpl: () => child,
    eventStore: { emit: async (type, data, context) => events.push({ type, data, context }) },
    approvalResolver: async (_message, context) => {
      approvalContexts.push(context);
      return { decision: "decline" };
    },
  });
  const controller = new AbortController();
  const cancelReason = Object.assign(new Error("operator cancelled logical turn"), { code: "CLIENT_DISCONNECTED" });

  assert.equal(adapter.id, "codex-app-server");
  assert.equal(adapter.runtimeProfileId, runtimeProfileId);
  const sendPromise = adapter.send({
    prompt: "inspect adapter identity",
    runId,
    agentId: logicalMemberId,
    signal: controller.signal,
  });
  const approvalResponse = await child.approvalResponse.promise;
  assert.deepEqual(approvalResponse.result, { decision: "decline" });
  controller.abort(cancelReason);
  const interruptRequest = await child.interruptObserved.promise;
  assert.deepEqual(interruptRequest.params, { threadId: "thread-1", turnId: "turn-logical" });
  await assert.rejects(sendPromise, (error) => error === cancelReason && error.interruptConfirmed === true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(approvalContexts, [{
    runId,
    sessionId: "thread-1",
    agentId: logicalMemberId,
    runtimeProfileId,
  }]);
  for (const type of ["codex.item/started", "approval.requested", "adapter.interrupt_confirmed"]) {
    const event = events.find((candidate) => candidate.type === type);
    assert.ok(event, `missing ${type}`);
    assert.deepEqual(
      {
        runId: event.context.runId,
        sessionId: event.context.sessionId,
        agentId: event.context.agentId,
      },
      { runId, sessionId: "thread-1", agentId: logicalMemberId },
    );
  }
  assert.equal(
    events.some((event) => event.context?.runId === runId && event.context.agentId === runtimeProfileId),
    false,
    "run-bound events must never fall back to the runtime profile id",
  );
  await adapter.close();
});

test("Claude runtime prompt defers coordinator identity to the current turn", async () => {
  const prompt = await readFile(new URL("../../../config/control-center/claude-coordinator.md", import.meta.url), "utf8");
  assert.match(prompt, /当前轮任务包会明确你担任团队主脑、执行者、研究者或验证者/);
  assert.match(prompt, /你不是天然主脑/);
  assert.match(prompt, /工具能力以当前 adapter、当前轮 permissionMode 和真实工具回执为准/);
  assert.doesNotMatch(prompt, /没有文件、Shell、网络或 MCP 工具/);
  assert.doesNotMatch(prompt, /你是 514cc 的认知主脑与总协调者|Claude Fable 负责规划/);
});

test("Claude CLI arguments keep tool availability aligned with the per-turn permission", () => {
  const planArgs = buildClaudeArgs({
    nativeSessionId: "new-session",
    requestedModel: "fable-test",
    permissionMode: "plan",
    systemPromptFile: "runtime-seat.md",
  });
  const writeArgs = buildClaudeArgs({
    sessionId: "existing-session",
    nativeSessionId: "unused",
    requestedModel: "fable-test",
    permissionMode: "workspace-write",
  });
  const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

  assert.equal(planArgs.includes("--tools"), false, "the adapter must not silently disable Claude tools");
  assert.equal(planArgs.includes("--strict-mcp-config"), true);
  assert.equal(valueAfter(planArgs, "--permission-mode"), "plan");
  assert.equal(valueAfter(planArgs, "--system-prompt-file"), "runtime-seat.md");
  assert.equal(valueAfter(planArgs, "--session-id"), "new-session");
  assert.equal(valueAfter(writeArgs, "--permission-mode"), "acceptEdits");
  assert.equal(valueAfter(writeArgs, "--resume"), "existing-session");
  assert.equal(valueAfter(planArgs, "--max-budget-usd"), "2");
  assert.equal(valueAfter(writeArgs, "--max-budget-usd"), "2");
});

test("Claude CLI native approval passthrough applies on read-only turns and the write-turn red line holds", () => {
  const bypassArgs = buildClaudeArgs({
    nativeSessionId: "native-session",
    requestedModel: "fable-test",
    permissionMode: "plan",
    nativeApprovalMode: "native:bypassPermissions",
  });
  const acceptArgs = buildClaudeArgs({
    nativeSessionId: "native-session",
    permissionMode: "plan",
    nativeApprovalMode: "native:acceptEdits",
  });
  const writeWithNative = buildClaudeArgs({
    sessionId: "existing-session",
    nativeSessionId: "unused",
    permissionMode: "workspace-write",
    nativeApprovalMode: "native:bypassPermissions",
  });
  const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];
  assert.equal(valueAfter(bypassArgs, "--permission-mode"), "bypassPermissions");
  assert.equal(valueAfter(acceptArgs, "--permission-mode"), "acceptEdits");
  // 写盘轮红线：native 覆盖完全无效，固定 acceptEdits + 审批
  assert.equal(valueAfter(writeWithNative, "--permission-mode"), "acceptEdits");
});

test("Claude CLI omits --model when the runtime has no explicit model", () => {
  for (const requestedModel of [null, undefined, "", "   "]) {
    const args = buildClaudeArgs({ nativeSessionId: "new-session", requestedModel });
    assert.equal(args.includes("--model"), false, `unexpected --model for ${String(requestedModel)}`);
    assert.equal(args.includes(null), false);
    assert.equal(args.includes(undefined), false);
  }
  const explicit = buildClaudeArgs({ nativeSessionId: "new-session", requestedModel: "  claude-sonnet-test  " });
  assert.equal(explicit[explicit.indexOf("--model") + 1], "claude-sonnet-test");
});

test("Claude CLI slash-command gating flips only for explicit native command turns", () => {
  // 普通轮：斜杠命令禁用——提示词里的 "/" 只是文本，防提示注入触发 CLI 内部命令
  const normal = buildClaudeArgs({ nativeSessionId: "s", requestedModel: "fable", permissionMode: "plan" });
  assert.equal(normal.includes("--disable-slash-commands"), true);
  // 原生命令轮（用户显式发送 /compact 等）：CLI 需要解释执行，与 Desktop 同通道
  const native = buildClaudeArgs({
    nativeSessionId: "s",
    requestedModel: "fable",
    permissionMode: "plan",
    nativeCommand: true,
  });
  assert.equal(native.includes("--disable-slash-commands"), false);
  // 其余关键闸不变
  assert.equal(native.includes("--strict-mcp-config"), true);
  assert.equal(native.includes("-p"), true);
});

test("Codex app-server close waits for the child exit boundary", async () => {
  class DelayedChild extends FakeChild {
    kill() {
      setTimeout(() => {
        this.emit("exit", 0);
        this.emit("close", 0);
      }, 35);
    }
  }
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async () => {} },
    cwd: "C:/repo",
    spawnImpl: () => new DelayedChild(),
  });
  await adapter.start();
  const started = Date.now();
  await adapter.close();
  assert.ok(Date.now() - started >= 25);
});

test("Grok MCP adapter probes inventory and executes web_search through app-server", async () => {
  const calls = [];
  const host = {
    async start() {},
    async createThread() { return "grok-thread"; },
    async ensureThread() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === "mcpServerStatus/list") {
        return {
          data: [{ name: "grok-search-rs", tools: { web_search: { name: "web_search", inputSchema: { type: "object" } } } }],
          nextCursor: null,
        };
      }
      if (method === "mcpServer/tool/call") return { content: [{ type: "text", text: "current result\nhttps://example.com" }], isError: false };
      throw new Error(`unexpected method ${method}`);
    },
  };
  const adapter = new GrokMcpAdapter({ host, eventStore: { emit: async () => {} } });
  const health = await adapter.health();
  assert.equal(health.available, true);
  const checkpoints = [];
  const result = await adapter.send({
    prompt: "latest evidence",
    runId: "run-grok",
    onSessionStarted: async () => checkpoints.push("session"),
    onTurnSubmitting: async () => checkpoints.push("submitting"),
    onTurnAccepted: async () => checkpoints.push("accepted"),
  });
  assert.equal(result.protocol, "codex-app-server-mcp-v2");
  assert.match(result.text, /example\.com/);
  assert.deepEqual(checkpoints, ["session", "submitting", "accepted"]);
  assert.equal(calls.find((call) => call.method === "mcpServer/tool/call").params.arguments.query, "latest evidence");
});

test("Codex app-server request cancellation removes the pending request immediately", async () => {
  const child = new FakeChild();
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async () => {} },
    cwd: "C:/repo",
    spawnImpl: () => child,
  });
  await adapter.start();
  const controller = new AbortController();
  const reason = Object.assign(new Error("health subscriber disconnected"), { code: "CLIENT_DISCONNECTED" });
  const pending = adapter.request("mcpServerStatus/list", {}, 30_000, { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(adapter.pending.size, 0);
  await adapter.close();
});

test("Codex compensation capacity rejects before write and never evicts an older late response", async () => {
  class SaturatedChild extends FakeChild {
    constructor() {
      super();
      this.turnStarts = [];
    }

    handle(message) {
      if (message.method === "turn/start") {
        this.turnStarts.push(message);
        return;
      }
      return super.handle(message);
    }
  }

  const child = new SaturatedChild();
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async () => {} },
    cwd: "C:/repo",
    spawnImpl: () => child,
  });
  await adapter.start();
  let oldestCompensated = false;
  for (let index = 0; index < 64; index += 1) {
    const controller = new AbortController();
    const pending = adapter.request("turn/start", { threadId: `thread-${index}` }, 30_000, {
      signal: controller.signal,
      onLateResponse: async () => { if (index === 0) oldestCompensated = true; },
    });
    controller.abort(Object.assign(new Error(`cancel ${index}`), { code: "CLIENT_DISCONNECTED" }));
    await assert.rejects(pending, { code: "CLIENT_DISCONNECTED" });
  }
  assert.equal(adapter.lateResponses.size, 64);
  assert.equal(adapter.compensationReservations.size, 64);
  await assert.rejects(
    adapter.request("turn/start", { threadId: "must-not-write" }, 30_000, { onLateResponse: async () => {} }),
    (error) => error.code === "APP_SERVER_COMPENSATION_BUSY" && error.requestWritten === false,
  );
  assert.equal(child.turnStarts.length, 64, "capacity rejection happens before the 65th request is written");

  child.reply(child.turnStarts[0].id, { turn: { id: "oldest-late-turn" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(oldestCompensated, true, "the oldest compensation owner must survive saturation");
  assert.equal(adapter.compensationReservations.size, 63);
  await adapter.close();
});

test("Codex pre-cancelled send does not start app-server or submit a turn", async () => {
  let spawnCalls = 0;
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async () => {} },
    cwd: "C:/repo",
    spawnImpl: () => {
      spawnCalls += 1;
      return new FakeChild();
    },
  });
  const controller = new AbortController();
  const reason = Object.assign(new Error("request already disconnected"), { code: "CLIENT_DISCONNECTED" });
  controller.abort(reason);

  await assert.rejects(
    adapter.send({ prompt: "must not run", runId: "run-pre-cancel", signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(spawnCalls, 0);
  assert.equal(adapter.pending.size, 0);
  assert.equal(adapter.activeByThread.size, 0);
});

test("Codex send cancellation reaches thread setup and removes its pending request", async () => {
  class BlockingThreadChild extends FakeChild {
    constructor() {
      super();
      this.threadStartObserved = deferred();
      this.archiveObserved = deferred();
      this.threadStartRequest = null;
      this.methods = [];
    }

    handle(message) {
      this.methods.push(message.method);
      if (message.method === "thread/start") {
        this.threadStartRequest = message;
        this.threadStartObserved.resolve();
        return;
      }
      if (message.method === "thread/archive") {
        this.archiveObserved.resolve(message);
        return;
      }
      return super.handle(message);
    }
  }

  const child = new BlockingThreadChild();
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async () => {} },
    cwd: "C:/repo",
    spawnImpl: () => child,
  });
  const controller = new AbortController();
  const reason = Object.assign(new Error("cancel during thread setup"), { code: "CLIENT_DISCONNECTED" });
  const pending = adapter.send({ prompt: "setup", runId: "run-setup-cancel", signal: controller.signal });
  await child.threadStartObserved.promise;
  controller.abort(reason);

  await assert.rejects(pending, (error) => error === reason);
  assert.equal(adapter.pending.size, 0);
  assert.equal(child.methods.includes("turn/start"), false);
  assert.equal(adapter.lateResponses.size, 1);
  child.reply(child.threadStartRequest.id, { thread: { id: "late-thread" } });
  const archiveRequest = await child.archiveObserved.promise;
  assert.equal(archiveRequest.params.threadId, "late-thread");
  child.reply(archiveRequest.id, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adapter.lateResponses.size, 0);
  await adapter.close();
});

test("Codex send cancellation reaches turn acknowledgement and clears active state", async () => {
  class BlockingTurnChild extends FakeChild {
    constructor() {
      super();
      this.turnStartObserved = deferred();
      this.interruptObserved = deferred();
      this.turnStartRequest = null;
      this.methods = [];
    }

    handle(message) {
      this.methods.push(message.method);
      if (message.method === "turn/start") {
        this.turnStartRequest = message;
        this.turnStartObserved.resolve();
        return;
      }
      if (message.method === "turn/interrupt") {
        this.interruptObserved.resolve(message);
        return;
      }
      return super.handle(message);
    }
  }

  const child = new BlockingTurnChild();
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async () => {} },
    cwd: "C:/repo",
    spawnImpl: () => child,
  });
  const controller = new AbortController();
  const reason = Object.assign(new Error("cancel while waiting for turn ack"), { code: "CLIENT_DISCONNECTED" });
  const pending = adapter.send({ prompt: "turn", runId: "run-turn-cancel", signal: controller.signal });
  await child.turnStartObserved.promise;
  controller.abort(reason);

  await assert.rejects(pending, (error) => error === reason);
  assert.equal(adapter.pending.size, 0);
  assert.equal(adapter.activeByThread.size, 0);
  assert.equal(adapter.lateResponses.size, 1);
  child.reply(child.turnStartRequest.id, { turn: { id: "late-turn", status: "inProgress", items: [] } });
  const interruptRequest = await child.interruptObserved.promise;
  assert.deepEqual(interruptRequest.params, { threadId: "thread-1", turnId: "late-turn" });
  child.reply(interruptRequest.id, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adapter.lateResponses.size, 0);
  await adapter.close();
});

test("Codex known-turn cancellation retains ownership until interrupt acknowledgement", async () => {
  class DelayedInterruptChild extends FakeChild {
    constructor() {
      super();
      this.interruptObserved = deferred();
    }

    handle(message) {
      if (message.method === "turn/start") {
        return this.reply(message.id, { turn: { id: "accepted-cancel-turn", status: "inProgress", items: [] } });
      }
      if (message.method === "turn/interrupt") {
        this.interruptObserved.resolve(message);
        return;
      }
      return super.handle(message);
    }
  }

  const child = new DelayedInterruptChild();
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async () => {} },
    cwd: "C:/repo",
    spawnImpl: () => child,
  });
  const controller = new AbortController();
  const reason = Object.assign(new Error("cancel accepted turn"), { code: "CLIENT_DISCONNECTED" });
  const pending = adapter.send({
    prompt: "accepted",
    runId: "run-accepted-cancel",
    signal: controller.signal,
    onTurnAccepted: async () => controller.abort(reason),
  });
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const interruptRequest = await child.interruptObserved.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the caller stays pending until the remote interrupt boundary");
  assert.equal(adapter.activeByThread.get("thread-1")?.cancelling, true);

  child.reply(interruptRequest.id, {});
  await assert.rejects(pending, (error) => error === reason && error.interruptConfirmed === true);
  assert.equal(adapter.activeByThread.size, 0);
  await adapter.close();
});

test("Codex records an unconfirmed interrupt before releasing a cancelled turn", async () => {
  class RejectedInterruptChild extends FakeChild {
    handle(message) {
      if (message.method === "turn/start") {
        return this.reply(message.id, { turn: { id: "rejected-interrupt-turn", status: "inProgress", items: [] } });
      }
      if (message.method === "turn/interrupt") {
        return queueMicrotask(() => this.stdout.write(encodeJsonLine({
          id: message.id,
          error: { code: -32_001, message: "interrupt rejected" },
        })));
      }
      return super.handle(message);
    }
  }

  const events = [];
  const child = new RejectedInterruptChild();
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async (type, data) => events.push({ type, data }) },
    cwd: "C:/repo",
    spawnImpl: () => child,
  });
  const controller = new AbortController();
  const reason = Object.assign(new Error("cancel with failed interrupt"), { code: "CLIENT_DISCONNECTED" });
  await assert.rejects(
    adapter.send({
      prompt: "accepted",
      runId: "run-failed-interrupt",
      signal: controller.signal,
      onTurnAccepted: async () => controller.abort(reason),
    }),
    (error) => error === reason
      && error.interruptConfirmed === false
      && error.interruptErrorMessage === "interrupt rejected",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((event) => event.type === "adapter.interrupt_failed"));
  assert.equal(adapter.activeByThread.size, 0);
  await adapter.close();
});

test("Codex caller cancellation can leave shared app-server initialization running", async () => {
  class BlockingInitializeChild extends FakeChild {
    constructor() {
      super();
      this.initializeObserved = deferred();
      this.initializeRequest = null;
    }

    handle(message) {
      if (message.method === "initialize") {
        this.initializeRequest = message;
        this.initializeObserved.resolve();
        return;
      }
      return super.handle(message);
    }
  }

  const child = new BlockingInitializeChild();
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async () => {} },
    cwd: "C:/repo",
    spawnImpl: () => child,
  });
  const controller = new AbortController();
  const reason = Object.assign(new Error("cancel during initialization"), { code: "CLIENT_DISCONNECTED" });
  const pending = adapter.send({ prompt: "init", runId: "run-init-cancel", signal: controller.signal });
  await child.initializeObserved.promise;
  controller.abort(reason);

  await assert.rejects(pending, (error) => error === reason && error.codexPhase === "session-setup");
  assert.equal(adapter.pending.size, 1, "shared initialization remains owned by the adapter, not the cancelled caller");
  child.reply(child.initializeRequest.id, { codexHome: "C:/mock", platformFamily: "windows", platformOs: "windows", userAgent: "mock" });
  await new Promise((resolve) => setImmediate(resolve));
  await adapter.close();
});

test("Codex cancellation releases never-settling session and submitting lifecycle callbacks", async () => {
  class LifecycleChild extends FakeChild {
    constructor() {
      super();
      this.methods = [];
    }

    handle(message) {
      this.methods.push(message.method);
      return super.handle(message);
    }
  }

  for (const phase of ["session", "submitting"]) {
    const child = new LifecycleChild();
    const activeLifecycleTimers = new Set();
    const lifecycleScheduler = {
      setTimeout(callback, delay) {
        const timer = { callback, delay };
        activeLifecycleTimers.add(timer);
        return timer;
      },
      clearTimeout(timer) {
        activeLifecycleTimers.delete(timer);
      },
    };
    const adapter = new CodexAppServerAdapter({
      eventStore: { emit: async () => {} },
      cwd: "C:/repo",
      spawnImpl: () => child,
      lifecycleTimeoutMs: 60_000,
      lifecycleScheduler,
    });
    const entered = deferred();
    const controller = new AbortController();
    const reason = Object.assign(new Error(`cancel ${phase} lifecycle`), { code: "CLIENT_DISCONNECTED" });
    const pending = adapter.send({
      prompt: "lifecycle",
      runId: `run-${phase}-lifecycle`,
      signal: controller.signal,
      onSessionStarted: phase === "session" ? () => { entered.resolve(); return new Promise(() => {}); } : undefined,
      onTurnSubmitting: phase === "submitting" ? () => { entered.resolve(); return new Promise(() => {}); } : undefined,
    });
    await entered.promise;
    assert.equal(activeLifecycleTimers.size, 1);
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    assert.equal(activeLifecycleTimers.size, 0, "caller cancellation must retire the lifecycle timer immediately");
    assert.equal(adapter.activeByThread.size, 0);
    assert.equal(child.methods.includes("turn/start"), false);
    await adapter.close();
  }
});

test("Codex cancellation releases a never-settling accepted lifecycle only after interrupt ACK", async () => {
  class AcceptedLifecycleChild extends FakeChild {
    constructor() {
      super();
      this.interruptObserved = deferred();
    }

    handle(message) {
      if (message.method === "turn/start") {
        return this.reply(message.id, { turn: { id: "accepted-lifecycle-turn", status: "inProgress", items: [] } });
      }
      if (message.method === "turn/interrupt") {
        this.interruptObserved.resolve(message);
        return;
      }
      return super.handle(message);
    }
  }

  const child = new AcceptedLifecycleChild();
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async () => {} },
    cwd: "C:/repo",
    spawnImpl: () => child,
  });
  const entered = deferred();
  const controller = new AbortController();
  const reason = Object.assign(new Error("cancel accepted lifecycle"), { code: "CLIENT_DISCONNECTED" });
  const pending = adapter.send({
    prompt: "accepted lifecycle",
    runId: "run-accepted-lifecycle",
    signal: controller.signal,
    onTurnAccepted: () => { entered.resolve(); return new Promise(() => {}); },
  });
  await entered.promise;
  controller.abort(reason);
  const interrupt = await child.interruptObserved.promise;
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  child.reply(interrupt.id, {});
  await assert.rejects(pending, (error) => error === reason && error.interruptConfirmed === true);
  assert.equal(adapter.activeByThread.size, 0);
  await adapter.close();
});

test("Codex lifecycle timeout prevents a stalled submission callback from sending a turn", async () => {
  class LifecycleTimeoutChild extends FakeChild {
    constructor() {
      super();
      this.methods = [];
    }

    handle(message) {
      this.methods.push(message.method);
      return super.handle(message);
    }
  }

  const child = new LifecycleTimeoutChild();
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async () => {} },
    cwd: "C:/repo",
    spawnImpl: () => child,
    lifecycleTimeoutMs: 20,
  });
  await assert.rejects(
    adapter.send({
      prompt: "must not submit",
      runId: "run-lifecycle-timeout",
      onTurnSubmitting: () => new Promise(() => {}),
    }),
    (error) => error.code === "APP_SERVER_LIFECYCLE_TIMEOUT"
      && error.lifecyclePhase === "turn-submitting"
      && error.safeToFallback === true,
  );
  assert.equal(child.methods.includes("turn/start"), false);
  assert.equal(adapter.activeByThread.size, 0);
  await adapter.close();
});

test("Grok MCP health propagates cancellation through active inventory", async () => {
  let observedSignal;
  const host = {
    child: {},
    async start() {},
    async createThread({ signal }) {
      observedSignal = signal;
      return "health-thread";
    },
    async request(_method, _params, _timeoutMs, { signal }) {
      observedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
  const adapter = new GrokMcpAdapter({ host, eventStore: { emit: async () => {} } });
  const controller = new AbortController();
  const reason = Object.assign(new Error("last health subscriber disconnected"), { code: "CLIENT_DISCONNECTED" });
  const pending = adapter.health({ signal: controller.signal });
  await new Promise((resolveTimer) => setImmediate(resolveTimer));
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(observedSignal, controller.signal);
});

test("Codex app-server marks a transport failure after turn submission as unsafe to replay", async () => {
  class AmbiguousChild extends FakeChild {
    handle(message) {
      if (message.method !== "turn/start") return super.handle(message);
      this.turnStart = message;
      queueMicrotask(() => this.emit("exit", 17));
    }
  }
  const child = new AmbiguousChild();
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async () => {} },
    cwd: "C:/repo",
    spawnImpl: () => child,
  });
  await assert.rejects(
    () => adapter.send({ prompt: "write once", runId: "run-ambiguous", permissionMode: "read-only" }),
    (error) => {
      assert.equal(error.code, "APP_SERVER_EXIT");
      assert.equal(error.safeToFallback, false);
      assert.equal(error.codexPhase, "turn-submitted-or-unknown");
      assert.equal(error.sessionId, "thread-1");
      assert.equal(error.clientUserMessageId, child.turnStart.params.clientUserMessageId);
      return true;
    },
  );
});

test("Codex app-server distinguishes an explicit turn rejection from an ambiguous transport loss", async () => {
  class RejectedChild extends FakeChild {
    handle(message) {
      if (message.method !== "turn/start") return super.handle(message);
      this.turnStart = message;
      queueMicrotask(() => this.stdout.write(encodeJsonLine({
        id: message.id,
        error: { code: 403, message: "INSUFFICIENT_BALANCE" },
      })));
    }
  }
  const child = new RejectedChild();
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async () => {} },
    cwd: "C:/repo",
    spawnImpl: () => child,
  });
  await assert.rejects(
    () => adapter.send({ prompt: "write once", runId: "run-rejected", permissionMode: "read-only" }),
    (error) => {
      assert.equal(error.code, 403);
      assert.equal(error.safeToFallback, true);
      assert.equal(error.submissionRejected, true);
      assert.equal(error.codexPhase, "turn-rejected");
      assert.equal(error.clientUserMessageId, child.turnStart.params.clientUserMessageId);
      return true;
    },
  );
  assert.equal(adapter.activeByThread.size, 0);
  await adapter.close();
});

test("Codex app-server keeps an unclassified turn error ambiguous after the request was written", async () => {
  class InternalErrorChild extends FakeChild {
    handle(message) {
      if (message.method !== "turn/start") return super.handle(message);
      queueMicrotask(() => this.stdout.write(encodeJsonLine({
        id: message.id,
        error: { code: -32_603, message: "internal error after admission" },
      })));
    }
  }
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async () => {} },
    cwd: "C:/repo",
    spawnImpl: () => new InternalErrorChild(),
  });
  await assert.rejects(
    () => adapter.send({ prompt: "write once", runId: "run-internal-error", permissionMode: "read-only" }),
    (error) => {
      assert.equal(error.code, -32_603);
      assert.equal(error.safeToFallback, false);
      assert.equal(error.submissionRejected, false);
      assert.equal(error.codexPhase, "turn-submitted-or-unknown");
      return true;
    },
  );
  await adapter.close();
});

test("Codex app-server classifies context exhaustion as a settled native turn", async (t) => {
  const cases = [
    {
      label: "structured",
      error: {
        message: "localized provider failure",
        codexErrorInfo: "contextWindowExceeded",
      },
    },
    {
      label: "legacy-text",
      error: {
        message: "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.label, async () => {
      class ContextOverflowChild extends FakeChild {
        handle(message) {
          if (message.method !== "turn/start") return super.handle(message);
          this.messages.push(message);
          this.reply(message.id, { turn: { id: "turn-context-full", status: "inProgress", items: [] } });
          setImmediate(() => this.stdout.write(encodeJsonLine({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: {
                id: "turn-context-full",
                status: "failed",
                items: [],
                error: item.error,
              },
            },
          })));
        }
      }

      const adapter = new CodexAppServerAdapter({
        eventStore: { emit: async () => {} },
        cwd: "C:/repo",
        spawnImpl: () => new ContextOverflowChild(),
      });
      await assert.rejects(
        () => adapter.send({ prompt: "continue", runId: `run-context-${item.label}`, permissionMode: "read-only" }),
        (error) => {
          assert.equal(error.code, "CONTEXT_WINDOW_EXCEEDED");
          assert.equal(error.nativeTurnSettled, true);
          assert.equal(error.requiresContextCompaction, true);
          assert.equal(error.safeToFallback, false);
          assert.equal(error.codexPhase, "turn-settled-failed");
          assert.equal(error.sessionId, "thread-1");
          assert.equal(error.turnId, "turn-context-full");
          return true;
        },
      );
      assert.equal(adapter.activeByThread.size, 0);
      await adapter.close();
    });
  }
});

test("Codex app-server waits for the native compact turn terminal boundary", async () => {
  class CompactChild extends FakeChild {
    constructor() {
      super();
      this.compactStarted = deferred();
    }

    handle(message) {
      if (message.method !== "thread/compact/start") return super.handle(message);
      this.messages.push(message);
      this.reply(message.id, {});
      setImmediate(() => {
        this.stdout.write(encodeJsonLine({
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-compact", status: "inProgress", items: [] },
          },
        }));
        this.stdout.write(encodeJsonLine({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-compact",
            item: { id: "compact-item", type: "contextCompaction" },
          },
        }));
        this.compactStarted.resolve();
      });
    }

    finishCompaction() {
      this.stdout.write(encodeJsonLine({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-compact",
          item: { id: "compact-item", type: "contextCompaction" },
        },
      }));
      this.stdout.write(encodeJsonLine({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-compact", status: "completed", items: [] },
        },
      }));
    }
  }

  const child = new CompactChild();
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async () => {} },
    cwd: "C:/repo",
    spawnImpl: () => child,
  });
  await adapter.createThread();
  let settled = false;
  const compacting = adapter.compactThread("thread-1").then((result) => {
    settled = true;
    return result;
  });
  await child.compactStarted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "compact RPC acknowledgement is not the terminal boundary");
  child.finishCompaction();
  const result = await compacting;
  assert.deepEqual(result, {
    sessionId: "thread-1",
    turnId: "turn-compact",
    protocol: "app-server-v2",
  });
  assert.equal(adapter.compactionsByThread.size, 0);
  await adapter.close();
});

test("Codex app-server setup failure is explicitly safe for CLI fallback", async () => {
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async () => {} },
    cwd: "C:/repo",
    spawnImpl: () => { throw Object.assign(new Error("missing executable"), { code: "ENOENT" }); },
  });
  await assert.rejects(
    () => adapter.send({ prompt: "review", runId: "run-setup", permissionMode: "read-only" }),
    (error) => error.code === "ENOENT" && error.safeToFallback === true && error.codexPhase === "session-setup",
  );
});


test("Codex idle watchdog kills a silent turn while the max-duration gate stays armed", async () => {
  class SilentChild extends FakeChild {
    handle(message) {
      // turn/start 正常应答后彻底沉默：总时长闸（10s）远未到，只有静默闸（60ms）该开火
      if (message.method === "turn/start") return this.reply(message.id, { turn: { id: "turn-1", status: "inProgress", items: [] } });
      if (message.method === "turn/interrupt") return this.reply(message.id, {});
      return super.handle(message);
    }
  }
  const child = new SilentChild();
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async () => {} },
    cwd: "C:/repo",
    spawnImpl: () => child,
  });
  try {
    await assert.rejects(
      () => adapter.send({ prompt: "hang silently", runId: "run-idle", permissionMode: "read-only", idleTimeoutMs: 60, timeoutMs: 10_000 }),
      (error) => error.code === "TURN_IDLE_TIMEOUT"
        && error.interruptConfirmed === true
        && error.safeToFallback === false
        && error.codexPhase === "turn-submitted-or-unknown"
        && error.sessionId === "thread-1",
    );
  } finally {
    await adapter.close();
  }
});

test("Codex terminal text reaches the conversation stream exactly once on a normal turn", async () => {
  class FinalAnswerChild extends FakeChild {
    handle(message) {
      if (message.method !== "turn/start") return super.handle(message);
      this.reply(message.id, { turn: { id: "turn-1", status: "inProgress", items: [] } });
      setTimeout(() => {
        this.stdout.write(encodeJsonLine({
          method: "item/completed",
          params: { threadId: "thread-1", turnId: "turn-1", item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "完整结论" } },
        }));
        this.stdout.write(encodeJsonLine({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
        }));
      }, 5);
    }
  }
  const events = [];
  const child = new FinalAnswerChild();
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async (type, data) => { events.push({ type, data }); } },
    cwd: "C:/repo",
    spawnImpl: () => child,
  });
  try {
    const result = await adapter.send({ prompt: "answer", runId: "run-final-answer", permissionMode: "read-only", timeoutMs: 10_000 });
    assert.equal(result.text, "完整结论");
    const finals = events.filter((event) => event.type === "assistant.message");
    assert.equal(finals.length, 1, "终局正文必须恰好进会话流一次");
    assert.equal(finals[0].data.text, "完整结论");
    assert.equal(events.some((event) => event.type === "assistant.partial_message"), false);
  } finally {
    await adapter.close();
  }
});

test("Codex partial text from an aborted turn never masquerades as a normal reply", async () => {
  class HalfAnswerChild extends FakeChild {
    handle(message) {
      if (message.method === "turn/interrupt") return this.reply(message.id, {});
      if (message.method !== "turn/start") return super.handle(message);
      this.reply(message.id, { turn: { id: "turn-1", status: "inProgress", items: [] } });
      // 先吐半截正文，然后彻底沉默：静默闸开火 → cancelActive → 异常终局。
      setTimeout(() => {
        this.stdout.write(encodeJsonLine({
          method: "item/completed",
          params: { threadId: "thread-1", turnId: "turn-1", item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "答到一半就被杀了" } },
        }));
      }, 5);
    }
  }
  const events = [];
  const child = new HalfAnswerChild();
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async (type, data) => { events.push({ type, data }); } },
    cwd: "C:/repo",
    spawnImpl: () => child,
  });
  try {
    await assert.rejects(
      () => adapter.send({ prompt: "half", runId: "run-half-answer", permissionMode: "read-only", idleTimeoutMs: 60, timeoutMs: 10_000 }),
      { code: "TURN_IDLE_TIMEOUT" },
    );
    assert.equal(
      events.some((event) => event.type === "assistant.message"),
      false,
      "被打断的半截正文不得以正常回复出现——否则 LO 无法区分「答完了」和「答了一半被杀」",
    );
    const partial = events.filter((event) => event.type === "assistant.partial_message");
    assert.equal(partial.length, 1, "半截正文仍必须可见，只是要明确标注未形成交付");
    assert.equal(partial[0].data.text, "答到一半就被杀了");
    assert.equal(partial[0].data.code, "TURN_IDLE_TIMEOUT");
  } finally {
    await adapter.close();
  }
});

test("Codex turn errors without a message still fail the turn instead of settling empty", async () => {
  class SilentErrorChild extends FakeChild {
    handle(message) {
      if (message.method !== "turn/start") return super.handle(message);
      this.reply(message.id, { turn: { id: "turn-1", status: "inProgress", items: [] } });
      setTimeout(() => {
        // provider 报错但没给 message，只给 errorInfo：此前会被判成"成功但正文为空"（silent fallback）
        this.stdout.write(encodeJsonLine({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "failed", items: [], error: { codexErrorInfo: { contextWindowExceeded: {} } } },
          },
        }));
      }, 5);
    }
  }
  const child = new SilentErrorChild();
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async () => {} },
    cwd: "C:/repo",
    spawnImpl: () => child,
  });
  try {
    await assert.rejects(
      () => adapter.send({ prompt: "silent failure", runId: "run-silent-error", permissionMode: "read-only", timeoutMs: 10_000 }),
      (error) => {
        assert.equal(error.code, "CONTEXT_WINDOW_EXCEEDED", "缺 message 的 contextWindowExceeded 必须仍然触发压缩恢复链");
        assert.equal(error.requiresContextCompaction, true);
        assert.equal(error.nativeTurnSettled, true);
        return true;
      },
    );
  } finally {
    await adapter.close();
  }
});

test("Codex idle watchdog resets on native traffic, so slow-but-alive turns survive", async () => {
  class StreamingChild extends FakeChild {
    handle(message) {
      if (message.method === "turn/start") {
        this.reply(message.id, { turn: { id: "turn-1", status: "inProgress", items: [] } });
        // 每 25ms 一缕 delta，共 8 缕（≈200ms > 150ms 静默闸），随后 completed：
        // 总时长超过静默闸但每段间隔都在闸内——慢但健在的轮必须存活（旧墙钟会误杀它）。
        let ticks = 0;
        const timer = setInterval(() => {
          ticks += 1;
          if (ticks < 8) {
            this.stdout.write(encodeJsonLine({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: `chunk-${ticks}-` } }));
          } else {
            clearInterval(timer);
            this.stdout.write(encodeJsonLine({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } }));
          }
        }, 25);
        return;
      }
      return super.handle(message);
    }
  }
  const child = new StreamingChild();
  const adapter = new CodexAppServerAdapter({
    eventStore: { emit: async () => {} },
    cwd: "C:/repo",
    spawnImpl: () => child,
  });
  try {
    const result = await adapter.send({ prompt: "stream slowly", runId: "run-stream", permissionMode: "read-only", idleTimeoutMs: 150, timeoutMs: 10_000 });
    assert.equal(result.sessionId, "thread-1");
    assert.match(result.text, /chunk-7/);
  } finally {
    await adapter.close();
  }
});
