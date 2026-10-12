import test from "node:test";
import assert from "node:assert/strict";
import { buildCodebuddyArgs, CodeBuddyCliAdapter } from "../src/adapters/codebuddy-cli.mjs";

const repoRoot = new URL("../../../", import.meta.url).pathname;

function eventStoreSpy() {
  const emitted = [];
  return {
    emitted,
    store: { emit: async (type, data, context) => { emitted.push({ type, data, context }); } },
  };
}

test("buildCodebuddyArgs emits the headless stream-json shape and keeps read-only turns on the native plan mode", () => {
  const args = buildCodebuddyArgs({ nativeSessionId: "sess-new-1" });
  assert.equal(args[0], "-p");
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  assert.equal(args[args.indexOf("--session-id") + 1], "sess-new-1");
  assert.equal(args.includes("--resume"), false);

  // read-only 与 plan 同落 CLI 原生 plan 档——CodeBuddy 没有独立只读档
  const readOnly = buildCodebuddyArgs({ nativeSessionId: "sess-new-2", permissionMode: "read-only" });
  assert.equal(readOnly[readOnly.indexOf("--permission-mode") + 1], "plan");

  const resumed = buildCodebuddyArgs({
    sessionId: "sess-old",
    nativeSessionId: "sess-unused",
    requestedModel: "  glm-5.3  ",
    effort: "high",
    settingsFile: "C:/tmp/settings.json",
    systemPromptFile: "C:/tmp/prompt.md",
  });
  assert.equal(resumed[resumed.indexOf("--resume") + 1], "sess-old");
  assert.equal(resumed.includes("--session-id"), false);
  assert.equal(resumed[resumed.indexOf("--model") + 1], "glm-5.3");
  assert.equal(resumed[resumed.indexOf("--effort") + 1], "high");
  assert.equal(resumed[resumed.indexOf("--settings") + 1], "C:/tmp/settings.json");
  assert.equal(resumed[resumed.indexOf("--system-prompt-file") + 1], "C:/tmp/prompt.md");
});

test("CodeBuddyCliAdapter drives one headless turn over stdin and projects the stream-json events", async () => {
  const { emitted, store } = eventStoreSpy();
  let seenArgs = null;
  const fakeProcess = async (_cmd, args, options = {}) => {
    seenArgs = args;
    assert.equal(options.input, "test prompt");
    assert.equal(options.cwd, repoRoot);
    if (options.onStdout) {
      options.onStdout(`${[
        JSON.stringify({ type: "system", subtype: "init", session_id: "cb-sess-1", model: "glm-5.3" }),
        JSON.stringify({ type: "file-history-snapshot", messageId: "m1" }), // 非对话事件，如实忽略
        JSON.stringify({ type: "assistant", session_id: "cb-sess-1", message: { role: "assistant", content: [{ type: "text", text: "PONG" }] } }),
        JSON.stringify({
          type: "result", subtype: "success", is_error: false, result: "PONG", session_id: "cb-sess-1",
          total_cost_usd: 0, duration_ms: 2174,
          usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 },
        }),
      ].join("\n")}\n`);
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const adapter = new CodeBuddyCliAdapter({ eventStore: store, cwd: repoRoot, runProcessImpl: fakeProcess });
  const submissions = [];
  const response = await adapter.send({
    prompt: "test prompt",
    runId: "run-1",
    timeoutMs: 5_000,
    permissionMode: "plan",
    onSessionStarted: async (payload) => submissions.push(payload),
  });

  assert.equal(seenArgs[seenArgs.indexOf("--permission-mode") + 1], "plan");
  assert.deepEqual(response, {
    sessionId: "cb-sess-1",
    text: "PONG",
    nativePersistence: true,
    protocol: "codebuddy-stream-json",
    requestedModel: null,
    effectiveModel: "glm-5.3",
    costUsd: 0,
    tokens: 19,
  });
  // onSessionStarted 宣告的是命令行请求的会话 id；返回值取 CLI 权威回包（result.session_id）
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].sessionId, seenArgs[seenArgs.indexOf("--session-id") + 1]);
  assert.equal(response.sessionId, "cb-sess-1");
  assert.deepEqual(
    emitted.map((item) => item.type),
    ["prompt.transport", "session.started", "assistant.message", "turn.completed"],
  );
  assert.equal(emitted[0].data.transport ?? emitted[0].data.mode ?? "stdin", "stdin");
  assert.equal(emitted[3].data.tokens, 19);
});

