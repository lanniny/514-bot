/**
 * 许可 MCP server 脚本生成器契约测试（v50 · 2026-09-04）。
 *
 * ── 守什么 ──
 * 1. **归属不可伪造**（烛 S-2）：runId 内联为脚本常量，不出现在 argv、不从请求读
 * 2. **必须走闸**（烛 S-4）：脚本自身逻辑区不得手搓 `behavior:` 字面量，
 *    只能经 `allowResponse`/`denyResponse`/`toolResultFor` 过 v1 闸
 * 3. **fail-closed**：内核不可达 / 超时 / 非批准 → 拒绝，绝不放行
 *
 * 第 2 条尤其重要：`toolResultFor` 是唯一**封装**出口，却不是唯一**物理**出口 ——
 * 脚本完全可以自己 `JSON.stringify({behavior:"allow", updatedPermissions:[...]})`
 * 把整个 v1 闸绕过去。取证探针现在就是这么写的（无妨，它不是产品代码），
 * 但产品脚本若照抄那个形状，闸门形同虚设。所以这里用分界标记做机械断言。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildPermissionServerSource,
  PERMISSION_MCP_SERVER_NAME,
  PERMISSION_TOOL_FULL_NAME,
  SCRIPT_LOGIC_MARKER,
} from "../src/permission-server-script.mjs";

const BASE = { runId: "run-abc123", sessionId: "sess-xyz789", endpointPath: "\\\\.\\pipe\\cc-test-endpoint" };

/** 把脚本切成「内联的 wire 模块」与「脚本自身逻辑」两段。 */
function splitScript(source) {
  const index = source.indexOf(SCRIPT_LOGIC_MARKER);
  assert.notEqual(index, -1, "生成的脚本缺少逻辑区分界标记");
  return { wire: source.slice(0, index), logic: source.slice(index) };
}

// ═══ 归属：runId 内联，沙箱无法谎报 ═══

test("runId / sessionId 内联为脚本常量", () => {
  const source = buildPermissionServerSource(BASE);
  assert.match(source, /const RUN_ID = "run-abc123";/);
  assert.match(source, /const SESSION_ID = "sess-xyz789";/);
});

test("脚本不从 argv 读任何归属信息（argv 在 Windows 上可被同用户进程读取）", () => {
  const { logic } = splitScript(buildPermissionServerSource(BASE));
  assert.ok(!/process\.argv/.test(logic), "脚本逻辑区读了 argv —— 归属应只来自内联常量");
  assert.ok(!/process\.env/.test(logic), "脚本逻辑区读了 env —— 同上");
});

test("归属随每个请求上报内核，且取自常量而非请求内容", () => {
  const { logic } = splitScript(buildPermissionServerSource(BASE));
  assert.match(logic, /runId:\s*RUN_ID/, "上报的 runId 应是内联常量");
  assert.match(logic, /sessionId:\s*SESSION_ID/);
  // 不得有任何从入站参数取 runId 的路径
  assert.ok(!/runId:\s*(?:parsed|message|params|request)\b/.test(logic), "runId 不得来自请求（沙箱可谎报）");
});

test("拒绝不安全的标识符（它们会被内联进源码）", () => {
  for (const bad of ['a"; process.exit(1); //', "a\nb", "", "x".repeat(200), null, 42]) {
    assert.throws(
      () => buildPermissionServerSource({ ...BASE, runId: bad }),
      (error) => error.code === "INVALID_PPT_SERVER_CONFIG",
      `未拦住 runId=${JSON.stringify(bad)}`,
    );
  }
  assert.throws(() => buildPermissionServerSource({ ...BASE, endpointPath: "" }), (error) => error.code === "INVALID_PPT_SERVER_CONFIG");
  assert.throws(() => buildPermissionServerSource({ ...BASE, timeoutMs: 0 }), (error) => error.code === "INVALID_PPT_SERVER_CONFIG");
  assert.throws(() => buildPermissionServerSource({ ...BASE, timeoutMs: -1 }), (error) => error.code === "INVALID_PPT_SERVER_CONFIG");
});

// ═══ 必须走闸（烛 S-4 的机械承载）═══

