import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { codexItemProgress } from "../src/adapters/codex-app-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

async function source(path) {
  // Windows 工作区源码是 CRLF：统一归一化为 LF，避免多行正则里的 \n 匹配不到（config-topology-state 同根因）
  return (await readFile(`${root}/${path}`, "utf8")).replace(/\r\n/g, "\n");
}

// 载荷形状取自 codex app-server v2 实测抓包（2026-08-08 / codex 0.146.0）：
// 干净命令在 commandActions[].command，完整输出在完成态的 aggregatedOutput。
// LO 2026-08-08 报障"只看得到审批，看不到工作过程"的根因：事件只带 itemType。
test("commandExecution progress keeps the command, output and exit code", () => {
  const completed = codexItemProgress("item/completed", {
    item: {
      type: "commandExecution",
      id: "exec-1",
      command: "\"F:\\\\PowerShell\\\\7\\\\pwsh.exe\" -Command 'node -e \"console.log(1+1)\"'",
      commandActions: [{ type: "unknown", command: "node -e \"console.log(1+1)\"" }],
      cwd: "I:\\514claude\\514cc",
      status: "completed",
      aggregatedOutput: "2\n",
      exitCode: 0,
      durationMs: 989,
    },
  });
  assert.equal(completed.kind, "command");
  assert.equal(completed.id, "exec-1");
  assert.equal(completed.command, 'node -e "console.log(1+1)"'); // 优先干净命令，不是 pwsh 包装
  assert.equal(completed.output, "2\n");
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.durationMs, 989);
  assert.equal(completed.outputTruncated, false);

  // started 时 aggregatedOutput 尚为 null——不能把 "null" 当输出显示
  const started = codexItemProgress("item/started", {
    item: { type: "commandExecution", id: "exec-1", command: "npm test", commandActions: [], aggregatedOutput: null, exitCode: null },
  });
  assert.equal(started.output, "");
  assert.equal(started.exitCode, null);
});

test("oversized command output is truncated head and tail, and flagged", () => {
  const output = `HEAD${"x".repeat(64 * 1024)}TAIL`;
  const progress = codexItemProgress("item/completed", {
    item: { type: "commandExecution", id: "exec-2", command: "npm test", commandActions: [], aggregatedOutput: output, exitCode: 1 },
  });
  assert.equal(progress.outputTruncated, true);
  assert.ok(progress.output.length < output.length);
  // 报错与结论多在尾部，只留头部等于裁掉最有用的信息
  assert.ok(progress.output.startsWith("HEAD"), "截断后丢了开头");
  assert.ok(progress.output.endsWith("TAIL"), "截断后丢了结尾");
  assert.ok(progress.output.includes("…"));
});

test("fileChange progress carries paths, change kind and diff", () => {
  const progress = codexItemProgress("item/completed", {
    item: {
      type: "fileChange",
      id: "exec-3",
      status: "completed",
      changes: [{ path: "I:\\tmp\\hello.txt", kind: { type: "add" }, diff: "hello\n" }],
    },
  });
  assert.equal(progress.kind, "file");
  assert.equal(progress.changesTotal, 1);
  assert.equal(progress.changes[0].path, "I:\\tmp\\hello.txt");
  assert.equal(progress.changes[0].change, "add");
  assert.equal(progress.changes[0].diff, "hello\n");
});

test("file change lists are bounded but report the real total", () => {
  const changes = Array.from({ length: 50 }, (_, index) => ({ path: `f${index}.ts`, kind: { type: "update" }, diff: "x" }));
  const progress = codexItemProgress("item/completed", { item: { type: "fileChange", id: "exec-4", changes } });
  assert.equal(progress.changesTotal, 50);
  assert.equal(progress.changes.length, 20);
});

// 旁白（phase=commentary）是 Codex 边干边说的那半边，只会被后一条正文覆盖掉。
// final_answer 走 assistant.message 正常通道，不能在过程流里重复一遍。
// 字段形状对齐 codex app-server v2 JSON Schema：mcpToolCall = {server, tool, arguments, result:{content:[{type,text}]}}。
test("mcp and generic tool items become process tool cards", () => {
  const mcp = codexItemProgress("item/completed", {
    item: {
      type: "mcpToolCall",
      id: "mcp-1",
      server: "fastctx",
      tool: "inspect_local_file",
      arguments: { files: [{ path: "I:\\\\514claude\\\\514cc\\\\rules.md" }] },
      result: { content: [{ type: "text", text: "1   # 514cc 体系宪法" }] },
      status: "completed",
    },
  });
  assert.equal(mcp.kind, "tool");
  assert.equal(mcp.name, "fastctx.inspect_local_file");
  assert.match(mcp.input, /rules\.md/);
  // MCP result.content 要展开成纯文本，不能把 {content:[...]} 整个 JSON 泼进会话流
  assert.equal(mcp.output, "1   # 514cc 体系宪法");

  const dynamic = codexItemProgress("item/completed", {
    item: { type: "dynamicToolCall", id: "dyn-1", tool: "read_file", arguments: { path: "x.txt" }, contentItems: [{ type: "inputText", text: "hello" }], status: "completed" },
  });
  assert.equal(dynamic.kind, "tool");
  assert.equal(dynamic.name, "read_file");
  assert.equal(dynamic.output, "hello");

  const web = codexItemProgress("item/completed", {
    item: { type: "webSearch", id: "web-1", query: "lucide icons", results: [{ title: "x" }] },
  });
  assert.equal(web.kind, "tool");
  assert.equal(web.name, "web_search");
  assert.equal(web.input, "lucide icons");

  const started = codexItemProgress("item/started", {
    item: { type: "collabAgentToolCall", id: "agent-1", tool: "spawnAgent", arguments: { task: "audit UI" }, status: "inProgress" },
  });
  assert.equal(started.kind, "tool");
  assert.equal(started.name, "spawnAgent");
  assert.match(started.input, /audit UI/);
  assert.equal(started.output, "");
});

