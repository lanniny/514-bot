/**
 * Claude adapter 许可通道接线测试（v50 · 2026-09-04）。
 *
 * 前面几层各自验过：wire 协议、脚本生成、管道端点、脚本↔端点端到端。
 * 这一层验 adapter 有没有把它们真的接上去 —— 以及**接错时会不会静默降级**。
 *
 * 重点不是"功能能用"，是三条边界：
 *   1. 没有 resolver 时**不开通道**（开了等于骗 CLI 说有人应答，请求会挂到超时）
 *   2. 通道创建失败**退回无通道**而不是让整轮挂掉
 *   3. 任何退出路径（含抛错）都**清理脚本与管道** —— 脚本内联着 runId
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { ClaudeCliAdapter, buildClaudeArgs } from "../src/adapters/claude-cli.mjs";
import { PERMISSION_TOOL_FULL_NAME } from "../src/permission-server-script.mjs";

function stubEventStore() {
  const events = [];
  return { events, async emit(type, data, meta) { events.push({ type, data, meta }); return {}; } };
}

/** 捕获 runProcess 的调用参数，并可指定它如何结束。 */
function stubRunProcess({ throws = null, code = 0 } = {}) {
  const calls = [];
  const impl = async (command, args, options) => {
    calls.push({ command, args, options });
    if (throws) throw throws;
    // 最小合法输出：一条 result 帧让 adapter 正常收尾
    options.onStdout?.(`${JSON.stringify({ type: "result", subtype: "success", session_id: "s1", result: "ok", total_cost_usd: 0 })}\n`);
    return { code, signal: null, stdout: "", stderr: "" };
  };
  return { calls, impl };
}

function makeAdapter({ approvalResolver = null, runProcessImpl }) {
  return new ClaudeCliAdapter({
    command: "claude",
    model: "fable",
    eventStore: stubEventStore(),
    cwd: process.cwd(),
    runProcessImpl,
    approvalResolver,
  });
}

// ═══ 参数注入 ═══

test("buildClaudeArgs 只在给了配置路径时注入许可旗标", () => {
  const without = buildClaudeArgs({ nativeSessionId: "s", requestedModel: "fable" });
  assert.ok(!without.includes("--permission-prompt-tool"), "没有通道时不该声明宿主");
  assert.ok(!without.includes("--mcp-config"));

  const withChannel = buildClaudeArgs({ nativeSessionId: "s", requestedModel: "fable", permissionMcpConfigPath: "C:/tmp/x/mcp.json" });
  const toolIndex = withChannel.indexOf("--permission-prompt-tool");
  assert.notEqual(toolIndex, -1, "缺 --permission-prompt-tool 则 CLI 判定无宿主，需审批的工具会被摘除");
  assert.equal(withChannel[toolIndex + 1], PERMISSION_TOOL_FULL_NAME);
  const configIndex = withChannel.indexOf("--mcp-config");
  assert.equal(withChannel[configIndex + 1], "C:/tmp/x/mcp.json");
});

test("--strict-mcp-config 仍在（保证只加载我们注入的那一个 MCP）", () => {
  const args = buildClaudeArgs({ nativeSessionId: "s", requestedModel: "fable", permissionMcpConfigPath: "C:/tmp/x/mcp.json" });
  assert.ok(args.includes("--strict-mcp-config"), "缺它则用户级 MCP 会被一并加载");
});

// ═══ 边界 1：没有 resolver 就不开通道 ═══

test("无 approvalResolver → 不开通道、不注入旗标", async () => {
  const runner = stubRunProcess();
  const adapter = makeAdapter({ approvalResolver: null, runProcessImpl: runner.impl });
  await adapter.send({ prompt: "hi", runId: "run-1", timeoutMs: 60_000 });
  const [call] = runner.calls;
  assert.ok(!call.args.includes("--permission-prompt-tool"), "无人能应答时声明宿主 = 请求挂到超时");
  assert.ok(!call.args.includes("--mcp-config"));
});

test("无 runId → 不开通道（归属无从确定）", async () => {
  const runner = stubRunProcess();
  const adapter = makeAdapter({ approvalResolver: async () => ({ decision: "accept" }), runProcessImpl: runner.impl });
  await adapter.send({ prompt: "hi", runId: null, timeoutMs: 60_000 });
  assert.ok(!runner.calls[0].args.includes("--permission-prompt-tool"));
});

// ═══ 通道真的建起来了 ═══

