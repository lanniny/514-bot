import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { buildCodexArgs } from "../src/adapters/codex-cli.mjs";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.mjs";
import { buildGeminiArgs } from "../src/adapters/gemini-cli.mjs";
import { buildGrokArgs } from "../src/adapters/grok-build.mjs";
import { buildKimiArgs } from "../src/adapters/kimi-cli.mjs";
import { PiRpcAdapter } from "../src/adapters/pi-rpc.mjs";

const eventStore = { emit: async () => {} };

test("logical member model and effort overrides reach every CLI argument boundary", () => {
  assert.deepEqual(
    buildCodexArgs({ cwd: "C:\\repo", model: "gpt-member", effort: "xhigh" }),
    [
      "exec", "-s", "read-only", "-C", "C:\\repo",
      "-m", "gpt-member",
      "-c", 'model_reasoning_effort="xhigh"',
      "--json", "--skip-git-repo-check", "-",
    ],
  );
  assert.deepEqual(
    buildGeminiArgs({ nativeSessionId: "gemini-session", model: "gemini-member" }),
    [
      "--approval-mode", "plan", "--output-format", "stream-json",
      "--model", "gemini-member",
      "--session-id", "gemini-session",
      "--prompt", "",
    ],
  );
  assert.ok(buildGrokArgs({ prompt: "x", model: "grok-member", effort: "high" }).includes("grok-member"));
  // effort 链路断言：xhigh 必须落到 --reasoning-effort 参数边界（T1 扩档后的最高档）
  const grokXhighArgs = buildGrokArgs({ prompt: "x", model: "grok-member", effort: "xhigh" });
  assert.ok(grokXhighArgs.includes("--reasoning-effort"));
  assert.equal(grokXhighArgs[grokXhighArgs.indexOf("--reasoning-effort") + 1], "xhigh");
  assert.ok(buildKimiArgs({ prompt: "x", model: "kimi-member" }).includes("kimi-member"));
});

test("Codex app-server uses the logical member model when creating its native thread", async () => {
  const adapter = new CodexAppServerAdapter({ eventStore, cwd: "C:\\repo" });
  let request = null;
  adapter.start = async () => {};
  adapter.request = async (method, params) => {
    request = { method, params };
    return { thread: { id: "thread-member" } };
  };

  const threadId = await adapter.createThread({
    permissionMode: "read-only",
    runId: "run-member",
    agentId: "member-builder",
    model: "gpt-member",
  });

  assert.equal(threadId, "thread-member");
  assert.equal(request.method, "thread/start");
  assert.equal(request.params.model, "gpt-member");
});

test("Pi starts each logical member session with that member's model and thinking effort", async () => {
  let spawnArgs = null;
  const spawnImpl = (_command, args) => {
    spawnArgs = args;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = { write: () => true };
    return child;
  };
  const adapter = new PiRpcAdapter({ eventStore, cwd: "C:\\repo", spawnImpl });
  const sessionId = await adapter.createSession("run-member", null, "member-pi", "pi-member-model", "xhigh");

  assert.ok(spawnArgs.includes("--model"));
  assert.equal(spawnArgs[spawnArgs.indexOf("--model") + 1], "pi-member-model");
  assert.ok(spawnArgs.includes("--thinking"));
  assert.equal(spawnArgs[spawnArgs.indexOf("--thinking") + 1], "xhigh");
  assert.equal(adapter.processes.get(sessionId).agentId, "member-pi");
  assert.equal(adapter.processes.get(sessionId).model, "pi-member-model");
  assert.equal(adapter.processes.get(sessionId).effort, "xhigh");
  adapter.processes.clear();
});
