/**
 * 每轮独立的许可 MCP server 脚本生成器（v50 · 2026-09-04）。
 *
 * ── 为什么每轮一份脚本，而不是一个常驻 server ──
 * `claude-cli.mjs:57` 每 turn spawn 一个 CLI 进程，MCP server 是**该 CLI 的子进程**，
 * 内核与它之间没有天然的身份关联。多 run 并发时，若归属靠请求自称，沙箱侧可以谎报。
 *
 * 解法（烛 S-2，优于 argv nonce）：**把 runId 内联成脚本常量**。
 *   · runId 不出现在任何进程的 argv 里 —— Windows `Win32_Process` 读不到
 *   · 脚本落在该轮专属目录，可设 ACL 限当前用户，比 argv 严格
 *   · 归属由内核在生成脚本时决定，不接受任何自称
 *
 * ── 为什么脚本要内联整个 wire 模块，而不是 import ──
 * MCP server 由 CLI spawn，工作目录与模块解析根都不受我们控制，相对 import 不可靠。
 * 更重要的是烛 S-4 指出的绕过口：`toolResultFor` 是唯一**封装**出口，却不是唯一
 * **物理**出口 —— 脚本完全可以自己 `JSON.stringify({behavior:"allow", updatedPermissions:[...]})`
 * 把 v1 闸整个绕过去。所以这里**把真闸源码内联进脚本**，并由测试断言脚本里
 * 不出现裸 `behavior:` 字面量（机械承载"必须走闸"这个意图，而不是写句注释）。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WIRE_MODULE_PATH = join(dirname(fileURLToPath(import.meta.url)), "permission-prompt-wire.mjs");

/** 读回 wire 模块源码，剥掉 export 关键字后可直接内联进单文件脚本。 */
function inlineWireSource() {
  const source = readFileSync(WIRE_MODULE_PATH, "utf8");
  // 只去掉行首的 `export `，模块内部引用关系不变；不做任何语义改写。
  return source.replace(/^export /gm, "");
}

/** 脚本内的标识符必须是安全字面量 —— 它们会被 JSON.stringify 内联进源码。 */
function assertSafeIdentifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
    throw Object.assign(new Error(`${label} must be a short safe identifier, got ${JSON.stringify(value)}`), {
      code: "INVALID_PPT_SERVER_CONFIG",
    });
  }
}

/**
 * 内联 wire 模块与脚本自身逻辑的分界标记。
 *
 * 测试用它切开脚本：**标记之后的区段不得出现任何 `behavior:` 字面量** ——
 * 那一侧只允许通过 `allowResponse` / `denyResponse` / `toolResultFor` 过闸构造响应。
 * 这是烛 S-4 那条"必须走闸"的机械承载：不是注释，是可断言的边界。
 */
export const SCRIPT_LOGIC_MARKER = "// ==== control-center logic (must go through the v1 gate) ====";

/**
 * 生成该轮专属的 MCP server 脚本源码。
 *
 * @param {object} options
 * @param {string} options.runId        该轮 run 的 id —— **内联为常量**，归属唯一来源
 * @param {string} options.sessionId    会话 id，随请求一并回报内核
 * @param {string} options.endpointPath 内核为该轮开的具名管道/socket 路径（能力凭证本体）
 * @param {number} [options.timeoutMs]  单次审批等待上限；超时按拒绝结算
 */
