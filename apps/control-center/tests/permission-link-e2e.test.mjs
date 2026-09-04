/**
 * 许可链路端到端集成测试（v50 · 2026-09-04）。
 *
 * 前两个测试文件各测一半：
 *   `permission-server-script.test.mjs` —— 脚本生成 + 内核不可达时 fail-closed
 *   `permission-endpoint.test.mjs`      —— 管道端点 + 各类拒绝路径
 *
 * 但两半接得上吗？这个文件真跑一遍完整链路：
 *   起端点 → 生成指向它的脚本 → spawn 脚本当 MCP server → 发 tools/call
 *   → 脚本连管道 → 端点问 decide → 应答回流 → 校验 PPT 线格式
 *
 * 不做这一步就只能说"两个零件各自能转"，说不了"装起来能用"。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPermissionEndpoint } from "../src/permission-endpoint.mjs";
import { buildPermissionServerSource } from "../src/permission-server-script.mjs";

const RUN = "run-e2e-1";

/** 起完整链路：端点 + 作为 MCP server 跑起来的生成脚本。 */
async function withLink({ decide, timeoutMs = 300_000 }, body) {
  const dir = mkdtempSync(join(tmpdir(), "ppt-e2e-"));
  const endpoint = createPermissionEndpoint({
    runId: RUN,
    sessionId: "sess-e2e",
    agentId: "claude-fable",
    decide,
    decisionTimeoutMs: timeoutMs,
  });
  await endpoint.ready;

  const scriptPath = join(dir, "server.mjs");
  writeFileSync(scriptPath, buildPermissionServerSource({
    runId: RUN,
    sessionId: "sess-e2e",
    endpointPath: endpoint.path,
    timeoutMs,
  }), "utf8");

  const child = spawn(process.execPath, [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
  const replies = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line) { try { replies.push(JSON.parse(line)); } catch {} }
    }
  });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = (id, ms = 15_000) => new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      const found = replies.find((reply) => reply.id === id);
      if (found) return resolve(found);
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for id=${id}`));
      setTimeout(tick, 20);
    };
    tick();
  });

  /** 走一次完整的许可请求，返回解析后的 PPT payload。 */
  const requestPermission = async (id, args) => {
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "prompt", arguments: args } });
    const reply = await waitFor(id);
    assert.equal(reply.result.content.length, 1, "CLI 只读 content[0]，多 block 会被静默丢弃");
    assert.equal(reply.result.content[0].type, "text");
    return JSON.parse(reply.result.content[0].text);
  };

  try {
    // 先完成 MCP 握手，与真实 CLI 的启动顺序一致
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await waitFor(1);
    return await body({ requestPermission, endpoint, send, waitFor });
  } finally {
    try { child.kill(); } catch {}
    await endpoint.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("端到端·批准：操作者点批准 → CLI 收到合法 allow", async () => {
  const seen = [];
  await withLink({ decide: async (request) => { seen.push(request); return { approved: true }; } }, async ({ requestPermission }) => {
    const payload = await requestPermission(2, {
      tool_name: "Write",
      input: { file_path: "I:/x/y.txt", content: "hello" },
      tool_use_id: "toolu_ok",
    });
    assert.equal(payload.behavior, "allow");
    assert.equal(payload.toolUseID, "toolu_ok", "响应侧是 toolUseID（大小写与请求侧相反）");
    assert.equal(payload.decisionClassification, "user_temporary");
    // v1 禁用字段一个都不能出现
    for (const forbidden of ["updatedInput", "updatedPermissions", "interrupt"]) {
      assert.ok(!(forbidden in payload), `v1 禁用字段泄漏：${forbidden}`);
    }
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].toolName, "Write");
  assert.deepEqual(seen[0].input, { file_path: "I:/x/y.txt", content: "hello" }, "审批卡要看到真实参数");
  assert.equal(seen[0].runId, RUN, "归属来自内核");
});

test("端到端·拒绝：原因一路送到 CLI（模型据此调整而非盲目重试）", async () => {
  await withLink({ decide: async () => ({ approved: false, message: "这条会写到仓库外，先确认路径" }) }, async ({ requestPermission }) => {
    const payload = await requestPermission(2, { tool_name: "Bash", input: { command: "rm -rf /tmp/x" }, tool_use_id: "toolu_no" });
    assert.equal(payload.behavior, "deny");
    assert.equal(payload.message, "这条会写到仓库外，先确认路径");
    assert.equal(payload.decisionClassification, "user_reject");
    assert.ok(!("interrupt" in payload), "拒绝单工具不该掐掉整轮会话");
  });
});

test("端到端·连续多次请求各自独立结算", async () => {
  const decisions = [true, false, true];
  let index = 0;
  await withLink({ decide: async () => ({ approved: decisions[index++], message: "no" }) }, async ({ requestPermission }) => {
    const first = await requestPermission(2, { tool_name: "A", input: {}, tool_use_id: "t1" });
    const second = await requestPermission(3, { tool_name: "B", input: {}, tool_use_id: "t2" });
    const third = await requestPermission(4, { tool_name: "C", input: {}, tool_use_id: "t3" });
    assert.equal(first.behavior, "allow");
    assert.equal(second.behavior, "deny");
    assert.equal(third.behavior, "allow");
    assert.equal(first.toolUseID, "t1");
    assert.equal(second.toolUseID, "t2");
    assert.equal(third.toolUseID, "t3");
  });
});

test("端到端·端点中途关闭 → 后续请求拒绝而非挂起", async () => {
  await withLink({ decide: async () => ({ approved: true }) }, async ({ requestPermission, endpoint }) => {
    const before = await requestPermission(2, { tool_name: "A", input: {}, tool_use_id: "t1" });
    assert.equal(before.behavior, "allow");
    await endpoint.close();
    const after = await requestPermission(3, { tool_name: "B", input: {}, tool_use_id: "t2" });
    assert.equal(after.behavior, "deny", "内核不可达必须拒绝");
    assert.ok(after.message.length > 0);
  });
});

test("端到端·decide 挂死 → 有界拒绝（不让整轮撞 CLI 进程超时）", async () => {
  const started = Date.now();
  await withLink({ decide: () => new Promise(() => {}), timeoutMs: 500 }, async ({ requestPermission }) => {
    const payload = await requestPermission(2, { tool_name: "A", input: {}, tool_use_id: "t1" });
    assert.equal(payload.behavior, "deny");
    assert.match(payload.message, /时限/);
  });
  assert.ok(Date.now() - started < 12_000, "超时未生效");
});

test("端到端·结构损坏的请求在脚本侧就被拒（不惊动操作者）", async () => {
  let called = false;
  await withLink({ decide: async () => { called = true; return { approved: true }; } }, async ({ requestPermission }) => {
    // 缺 tool_name：审批卡显示不出工具名，不该让人批
    const payload = await requestPermission(2, { input: { command: "ls" }, tool_use_id: "t1" });
    assert.equal(payload.behavior, "deny");
    assert.match(payload.message, /结构损坏/);
  });
  assert.equal(called, false, "损坏请求不该走到操作者面前");
});

test("端到端·沙箱谎报归属无效（脚本内联常量才算数）", async () => {
  const seen = [];
  await withLink({ decide: async (request) => { seen.push(request); return { approved: true }; } }, async ({ requestPermission }) => {
    // 请求里塞入伪造归属字段 —— 脚本按内联常量上报，这些应被忽略
    await requestPermission(2, {
      tool_name: "Write",
      input: { runId: "run-evil", sessionId: "sess-evil" },
      tool_use_id: "t1",
    });
  });
  assert.equal(seen[0].runId, RUN);
  assert.equal(seen[0].sessionId, "sess-e2e");
});