test("脚本逻辑区不出现任何 behavior 字面量 —— 只能经构造函数过闸", () => {
  const { logic } = splitScript(buildPermissionServerSource(BASE));
  const handMade = logic.match(/behavior\s*:\s*["']/g);
  assert.equal(handMade, null, `脚本逻辑区手搓了 behavior 字面量：${handMade?.join(", ")}`);
});

test("脚本逻辑区的每次响应都经 toolResultFor", () => {
  const { logic } = splitScript(buildPermissionServerSource(BASE));
  // tools/call 分支的所有 result 都必须是 toolResultFor(...) 的产物
  const callResults = logic.match(/id,\s*result:\s*([A-Za-z_$][\w$]*)\(/g) ?? [];
  for (const match of callResults) {
    assert.match(match, /toolResultFor\(/, `有响应绕过了 toolResultFor：${match}`);
  }
  assert.ok(callResults.length >= 2, `toolResultFor 调用点太少（${callResults.length}），可能有分支漏网`);
});

test("内联的是真 wire 模块（含 v1 闸），不是简化副本", () => {
  const { wire } = splitScript(buildPermissionServerSource(BASE));
  for (const marker of ["V1_FORBIDDEN_RESPONSE_FIELDS", "V1_ALLOWED_RESPONSE_FIELDS", "V1_ALLOWED_CLASSIFICATIONS", "function assertV1Response", "PPT_V1_FORBIDDEN_FIELD"]) {
    assert.ok(wire.includes(marker), `内联的 wire 模块缺少 ${marker}`);
  }
  // export 被剥掉才能内联进单文件
  assert.ok(!/^export /m.test(wire), "内联区仍含 export，脚本无法作为单文件运行");
});

// ═══ fail-closed ═══

test("内核不可达 / 超时 → 拒绝，不放行", () => {
  const { logic } = splitScript(buildPermissionServerSource(BASE));
  // 只有 verdict.decision === "approve" 才走 allowResponse
  assert.match(logic, /verdict\?\.decision === "approve"/);
  assert.match(logic, /approved\s*\?\s*allowResponse/, "批准路径应由 approved 唯一决定");
  // socket error/close/timeout 全部 resolve(null)，null 落到拒绝分支
  for (const handler of ["error", "close"]) {
    assert.ok(logic.includes(`on("${handler}"`), `缺少 socket ${handler} 处理 —— 断连会挂起`);
  }
});

test("结构损坏的请求直接拒绝（审批卡显示不出工具名就不该让人批）", () => {
  const { logic } = splitScript(buildPermissionServerSource(BASE));
  assert.match(logic, /catch\s*{[\s\S]{0,200}denyResponse/, "parsePermissionRequest 抛错后应立即拒绝");
});

test("v1 只上报 user_temporary / user_reject（不谎称永久允许）", () => {
  const { logic } = splitScript(buildPermissionServerSource(BASE));
  assert.match(logic, /decisionClassification:\s*"user_temporary"/);
  assert.match(logic, /decisionClassification:\s*"user_reject"/);
  assert.ok(!logic.includes("user_permanent"), "v1 无持久化能力，不得上报 user_permanent");
});

// ═══ 生成物可运行 ═══

test("生成的脚本能作为真 MCP server 完成握手并 fail-closed 拒绝", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ppt-script-"));
  try {
    const scriptPath = join(dir, "server.mjs");
    // 指向一个不存在的端点：内核不可达，必须拒绝而不是放行或挂起
    writeFileSync(scriptPath, buildPermissionServerSource({
      ...BASE,
      endpointPath: join(dir, "no-such-endpoint.sock"),
      timeoutMs: 2_000,
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
        if (line) replies.push(JSON.parse(line));
      }
    });
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const waitFor = (id, ms) => new Promise((resolve, reject) => {
      const deadline = Date.now() + ms;
      const tick = () => {
        const found = replies.find((reply) => reply.id === id);
        if (found) return resolve(found);
        if (Date.now() > deadline) return reject(new Error(`timeout waiting for id=${id}`));
        setTimeout(tick, 25);
      };
      tick();
    });

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    const init = await waitFor(1, 5_000);
    assert.equal(init.result.serverInfo.name, "control-center-approval");

    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await waitFor(2, 5_000);
    assert.equal(list.result.tools.length, 1);
    assert.equal(list.result.tools[0].name, "prompt");
    assert.ok(list.result.tools[0].inputSchema, "守卫2：无 inputJSONSchema 则 CLI 启动即 exit 1");

    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "prompt", arguments: { tool_name: "Bash", input: { command: "rm -rf /" }, tool_use_id: "toolu_x" } } });
    const call = await waitFor(3, 10_000);
    const payload = JSON.parse(call.result.content[0].text);
    assert.equal(payload.behavior, "deny", "内核不可达时必须拒绝");
    assert.ok(payload.message.length > 0, "拒绝必须带原因，否则模型盲目重试");
    assert.equal(payload.toolUseID, "toolu_x");
    assert.ok(!("updatedPermissions" in payload) && !("updatedInput" in payload), "v1 禁用字段不得出现");

    child.kill();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("工具全名符合 CLI 要求的 mcp__<server>__<tool> 形状", () => {
  assert.equal(PERMISSION_TOOL_FULL_NAME, `mcp__${PERMISSION_MCP_SERVER_NAME}__prompt`);
  assert.match(PERMISSION_TOOL_FULL_NAME, /^mcp__[a-z0-9-]+__[a-z]+$/);
});

// ═══ 元验收 ═══

test("元验收：往逻辑区手搓 behavior，守卫必须发现", () => {
  const source = buildPermissionServerSource(BASE);
  const tampered = source.replace(
    SCRIPT_LOGIC_MARKER,
    `${SCRIPT_LOGIC_MARKER}\nconst sneaky = { behavior: "allow", updatedPermissions: [] };`,
  );
  const { logic } = splitScript(tampered);
  assert.notEqual(logic.match(/behavior\s*:\s*["']/g), null, "前提：篡改后应能被正则捕获");
  // 真实产物必须干净
  assert.equal(splitScript(source).logic.match(/behavior\s*:\s*["']/g), null);
});

test("元验收：抽掉 v1 闸，内联检查必须发现", () => {
  const source = buildPermissionServerSource(BASE);
  const gutted = source.replace(/const V1_FORBIDDEN_RESPONSE_FIELDS[\s\S]*?\}\);/, "const V1_FORBIDDEN_RESPONSE_FIELDS = {};");
  const { wire } = splitScript(gutted);
  assert.ok(!wire.includes('updatedPermissions: "会写入'), "前提：掏空后禁用理由应消失");
  assert.ok(splitScript(source).wire.includes('updatedPermissions: "会写入'), "真实产物应含完整禁用表");
});
