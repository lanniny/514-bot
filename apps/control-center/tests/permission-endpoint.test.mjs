/**
 * 许可端点契约测试（v50 · 2026-09-04）。
 *
 * 全部走**真实管道**：真 listen、真 connect、真收发帧。
 * 静态断言挡不住"管道其实没起来"或"超时其实会挂死"这类问题。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { connect } from "node:net";

import {
  createPermissionEndpoint,
  permissionEndpointPath,
  DEFAULT_DECISION_TIMEOUT_MS,
  DEFAULT_MAX_REQUESTS_PER_RUN,
} from "../src/permission-endpoint.mjs";

/** 连上端点发一帧，拿回应答。 */
function ask(path, frame, { timeoutMs = 8_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("ask timed out")); }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index === -1) return;
      clearTimeout(timer);
      socket.destroy();
      try { resolve(JSON.parse(buffer.slice(0, index))); } catch (error) { reject(error); }
    });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    socket.write(`${JSON.stringify(frame)}\n`);
  });
}

/** 起一个端点并保证测试结束时关闭。 */
async function withEndpoint(options, body) {
  const endpoint = createPermissionEndpoint(options);
  await endpoint.ready;
  try { return await body(endpoint); } finally { await endpoint.close(); }
}

const RUN = "run-test-1";
const base = (decide) => ({ runId: RUN, sessionId: "sess-1", agentId: "claude-fable", decide });

test("端点路径含随机段且不可预测", () => {
  const a = permissionEndpointPath(RUN);
  const b = permissionEndpointPath(RUN);
  assert.notEqual(a, b, "两次生成的路径相同 —— 可预测的路径不能当能力凭证");
  assert.ok(a.includes(RUN), "路径应含 runId 便于排障");
  if (process.platform === "win32") assert.match(a, /^\\\\\.\\pipe\\/);
});

test("路径里的 runId 被清洗（不可注入路径分隔符）", () => {
  const path = permissionEndpointPath("../../evil\\x");
  assert.ok(!path.includes(".."), `路径含 ..：${path}`);
  // 清洗后只剩安全字符，随机段仍在
  assert.match(path, /cc-approval-[A-Za-z0-9_-]*-[0-9a-f]{24}/);
});

test("缺 runId 或 decide 直接拒绝构造", () => {
  assert.throws(() => createPermissionEndpoint({ decide: () => ({ approved: true }) }), (error) => error.code === "INVALID_PERMISSION_ENDPOINT");
  assert.throws(() => createPermissionEndpoint({ runId: RUN }), (error) => error.code === "INVALID_PERMISSION_ENDPOINT");
});

test("批准路径：decide 返回 approved → decision approve", async () => {
  await withEndpoint(base(async () => ({ approved: true })), async (endpoint) => {
    const reply = await ask(endpoint.path, { runId: RUN, toolName: "Bash", input: { command: "ls" }, toolUseId: "toolu_1" });
    assert.deepEqual(reply, { decision: "approve" });
    assert.equal(endpoint.servedCount, 1);
  });
});

test("拒绝路径：原因原样带回（模型要看到它才不会盲目重试）", async () => {
  await withEndpoint(base(async () => ({ approved: false, message: "这条命令会删掉构建产物" })), async (endpoint) => {
    const reply = await ask(endpoint.path, { runId: RUN, toolName: "Bash", input: {}, toolUseId: "t" });
    assert.equal(reply.decision, "deny");
    assert.equal(reply.message, "这条命令会删掉构建产物");
  });
});

test("decide 收到的归属来自内核，不是请求自称", async () => {
  let seen = null;
  await withEndpoint(base(async (request) => { seen = request; return { approved: true }; }), async (endpoint) => {
    await ask(endpoint.path, {
      runId: RUN,
      sessionId: "SANDBOX-LIES",   // 沙箱谎报
      agentId: "SANDBOX-LIES",
      toolName: "Write",
      input: { file_path: "x" },
      toolUseId: "toolu_2",
    });
  });
  assert.equal(seen.runId, RUN);
  assert.equal(seen.sessionId, "sess-1", "sessionId 应取内核记住的，不是请求里的");
  assert.equal(seen.agentId, "claude-fable", "agentId 同上");
});

test("runId 不符直接拒绝（拿别轮脚本来连）", async () => {
  let called = false;
  await withEndpoint(base(async () => { called = true; return { approved: true }; }), async (endpoint) => {
    const reply = await ask(endpoint.path, { runId: "run-other", toolName: "Bash", input: {} });
    assert.equal(reply.decision, "deny");
    assert.match(reply.message, /归属/);
  });
  assert.equal(called, false, "归属不符时不该惊动操作者");
});

test("input 非对象/数组被归一，不透传给审批卡", async () => {
  const seen = [];
  await withEndpoint(base(async (request) => { seen.push(request.input); return { approved: false }; }), async (endpoint) => {
    for (const bad of ["str", 42, [1, 2], null]) {
      await ask(endpoint.path, { runId: RUN, toolName: "T", input: bad });
    }
  });
  for (const input of seen) {
    assert.equal(typeof input, "object");
    assert.ok(!Array.isArray(input), "数组会让审批卡把 [0]/[1] 当参数名");
  }
});