test("subagent activity renders as a tool row with the activity verb", () => {
  const started = codexItemProgress("item/completed", {
    item: { type: "subAgentActivity", id: "sub-1", agentPath: "/root/current_ui_audit", agentThreadId: "t", kind: "started" },
  });
  assert.equal(started.kind, "tool");
  assert.equal(started.name, "/root/current_ui_audit");
  assert.equal(started.verb, "已启动");
});

test("agent commentary becomes a note while the final answer does not", () => {
  const note = codexItemProgress("item/completed", {
    item: { type: "agentMessage", id: "msg-1", text: "我现在写入并核对文件。", phase: "commentary" },
  });
  assert.equal(note.kind, "note");
  assert.equal(note.text, "我现在写入并核对文件。");
  assert.equal(codexItemProgress("item/completed", {
    item: { type: "agentMessage", id: "msg-2", text: "已创建 hello.txt。", phase: "final_answer" },
  }), null);
});

test("progress is null when there is nothing to show", () => {
  // 反代供应商实测不下发推理摘要（summary/content 皆空）——不落空事件制造噪音
  // 无摘要 reasoning 完成态保留 id（清活跃记账用）但无 text——前端凭此不落空历史卡
  assert.deepEqual(codexItemProgress("item/completed", { item: { type: "reasoning", id: "rs-1", summary: [], content: [] } }), { kind: "reasoning", id: "rs-1" });
  // started：无摘要也发「思考开始」信号——活跃呼吸行据此显示「正在思考」（LO 2026-08-10）
  assert.deepEqual(codexItemProgress("item/started", { item: { type: "reasoning", id: "rs-3", summary: [], content: [] } }), { kind: "reasoning", id: "rs-3", started: true });
  assert.equal(codexItemProgress("item/completed", { item: { type: "userMessage", id: "u-1", content: [] } }), null);
  assert.equal(codexItemProgress("item/completed", {}), null);
  const reasoning = codexItemProgress("item/completed", {
    item: { type: "reasoning", id: "rs-2", summary: [{ type: "text", text: "先读配置" }], content: [] },
  });
  assert.equal(reasoning.text, "先读配置");
});

// 源文件 500KB+，正则断言失败会把整份文件打进输出——一律用 includes 断言字面片段
function assertIncludes(source, snippet, message) {
  assert.ok(source.includes(snippet), message ?? `缺少：${snippet}`);
}

test("the adapter attaches progress to the persisted notification event", async () => {
  const adapter = await source("src/adapters/codex-app-server.mjs");
  assertIncludes(adapter, "progress: codexItemProgress(method, params) ?? undefined,");
  // progress 为 null 时仍落 hint 短快照，前端可凭 itemType/agentPath 画降级工具卡，不重演历史丢件
  assertIncludes(adapter, "hint: compactCodexItemHint(item),");
  // 旁白不得覆盖已收到的正文，否则本轮结论会被一句"我这就去改"顶掉
  assertIncludes(adapter, "if (commentary && active.sawFinalAnswer)");
  assertIncludes(adapter, "if (!commentary) active.sawFinalAnswer = true;");
  assertIncludes(adapter, 'queueActiveEvent(active, "assistant.message"');
});

