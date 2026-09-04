/**
 * stream-json 双向控制帧取证探针（v50 · 2026-09-04）。
 *
 * ── 与 probe-permission-frames.mjs 的分工 ──
 * 那个探针走 `--permission-prompt-tool` + stdio MCP（已实证可跑，但每 turn spawn 导致
 * 多 run 并发时归属只能靠沙箱自称）。
 * 这个探针走 `--input-format stream-json` 双向流 —— 烛评审推荐的方案：管道由内核
 * spawn 时持有，1:1 绑定子进程，归属天然正确，无需任何 IPC 鉴权。
 * 但烛明确标注"帧格式未在本机实证"，本探针就是来补这一手证的。
 *
 * ── 已从 claude.exe v2.1.260 挖出的实现（待实测印证）──
 *   入站：{type:"control_request", request_id, request:{subtype:"can_use_tool",
 *          tool_name, input, tool_use_id, permission_suggestions?}}
 *   出站：{type:"control_response", response:{subtype:"success", request_id,
 *          response:{behavior:"allow"|"deny", ...}}}
 *   守卫：`hasCanUseToolNameMismatch` —— 回程 response.toolName 若与请求 tool_name
 *          不符会被**整条丢弃**（`Lwe()` 内 warn 日志），请求继续挂着
 *   收尾：stdin 关闭时未结算的请求一律 reject
 *          ("Tool permission stream closed before response received")
 *
 * ── 用法 ──
 *   node scripts/probe-stream-json-frames.mjs --prompt "..." [--decision allow|deny] [--mode plan]
 * 跑不通时如实报告失败原因，绝不伪造帧。
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCommand } from "../src/process-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const EVIDENCE_DIR = join(ROOT, ".evidence", "stream-json-frames");

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
    "用法: node scripts/probe-stream-json-frames.mjs --prompt \"<会触发工具许可的指令>\" [--decision allow|deny] [--mode plan]\n\n" +
    "提示：提示词必须触发一个**不在 settings.json allow 白名单里**的工具调用；\n" +
    "命中静态规则的请求在 CLI 内部就被解决，永远不会发出 can_use_tool 帧。\n",
  );
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(EVIDENCE_DIR, stamp);
mkdirSync(runDir, { recursive: true });

const inboundPath = join(runDir, "inbound.jsonl");   // CLI → 我们（含 control_request）
const outboundPath = join(runDir, "outbound.jsonl"); // 我们 → CLI
const reportPath = join(runDir, "report.json");

const logInbound = (line) => appendFileSync(inboundPath, `${line}\n`, "utf8");
const logOutbound = (value) => appendFileSync(outboundPath, `${JSON.stringify({ at: new Date().toISOString(), frame: value })}\n`, "utf8");

const args = [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--permission-mode", options.mode,
  "--disable-slash-commands",
  "--strict-mcp-config",
  // 有意不传 `--permission-prompts`：它的 `host` 取值是 **no-op**（二进制偏移
  // 187945707 附近 `xY(e){return e==="none"}` —— 只有 "none" 有语义，host 是默认放行态，
  // 不含任何"声明宿主"作用）。本探针最初误以为它能声明宿主，实际三轮配置在许可
  // 通道上完全等价 —— 记此教训，别再拿它当变量。

];

const { command: resolvedCommand, prefixArgs } = resolveCommand("claude", process.env);

// ── 启动前的结构性判定（烛 S-3）──
// 许可宿主由二进制偏移 187945707 的一行代码决定：
//   function Uft({permissionPromptTool:e, sdkUrl:n}){ return n ? "stdio" : e }
// 两者皆空 → 无宿主 → CLI 官方 schema 自述 "bare -p ... 'ask' decisions are terminal"
// （偏移 182473170），ask 直接终结为拒绝，永不外发控制帧。
// `--input-format stream-json` **不在这个判定的任何入参里**。
// 这是启动前就能算出的结论，不必真跑 200s 超时去验证。
const hasPermissionHost = args.includes("--permission-prompt-tool") || args.includes("--sdk-url");
if (!hasPermissionHost) {
  const report = {
    verdict: "NO_PERMISSION_HOST",
    reason: "argv 里既无 --permission-prompt-tool 也无 --sdk-url —— CLI 无许可宿主，"
      + "ask 决策直接终结为拒绝，结构上不可能发出 can_use_tool 控制帧。未启动子进程。",
    channel: "stream-json bidirectional",
    evidenceOfClaim: "claude.exe v2.1.260 @187945707 (Uft) 与 @182473170 (permission_denied schema)",
    capturedAt: new Date().toISOString(),
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stderr.write(`\n判读：NO_PERMISSION_HOST\n原因：${report.reason}\n报告：${reportPath}\n`);
  process.exit(1);
}

process.stderr.write(`证据目录：${runDir}\n启动：${resolvedCommand} ${[...prefixArgs, ...args].join(" ")}\n\n`);

const child = spawn(resolvedCommand, [...prefixArgs, ...args], {
  stdio: ["pipe", "pipe", "pipe"],
  shell: false,
  windowsHide: true,
});

const controlRequests = [];
let cliVersion = null;
let initPermissionMode = null;
let sawApiError = null;
let sawToolUse = false;
let stderrText = "";

const write = (frame) => {
  logOutbound(frame);
  child.stdin.write(`${JSON.stringify(frame)}\n`);
};

let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { logInbound(JSON.stringify({ unparsed: line.slice(0, 400) })); continue; }
    // hook 噪音不落盘（本机全局 hook 每轮注入体检卡，与本次取证无关）
    if (typeof event.subtype === "string" && event.subtype.startsWith("hook")) continue;
    logInbound(line);

    if (event.type === "system" && event.subtype === "init") {
      cliVersion = event.claude_code_version ?? null;
      initPermissionMode = event.permissionMode ?? null;
    }
    if (event.type === "system" && event.subtype === "api_retry") sawApiError = event.error_status ?? "retry";
    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) if (block.type === "tool_use") sawToolUse = true;
    }

    // ★ 核心取证点：许可请求以 control_request 帧到达
    if (event.type === "control_request" && event.request?.subtype === "can_use_tool") {
      controlRequests.push(event);
      const payload = options.decision === "deny"
        ? { behavior: "deny", message: "probe deny (stream-json evidence run)" }
        : { behavior: "allow" };
      // `hasCanUseToolNameMismatch` 守卫：回程带 toolName 时必须与请求一致，
      // 不一致整条被丢弃且请求继续挂着。这里如实回传以验证该守卫。
      write({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: event.request_id,
          response: { ...payload, toolName: event.request.tool_name },
        },
      });
    }
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderrText += chunk; });

const timer = setTimeout(() => {
  process.stderr.write(`\n超时 ${options.timeoutMs}ms，终止子进程\n`);
  try { child.kill(); } catch {}
}, options.timeoutMs);

// stream-json 入站：一条 user 消息帧。stdin **保持打开** —— 关闭会让所有未结算的
// 许可请求被 reject（"Tool permission stream closed before response received"）。
write({
  type: "user",
  message: { role: "user", content: [{ type: "text", text: options.prompt }] },
  parent_tool_use_id: null,
  session_id: "",
});

child.on("close", (code) => {
  clearTimeout(timer);
  let verdict;
  let reason;
  if (controlRequests.length > 0) {
    verdict = "EVIDENCE_CAPTURED";
    reason = `抓到 ${controlRequests.length} 条 can_use_tool 控制帧`;
  } else if (sawApiError) {
    verdict = "INCONCLUSIVE";
    reason = `上游 API 故障（${sawApiError}），本次未跑到许可阶段——不构成"通道不工作"的证据`;
  } else if (!cliVersion) {
    verdict = "INCONCLUSIVE";
    reason = "CLI 未发出 init 帧，可能启动即失败或 stream-json 入参被拒——查 stderr 与 inbound.jsonl";
  } else if (!sawToolUse) {
    verdict = "INCONCLUSIVE";
    reason = "本轮 CLI 没有发起任何工具调用——换一个必然触发工具的提示词";
  } else {
    verdict = "TOOL_RAN_WITHOUT_PROMPT";
    reason = `CLI 调用了工具但从未发 can_use_tool（permissionMode=${initPermissionMode}）——`
      + "很可能命中 settings.json 的 allow 规则，或该档位自动放行";
  }

  const report = {
    verdict,
    reason,
    channel: "stream-json bidirectional",
    cliExitCode: code,
    cliVersion,
    permissionMode: { requested: options.mode, effective: initPermissionMode },
    probeDecision: options.decision,
    counts: { controlRequests: controlRequests.length },
    // 帧结构指纹：将来 diff 协议漂移用
    frameShapes: controlRequests.map((frame) => ({
      topLevelKeys: Object.keys(frame).sort(),
      requestKeys: Object.keys(frame.request ?? {}).sort(),
      toolName: frame.request?.tool_name ?? null,
      hasToolUseId: typeof frame.request?.tool_use_id === "string",
      requestIdType: typeof frame.request_id,
    })),
    sawToolUse,
    apiError: sawApiError,
    stderr: stderrText.slice(0, 2000) || null,
    evidence: { inbound: inboundPath, outbound: outboundPath },
    capturedAt: new Date().toISOString(),
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stderr.write(`\n判读：${verdict}\n原因：${reason}\n报告：${reportPath}\n`);
  process.exit(verdict === "EVIDENCE_CAPTURED" ? 0 : 1);
});