// ═══ fail-closed ═══

test("decide 抛错 → 拒绝，不放行", async () => {
  await withEndpoint(base(async () => { throw new Error("broker exploded"); }), async (endpoint) => {
    const reply = await ask(endpoint.path, { runId: RUN, toolName: "Bash", input: {} });
    assert.equal(reply.decision, "deny");
    assert.ok(reply.message.length > 0);
  });
});

test("decide 返回垃圾 → 拒绝（只有显式 approved===true 才算批准）", async () => {
  for (const garbage of [null, undefined, {}, { approved: "yes" }, { approved: 1 }, "approve", { decision: "approve" }]) {
    await withEndpoint(base(async () => garbage), async (endpoint) => {
      const reply = await ask(endpoint.path, { runId: RUN, toolName: "Bash", input: {} });
      assert.equal(reply.decision, "deny", `未拦住 ${JSON.stringify(garbage)}`);
    });
  }
});

test("decide 超时 → 有界拒绝，不挂起", async () => {
  const started = Date.now();
  await withEndpoint({
    ...base(() => new Promise(() => {})),   // 永不 resolve
    decisionTimeoutMs: 300,
  }, async (endpoint) => {
    const reply = await ask(endpoint.path, { runId: RUN, toolName: "Bash", input: {} }, { timeoutMs: 5_000 });
    assert.equal(reply.decision, "deny");
    assert.match(reply.message, /时限/);
  });
  assert.ok(Date.now() - started < 4_000, "超时未生效，请求被挂住了");
});

test("超过本轮请求上限 → 拒绝（防洪水淹没审批队列）", async () => {
  await withEndpoint({ ...base(async () => ({ approved: true })), maxRequests: 2 }, async (endpoint) => {
    assert.equal((await ask(endpoint.path, { runId: RUN, toolName: "A", input: {} })).decision, "approve");
    assert.equal((await ask(endpoint.path, { runId: RUN, toolName: "B", input: {} })).decision, "approve");
    const third = await ask(endpoint.path, { runId: RUN, toolName: "C", input: {} });
    assert.equal(third.decision, "deny");
    assert.match(third.message, /上限/);
  });
});

test("超大帧 → 拒绝，不进内存", async () => {
  await withEndpoint(base(async () => ({ approved: true })), async (endpoint) => {
    const huge = { runId: RUN, toolName: "Bash", input: { command: "x".repeat(300 * 1024) } };
    const reply = await ask(endpoint.path, huge);
    assert.equal(reply.decision, "deny");
    assert.match(reply.message, /体积/);
  });
});

test("损坏帧 → 拒绝，不崩", async () => {
  await withEndpoint(base(async () => ({ approved: true })), async (endpoint) => {
    const reply = await new Promise((resolve, reject) => {
      const socket = connect(endpoint.path);
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        const index = buffer.indexOf("\n");
        if (index !== -1) { socket.destroy(); resolve(JSON.parse(buffer.slice(0, index))); }
      });
      socket.on("error", reject);
      socket.write("{ not json at all\n");
    });
    assert.equal(reply.decision, "deny");
  });
});

// ═══ 生命周期 ═══

test("close 之后端点不再接受连接", async () => {
  const endpoint = createPermissionEndpoint(base(async () => ({ approved: true })));
  await endpoint.ready;
  await endpoint.close();
  await assert.rejects(() => ask(endpoint.path, { runId: RUN, toolName: "A", input: {} }, { timeoutMs: 2_000 }));
});

test("close 可重入（轮末清理不该因重复调用而抛）", async () => {
  const endpoint = createPermissionEndpoint(base(async () => ({ approved: true })));
  await endpoint.ready;
  await endpoint.close();
  await endpoint.close();
});

test("拒绝事件被上报（看不见的拒绝等于没有拒绝）", async () => {
  const events = [];
  await withEndpoint({
    ...base(async () => ({ approved: true })),
    emit: (type, data) => events.push({ type, data }),
  }, async (endpoint) => {
    await ask(endpoint.path, { runId: "run-wrong", toolName: "A", input: {} });
  });
  const rejected = events.find((event) => event.type === "approval.endpoint_rejected");
  assert.ok(rejected, "归属不符应留痕");
  assert.equal(rejected.data.reason, "run_mismatch");
  assert.equal(rejected.data.runId, RUN, "事件应带内核侧归属");
});

test("默认上限是有限值（无上限等于没有上限）", () => {
  assert.ok(Number.isSafeInteger(DEFAULT_MAX_REQUESTS_PER_RUN) && DEFAULT_MAX_REQUESTS_PER_RUN > 0);
  assert.ok(Number.isSafeInteger(DEFAULT_DECISION_TIMEOUT_MS) && DEFAULT_DECISION_TIMEOUT_MS > 0);
});