export function buildPermissionServerSource({ runId, sessionId, endpointPath, timeoutMs = 300_000 }) {
  assertSafeIdentifier(runId, "runId");
  assertSafeIdentifier(sessionId, "sessionId");
  if (typeof endpointPath !== "string" || !endpointPath) {
    throw Object.assign(new Error("endpointPath is required"), { code: "INVALID_PPT_SERVER_CONFIG" });
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw Object.assign(new Error("timeoutMs must be a positive integer"), { code: "INVALID_PPT_SERVER_CONFIG" });
  }

  return `// 自动生成 —— 每轮一份，轮末删除。请勿手工编辑。
// 归属常量由内核在生成时写入：不从 argv 读，沙箱侧无法谎报。
const RUN_ID = ${JSON.stringify(runId)};
const SESSION_ID = ${JSON.stringify(sessionId)};
const ENDPOINT_PATH = ${JSON.stringify(endpointPath)};
const DECISION_TIMEOUT_MS = ${timeoutMs};

import { connect } from "node:net";

${inlineWireSource()}

${SCRIPT_LOGIC_MARKER}

// ── 与内核的连接本身即能力凭证 ──
// 具名管道由内核创建并限当前用户；MCP server 是 CLI 的 stdio 子进程，
// 除了这条管道没有别的回报通道。连接不上就 fail-closed 拒绝，绝不放行。
function askKernel(request) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => finish(null), DECISION_TIMEOUT_MS);
    timer.unref?.();
    let socket;
    try {
      socket = connect(ENDPOINT_PATH);
    } catch {
      clearTimeout(timer);
      finish(null);
      return;
    }
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\\n");
      if (index === -1) return;
      let reply = null;
      try { reply = JSON.parse(buffer.slice(0, index)); } catch { reply = null; }
      clearTimeout(timer);
      socket.destroy();
      finish(reply);
    });
    socket.on("error", () => { clearTimeout(timer); finish(null); });
    socket.on("close", () => { clearTimeout(timer); finish(null); });
    socket.write(JSON.stringify({ runId: RUN_ID, sessionId: SESSION_ID, ...request }) + "\\n");
  });
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

let stdinBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  let index = stdinBuffer.indexOf("\\n");
  while (index !== -1) {
    const line = stdinBuffer.slice(0, index).trim();
    stdinBuffer = stdinBuffer.slice(index + 1);
    if (line) void handle(line);
    index = stdinBuffer.indexOf("\\n");
  }
});

async function handle(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method } = message;

  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: message.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "control-center-approval", version: "1.0.0" },
    }});
    return;
  }

  if (method === "tools/list") {
    // 守卫2（二进制 \`if(!H.inputJSONSchema)\`）：无 schema 则 CLI 启动即 exit 1
    send({ jsonrpc: "2.0", id, result: { tools: [{
      name: "prompt",
      description: "Route a tool permission request to the Control Center operator",
      inputSchema: PERMISSION_TOOL_INPUT_SCHEMA,
    }]}});
    return;
  }

  if (method === "tools/call") {
    let parsed;
    try {
      parsed = parsePermissionRequest(message.params?.arguments);
    } catch {
      // 结构性损坏的请求无法在审批卡上如实呈现工具名 —— 不让人批看不清的东西
      send({ jsonrpc: "2.0", id, result: toolResultFor(denyResponse({
        message: "许可请求结构损坏，控制面无法呈现，已拒绝。",
      }))});
      return;
    }
    const verdict = await askKernel({
      kind: "permission",
      toolName: parsed.toolName,
      input: parsed.input,
      toolUseId: parsed.toolUseId,
    });
    // fail-closed：内核不可达 / 超时 / 回了非批准 —— 一律拒绝。
    // 有界拒绝优于挂起：挂起会让整轮撞 CLI 的进程超时，回到那个红色错误。
    const approved = verdict?.decision === "approve";
    const payload = approved
      ? allowResponse({ toolUseId: parsed.toolUseId, decisionClassification: "user_temporary" })
      : denyResponse({
          message: typeof verdict?.message === "string" && verdict.message
            ? verdict.message
            : (verdict === null ? "控制面未能在时限内应答，已按拒绝处理。" : "操作者拒绝了此次工具调用。"),
          toolUseId: parsed.toolUseId,
          decisionClassification: "user_reject",
        });
    send({ jsonrpc: "2.0", id, result: toolResultFor(payload) });
    return;
  }

  if (id != null) send({ jsonrpc: "2.0", id, result: {} });
}
`;
}

/** MCP 工具的全名（CLI 侧 `--permission-prompt-tool` 要的就是这个形状）。 */
export const PERMISSION_MCP_SERVER_NAME = "ccapproval";
export const PERMISSION_TOOL_FULL_NAME = `mcp__${PERMISSION_MCP_SERVER_NAME}__prompt`;
