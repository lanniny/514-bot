/**
 * PPT / stream-json 许可帧取证探针（v50 · 2026-09-04）。
 *
 * ── 为什么需要它 ──
 * Claude Code 的许可请求通道有两条候选实现，两条都**未被任何一方端到端跑通**：
 *   1. `--permission-prompt-tool` + stdio MCP（主驾三次实测遇 401/429 与 manual 静默降级）
 *   2. `--input-format stream-json` 双向控制帧（烛评审推荐，但其本机基线 `claude -p` 也超时）
 * 协议的**响应侧**已由二进制取证确证（见 src/permission-prompt-wire.mjs 的注释与出处），
 * 但"CLI 在什么条件下真的会把请求发过来、帧长什么样"始终是空白。
 *
 * 烛的原话：「没测的那部分恰好会是致命项落点。」所以在改任何 adapter 之前，先取这一手证。
 *
 * ── 它做什么 ──
 * 起一个最小 stdio MCP server 当 PPT 目标，把 CLI 传来的**每一帧原样落盘**，
 * 然后按 `--decision` 指定的方式应答，再记录 CLI 后续行为。
 * 落盘文件即证据，可复跑、可 diff、可作为将来实现的黄金样本。
 *
 * ── 用法 ──
 *   node scripts/probe-permission-frames.mjs --prompt "..." [--decision allow|deny] [--mode plan]
 * 需要 CLI 额度可用；跑不通时脚本会**如实报告失败原因**，绝不伪造帧。
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCommand } from "../src/process-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const EVIDENCE_DIR = join(ROOT, ".evidence", "permission-frames");

function parseArgs(argv) {
  const options = { prompt: null, decision: "allow", mode: "plan", timeoutMs: 240_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--prompt") options.prompt = argv[++index] ?? null;
    else if (flag === "--decision") options.decision = argv[++index] ?? "allow";
    else if (flag === "--mode") options.mode = argv[++index] ?? "plan";
    else if (flag === "--timeout") options.timeoutMs = Number(argv[++index]) || options.timeoutMs;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options.prompt) {
  process.stderr.write(
    "用法: node scripts/probe-permission-frames.mjs --prompt \"<会触发工具许可的指令>\" [--decision allow|deny] [--mode plan|acceptEdits|manual]\n\n" +
    "提示：提示词必须会触发一个**不在你 settings.json allow 白名单里**的工具调用，\n" +
    "否则请求在 CLI 内部的静态规则阶段就被解决，永远到不了许可通道。\n",
  );
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(EVIDENCE_DIR, stamp);
mkdirSync(runDir, { recursive: true });

const framesPath = join(runDir, "mcp-frames.jsonl");
const stdoutPath = join(runDir, "cli-stdout.jsonl");
const reportPath = join(runDir, "report.json");
const serverPath = join(runDir, "ppt-server.mjs");

// ── PPT MCP server：写成独立文件，因为它必须由 CLI 自己 spawn ──
// 它按真协议应答（字段名照 claude.exe v2.1.260 的 zod 声明），并把每一帧落盘。
writeFileSync(serverPath, `
import { appendFileSync } from "node:fs";
const FRAMES = ${JSON.stringify(framesPath)};
const DECISION = ${JSON.stringify(options.decision)};
const log = (tag, value) => {
  try { appendFileSync(FRAMES, JSON.stringify({ tag, at: new Date().toISOString(), value }) + "\\n", "utf8"); } catch {}
};
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(line);
    index = buffer.indexOf("\\n");
  }
});
function handle(line) {
  let message;
  try { message = JSON.parse(line); } catch { log("unparsed", line); return; }
  const { id, method } = message;
  if (method === "initialize") {
    log("initialize", message.params);
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: message.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "ppt-probe", version: "1.0.0" },
    }});
    return;
  }
  if (method === "tools/list") {
    // 守卫2：必须是真 MCP 工具（判据=有 inputJSONSchema），否则 CLI exit 1
    send({ jsonrpc: "2.0", id, result: { tools: [{
      name: "prompt",
      description: "Permission prompt probe",
      inputSchema: {
        type: "object",
        properties: {
          tool_name: { type: "string", description: "The name of the tool requesting permission" },
          input: { type: "object", description: "The input for the tool" },
          tool_use_id: { type: "string", description: "The unique tool use request ID" },
        },
        required: ["tool_name", "input"],
        additionalProperties: true,
      },
    }]}});
    return;
  }
  if (method === "tools/call") {
    // ★ 核心取证点：CLI 传来的许可请求原样落盘
    log("PERMISSION_REQUEST", message.params);
    const payload = DECISION === "deny"
      ? { behavior: "deny", message: "probe deny (evidence run)" }
      : { behavior: "allow" };
    log("PERMISSION_RESPONSE", payload);
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] }});
    return;
  }
  if (id != null) send({ jsonrpc: "2.0", id, result: {} });
}
log("boot", { pid: process.pid, decision: DECISION });
`, "utf8");

const mcpConfig = {
  mcpServers: {
    approval: { type: "stdio", command: process.execPath, args: [serverPath] },
  },
};
const mcpConfigPath = join(runDir, "mcp.json");
writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig), "utf8");

const args = [
  "-p",
  "--permission-mode", options.mode,
  "--permission-prompt-tool", "mcp__approval__prompt",
  "--mcp-config", mcpConfigPath,
  "--strict-mcp-config",
  "--output-format", "stream-json",
  "--verbose",
  "--disable-slash-commands",
];

// Windows 上 `claude` 可能是 .ps1/.cmd/嵌套 .exe —— 复用本仓已解决该问题的解析器，
// 别在探针里重造一份会漂移的路径逻辑（resolveCommand 还会优先挑原生 .exe 席位）。
const { command: resolvedCommand, prefixArgs } = resolveCommand("claude", process.env);
process.stderr.write(`证据目录：${runDir}\n启动：${resolvedCommand} ${[...prefixArgs, ...args].join(" ")}\n\n`);

const child = spawn(resolvedCommand, [...prefixArgs, ...args], { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
let stdoutBuffer = "";
let sawToolUse = false;
let sawApiError = null;
let initPermissionMode = null;
let cliVersion = null;

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  let index = stdoutBuffer.indexOf("\n");
  while (index !== -1) {
    const line = stdoutBuffer.slice(0, index).trim();
    stdoutBuffer = stdoutBuffer.slice(index + 1);
    index = stdoutBuffer.indexOf("\n");
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    // hook 噪音不落盘（本机全局 hook 每轮注入体检卡，与本次取证无关）
    if (typeof event.subtype === "string" && event.subtype.startsWith("hook")) continue;
    appendFileSync(stdoutPath, `${line}\n`, "utf8");
    if (event.type === "system" && event.subtype === "init") {
      initPermissionMode = event.permissionMode ?? null;
      // 协议无兼容性承诺，证据必须带版本号，否则将来 diff 不知道是哪版的帧
      cliVersion = event.claude_code_version ?? null;
    }
    if (event.type === "system" && event.subtype === "api_retry") sawApiError = event.error_status ?? "retry";
    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) if (block.type === "tool_use") sawToolUse = true;
    }
  }
});

let stderrText = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderrText += chunk; });

const timer = setTimeout(() => {
  process.stderr.write(`\n超时 ${options.timeoutMs}ms，终止子进程\n`);
  try { child.kill(); } catch {}
}, options.timeoutMs);

child.stdin.end(options.prompt, "utf8");

child.on("close", (code) => {
  clearTimeout(timer);
  const frames = readFrames(framesPath);
  const permissionRequests = frames.filter((entry) => entry.tag === "PERMISSION_REQUEST");
  const mcpHandshake = frames.some((entry) => entry.tag === "initialize");

  // ── 诚实判读：区分"通道不工作"与"这次没跑到那一步" ──
  let verdict;
  let reason;
  if (permissionRequests.length > 0) {
    verdict = "EVIDENCE_CAPTURED";
    reason = `抓到 ${permissionRequests.length} 条真实许可请求`;
  } else if (sawApiError) {
    verdict = "INCONCLUSIVE";
    reason = `上游 API 故障（${sawApiError}），本次未跑到许可阶段——不构成"通道不工作"的证据`;
  } else if (!mcpHandshake) {
    verdict = "INCONCLUSIVE";
    reason = "MCP server 从未被握手，CLI 可能启动即失败——查 cli-stdout.jsonl 与 stderr";
  } else if (!sawToolUse) {
    verdict = "INCONCLUSIVE";
    reason = "本轮 CLI 没有发起任何工具调用——换一个必然触发工具的提示词";
  } else {
    verdict = "TOOL_RAN_WITHOUT_PROMPT";
    reason = `CLI 调用了工具但从未请求许可（permissionMode=${initPermissionMode}）——`
      + "很可能命中了 settings.json 的 allow 规则或该档位自动放行，请换未预批的工具";
  }

  const report = {
    verdict,
    reason,
    cliExitCode: code,
    permissionMode: { requested: options.mode, effective: initPermissionMode },
    counts: { frames: frames.length, permissionRequests: permissionRequests.length },
    mcpHandshake,
    sawToolUse,
    apiError: sawApiError,
    stderr: stderrText.slice(0, 2000) || null,
    evidence: { frames: framesPath, cliStdout: stdoutPath },
    capturedAt: new Date().toISOString(),
    cliVersion,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stderr.write(`\n判读：${verdict}\n原因：${reason}\n报告：${reportPath}\n`);
  process.exit(verdict === "EVIDENCE_CAPTURED" ? 0 : 1);
});

/** 读回落盘的帧文件（收尾判读用）。 */
function readFrames(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  return text.split("\n").map((line) => {
    try { return JSON.parse(line); } catch { return { tag: "unparsed" }; }
  });
}