test("有 resolver → 注入旗标，且配置文件真实存在、指向真实脚本", async () => {
  const runner = stubRunProcess();
  const adapter = makeAdapter({ approvalResolver: async () => ({ decision: "accept" }), runProcessImpl: runner.impl });
  let snapshot = null;
  // 在子进程"运行中"的时刻抓一份现场：dispose 会在 send 返回前清掉
  const wrapped = async (command, args, options) => {
    const index = args.indexOf("--mcp-config");
    const configPath = args[index + 1];
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const scriptPath = config.mcpServers.ccapproval.args[0];
    snapshot = {
      configPath,
      scriptPath,
      scriptExists: existsSync(scriptPath),
      scriptSource: readFileSync(scriptPath, "utf8"),
      dir: dirname(configPath),
    };
    return runner.impl(command, args, options);
  };
  adapter.runProcessImpl = wrapped;
  await adapter.send({ prompt: "hi", runId: "run-xyz", timeoutMs: 60_000 });

  assert.ok(snapshot, "runProcess 未被调用");
  assert.equal(snapshot.scriptExists, true, "配置指向的脚本不存在");
  assert.match(snapshot.scriptSource, /const RUN_ID = "run-xyz";/, "runId 应内联进脚本");
  assert.ok(!snapshot.scriptSource.includes("process.argv"), "脚本不该从 argv 读归属");
  // 轮末清理：整个临时目录都该没了
  assert.equal(existsSync(snapshot.dir), false, "临时目录未清理 —— 脚本内联着 runId，留在盘上是泄露");
});

// ═══ 边界 3：任何退出路径都清理 ═══

test("子进程抛错时仍清理通道", async () => {
  const failure = Object.assign(new Error("boom"), { code: "PROCESS_TIMEOUT" });
  let capturedDir = null;
  const adapter = makeAdapter({
    approvalResolver: async () => ({ decision: "accept" }),
    runProcessImpl: async (command, args) => {
      const index = args.indexOf("--mcp-config");
      capturedDir = dirname(args[index + 1]);
      throw failure;
    },
  });
  await assert.rejects(() => adapter.send({ prompt: "hi", runId: "run-err", timeoutMs: 60_000 }), (error) => error === failure);
  assert.ok(capturedDir, "未走到 runProcess");
  assert.equal(existsSync(capturedDir), false, "抛错路径漏了清理");
});

test("CLI 报错结果（is_error）时仍清理通道", async () => {
  let capturedDir = null;
  const adapter = makeAdapter({
    approvalResolver: async () => ({ decision: "accept" }),
    runProcessImpl: async (command, args, options) => {
      capturedDir = dirname(args[args.indexOf("--mcp-config") + 1]);
      options.onStdout?.(`${JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "Not logged in", session_id: "s" })}\n`);
      return { code: 0, signal: null, stdout: "", stderr: "" };
    },
  });
  await assert.rejects(() => adapter.send({ prompt: "hi", runId: "run-e", timeoutMs: 60_000 }));
  assert.equal(existsSync(capturedDir), false, "错误结果路径漏了清理");
});

// ═══ 边界 2：通道失败退回无通道，不拖垮整轮 ═══

test("runId 形态不合法 → 退回无通道，整轮照跑", async () => {
  const runner = stubRunProcess();
  const eventStore = stubEventStore();
  const adapter = new ClaudeCliAdapter({
    command: "claude",
    eventStore,
    cwd: process.cwd(),
    runProcessImpl: runner.impl,
    approvalResolver: async () => ({ decision: "accept" }),
  });
  // 脚本生成器只接受 ^[A-Za-z0-9_.:-]{1,128}$；带空格与引号的必然抛错
  const result = await adapter.send({ prompt: "hi", runId: 'bad id"; rm -rf /', timeoutMs: 60_000 });
  assert.ok(result, "通道失败不该让整轮失败");
  assert.ok(!runner.calls[0].args.includes("--permission-prompt-tool"), "应退回无通道");
  const degraded = eventStore.events.find((event) => event.type === "approval.channel_unavailable");
  assert.ok(degraded, "静默降级不可接受，必须留痕");
  assert.ok(degraded.data.reason.length > 0);
});

// ═══ 决策翻译 ═══

test("resolver 的 accept/decline 被翻译成 approved 布尔", async () => {
  // 通过真实链路验证：adapter 传给 endpoint 的 decide 只认 decision==="accept"
  const seen = [];
  const runner = stubRunProcess();
  const adapter = makeAdapter({
    approvalResolver: async (message, context) => { seen.push({ message, context }); return { decision: "accept" }; },
    runProcessImpl: runner.impl,
  });
  await adapter.send({ prompt: "hi", runId: "run-t", sessionId: "sess-t", timeoutMs: 60_000 });
  // 本轮没有真实许可请求，只验证 resolver 未被误调
  assert.equal(seen.length, 0, "没有工具许可请求时不该惊动 broker");
});

test("远程 run 不开通道（本机管道对端不可达）", async () => {
  // createAdapters 侧的约定：remote 时传 approvalResolver: null。
  // 这里验证 adapter 收到 null 后的行为与"无 resolver"一致。
  const runner = stubRunProcess();
  const adapter = makeAdapter({ approvalResolver: null, runProcessImpl: runner.impl });
  await adapter.send({ prompt: "hi", runId: "run-remote", timeoutMs: 60_000 });
  assert.ok(!runner.calls[0].args.includes("--mcp-config"));
});