test("the conversation stream renders completed items and tracks the running one", async () => {
  const [app, mod, css, eventMarkup, conversationMessages] = await Promise.all([source("public/app.js"), source("public/modules/run-live-activity.js"), source("public/styles.css"), source("public/modules/conversation-event-markup.js"), source("public/modules/conversation-messages.js")]);
  // 白名单不含 codex.* 时，带载荷的事件照样被整片过滤掉——两层都得通
  assertIncludes(app, 'if (progress) return !(progress.kind === "reasoning" && !progress.text);');
  // Wave B slice 16：toolProgressFromFallback 已抽取到 modules/conversation-event-markup.js
  assertIncludes(eventMarkup, "function toolProgressFromFallback(hint, itemType)");
  assertIncludes(app, "return Boolean(toolProgressFromFallback(event.data?.hint, event.data?.itemType));");
  // 思考状态接入活跃行：reasoning started 入账、文案「正在思考」
  assertIncludes(mod, '["command", "file", "reasoning", "tool"].includes(progress.kind)');
  assertIncludes(mod, 'if (entry.progress.kind === "reasoning") return "正在思考";');
  assertIncludes(conversationMessages, 'kind: "process", author: event.agentId || "Agent", progress');
  assertIncludes(app, "function processCardMarkup(message, keyAttribute)");
  assertIncludes(app, 'if (kind === "process") {');
  assertIncludes(app, 'if (progress.kind === "tool")');
  assertIncludes(conversationMessages, "function ensureTurnTexts(messages, run, agentId)");
  const noteCss = css.slice(css.indexOf(".process-note {"), css.indexOf(".process-note-body"));
  assertIncludes(noteCss, "text-align: center;");
  assert.equal(/40px/.test(noteCss), false, "过程旁白不得再用 40px 左边距挤出居中栏");
  // 历史只认完成态（每条命令一行）；"此刻在跑什么"走活跃行
  assertIncludes(mod, "function trackCodexActivity(event)");
  // 键分隔符用 \u0000（与 conversationWindowStarts 同约定）：runId/itemId 都可能含空格
  assertIncludes(mod, "codexActivity.set(`${event.runId}\\u0000${progress.id}`");
  assertIncludes(mod, "key.startsWith(`${event.runId}\\u0000`)");
  assertIncludes(mod, "escapeHtml(activity || phaseText)");
  // run 收尾必须清残留，否则进程被杀后会一直显示假的"正在执行"
  assertIncludes(mod, "if (/^run\\.(completed|failed|cancelled)$/.test(event.type))");
  // 活跃行变化也要触发重绘，否则 item/started 到达时界面不动
  assertIncludes(app, "matchesSelectedRun && (conversationEvent || activityChanged || delta)");
  // 命令文本与输出都是外部内容，进 DOM 前必须脱敏 + 转义
  const card = app.slice(app.indexOf("function processCardMarkup"), app.indexOf("function messageMarkup"));
  assertIncludes(card, 'escapeHtml(redact(String(progress.command || "")))');
  assertIncludes(card, "escapeHtml(redact(progress.output))");
  assertIncludes(card, "escapeHtml(redact(String(change.path || \"\")))");
  assertIncludes(card, "escapeHtml(redact(change.diff))");
  assertIncludes(css, ".process-card {");
  assertIncludes(css, ".process-note {");
  // 长输出自带滚动，不把会话流撑成无限长
  const codeBlock = css.slice(css.indexOf(".process-command,"), css.indexOf(".process-output,\n.process-diff { margin-top"));
  assertIncludes(codeBlock, "max-height: 320px;");
  assertIncludes(codeBlock, "overflow: auto;");
});

// round 只做全会话审计序号；真正的防跑飞闸是每条用户消息独立的 interaction step。
// UI 必须同时说清总轮次与本次步骤：第六轮 slim 顶栏后，可见 pill 留「本次步骤 X/Y」，
// 总轮次/交互序号收进同一元素的 tooltip（信息不丢，形态收敛），达到上限后仍允许在原会话发送下一条消息。
test("the interaction budget is visible without presenting a session round cap", async () => {
  const app = await source("public/app.js");
  assertIncludes(app, "const metaParts = [maxSteps > 0 ? `本次步骤 ${interactionStep}/${maxSteps}` : `总轮次 ${totalRounds}`];");
  assertIncludes(app, "`总轮次 ${totalRounds} · 交互 ${interactionSeq} · 本次步骤 ${interactionStep}/${maxSteps}`");
  assertIncludes(app, "function sendErrorText(error, run)");
  assertIncludes(app, 'if (code === "INTERACTION_STEP_LIMIT" || code === "ROUND_LIMIT")');
  assertIncludes(app, "会话没有封顶；请直接发送下一条消息继续");
  assertIncludes(app, "toast(sendErrorText(error, run), \"error\");");
  // code 从服务端 error 载荷取（statusFor 按 code 分流，422 body 里带 error.code）
  assertIncludes(app, "error?.payload?.error?.code ?? error?.code");
});

// provider attempt 建立时，总审计轮次与当前 interaction step 同时递增。退款只退当前
// interactionStep，不回退全会话 round；下一条用户消息通过 activateInteraction 重新获得预算。
test("provider attempts spend only the active interaction budget", async () => {
  const orchestrator = await source("src/orchestrator.mjs");
  const increment = orchestrator.indexOf("run.round += 1;");
  assert.ok(increment > 0, "找不到轮次自增点");
  const aroundIncrement = orchestrator.slice(increment - 200, increment + 240);
  assertIncludes(aroundIncrement, "run.interactionStep += 1;");
  assertIncludes(orchestrator, 'throw Object.assign(new Error("maximum autonomous steps reached for this interaction"), { code: "INTERACTION_STEP_LIMIT" });');
  assertIncludes(orchestrator, "run.interactionStep = stored?.interactionStep || 0;");
  assertIncludes(orchestrator, "run.interactionStates[interactionId]");
  assertIncludes(orchestrator, "refundAbandonedRound(run)");
});