test("CodeBuddyCliAdapter refuses write turns instead of fabricating a permission channel", async () => {
  const { store } = eventStoreSpy();
  const adapter = new CodeBuddyCliAdapter({
    eventStore: store,
    cwd: repoRoot,
    runProcessImpl: async () => { throw new Error("must not spawn"); },
  });
  await assert.rejects(
    () => adapter.send({ prompt: "write a file", runId: "run-1", permissionMode: "workspace-write" }),
    (error) => error.code === "UNSUPPORTED_PERMISSION",
  );
  // native:* 档同样不透传（无许可通道时透传等于绕过治理）
  await assert.rejects(
    () => adapter.send({ prompt: "write a file", runId: "run-1", permissionMode: "native:bypassPermissions" }),
    (error) => error.code === "UNSUPPORTED_PERMISSION",
  );
});

test("CodeBuddyCliAdapter surfaces an error result with resumable native session state", async () => {
  const { store } = eventStoreSpy();
  const fakeProcess = async (_cmd, _args, options = {}) => {
    options.onStdout?.(`${JSON.stringify({
      type: "result", subtype: "error", is_error: true, errors: ["upstream 500"],
      session_id: "cb-sess-err", total_cost_usd: 0,
      usage: { input_tokens: 5, output_tokens: 1 },
    })}\n`);
    return { code: 0, stdout: "", stderr: "" };
  };
  const adapter = new CodeBuddyCliAdapter({ eventStore: store, cwd: repoRoot, runProcessImpl: fakeProcess });
  await assert.rejects(
    () => adapter.send({ prompt: "boom", runId: "run-1" }),
    (error) => {
      assert.equal(error.code, "CODEBUDDY_FAILED");
      assert.equal(error.message, "upstream 500");
      assert.equal(error.nativeTurnSettled, true);
      assert.equal(error.sessionId, "cb-sess-err");
      assert.equal(error.sessionResumable, true);
      return true;
    },
  );
});

test("CodeBuddyCliAdapter maps a login failure to an actionable message", async () => {
  const { store } = eventStoreSpy();
  const adapter = new CodeBuddyCliAdapter({
    eventStore: store,
    cwd: repoRoot,
    runProcessImpl: async () => ({ code: 1, stdout: "", stderr: "Not logged in" }),
  });
  await assert.rejects(
    () => adapter.send({ prompt: "hi", runId: "run-1" }),
    (error) => {
      assert.equal(error.code, "CODEBUDDY_FAILED");
      assert.match(error.message, /CODEBUDDY_API_KEY/);
      return true;
    },
  );
  assert.equal(adapter.canResume(""), false);
  assert.equal(adapter.canResume("cb-sess-1"), true);
  assert.equal(adapter.resumeCommand("cb-sess-1"), "codebuddy -r cb-sess-1");
  assert.equal(adapter.resumeCommand(null), null);
});

test("CodeBuddyCliAdapter implements the required close() lifecycle method", async () => {
  const { store } = eventStoreSpy();
  const adapter = new CodeBuddyCliAdapter({ eventStore: store, cwd: repoRoot });
  assert.equal(typeof adapter.close, "function");
  await assert.doesNotReject(() => adapter.close());
});

test("CodeBuddyCliAdapter passes provider: codebuddy to runProcessImpl and process-runner isolates env", async () => {
  const { inferProcessProvider, childProcessEnv } = await import("../src/process-runner.mjs");
  assert.equal(inferProcessProvider("codebuddy", ["-p", "hi"]), "codebuddy");
  assert.equal(inferProcessProvider("cbc", ["-p", "hi"]), "codebuddy");
  assert.equal(inferProcessProvider("codebuddy.cmd", ["-p", "hi"]), "codebuddy");
  assert.equal(inferProcessProvider("codebuddy", ["--version"]), null);

  const env = childProcessEnv(
    {},
    {
      PATH: "/usr/bin",
      CODEBUDDY_API_KEY: "cb-secret-123",
      CODEBUDDY_AUTH_TOKEN: "cb-token-456",
      OPENAI_API_KEY: "sk-foreign-secret",
      HOME: "/home/user",
    },
    { provider: "codebuddy" },
  );
  assert.equal(env.CODEBUDDY_API_KEY, "cb-secret-123");
  assert.equal(env.CODEBUDDY_AUTH_TOKEN, "cb-token-456");
  assert.equal(env.OPENAI_API_KEY, undefined, "foreign keys must not leak to codebuddy");

  let recordedProvider = null;
  const { store } = eventStoreSpy();
  const adapter = new CodeBuddyCliAdapter({
    eventStore: store,
    cwd: repoRoot,
    runProcessImpl: async (_cmd, _args, options = {}) => {
      recordedProvider = options.provider;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await adapter.send({ prompt: "hello", runId: "run-p1" }).catch(() => {});
  assert.equal(recordedProvider, "codebuddy");
});
