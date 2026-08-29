import { randomUUID } from "node:crypto";
import { runProcess } from "../process-runner.mjs";
import { preparePromptTransport } from "../prompt-transport.mjs";
import { createLfCollector } from "./stream-utils.mjs";

// Gemini 原生审批档（LO 2026-08-27 本机 gemini 0.54.4 --help 实证）：
// --approval-mode 取值 default/auto_edit/yolo/plan。default=逐项询问，headless 无人应答
// 必然挂起，有意不入白名单（与 claude native:default、grok 同款决策）。
const GEMINI_NATIVE_APPROVAL_ARGS = Object.freeze({
  "native:autoEdit": Object.freeze(["--approval-mode", "auto_edit"]),
  "native:yolo": Object.freeze(["--approval-mode", "yolo"]),
});

export function buildGeminiArgs({ sessionId = null, nativeSessionId, model = null, nativeApprovalMode = null }) {
  const args = [...(GEMINI_NATIVE_APPROVAL_ARGS[nativeApprovalMode] ?? ["--approval-mode", "plan"]), "--output-format", "stream-json"];
  if (model) args.push("--model", model);
  if (sessionId) args.push("--resume", sessionId);
  else args.push("--session-id", nativeSessionId);
  args.push("--prompt", "");
  return args;
}

export class GeminiCliAdapter {
  constructor({ command = "gemini", model = null, eventStore, cwd, runProcessImpl = runProcess }) {
    this.id = "gemini-stream-json";
    this.command = command;
    this.model = model;
    this.eventStore = eventStore;
    this.cwd = cwd;
    this.runProcessImpl = runProcessImpl; // v41：远程 run 注入 SSH 桥（默认本机 runProcess）
  }

  async send({ sessionId, prompt, runId, agentId = "gemini-research", signal, model = null, timeoutMs = 20 * 60_000, nativeApprovalMode = null, onSessionStarted, onTurnSubmitting }) {
    const nativeSessionId = sessionId || randomUUID();
    const clientUserMessageId = randomUUID();
    const args = buildGeminiArgs({ sessionId, nativeSessionId, model: model || this.model, nativeApprovalMode });

    let finalText = "";
    const pendingEvents = [];
    const collector = createLfCollector(
      (event) => {
        const type = event.type || event.event;
        const text = event.text || event.content || event.message?.content || "";
        if (typeof text === "string" && text && /message|content|result/i.test(String(type))) finalText += text;
        if (/tool/i.test(String(type))) {
          pendingEvents.push(this.eventStore.emit("tool.event", { adapter: this.id, type, tool: event.name || event.tool_name || null }, { runId, sessionId: nativeSessionId, agentId }));
        } else if (typeof text === "string" && text) {
          pendingEvents.push(this.eventStore.emit("assistant.message", { text }, { runId, sessionId: nativeSessionId, agentId }));
        }
      },
      (error) => pendingEvents.push(this.eventStore.emit("adapter.parse_error", { adapter: this.id, message: error.message }, { runId, agentId })),
    );
    await onSessionStarted?.({ sessionId: nativeSessionId, protocol: "stream-json-resume" });
    await onTurnSubmitting?.({ sessionId: nativeSessionId, protocol: "stream-json-resume", clientUserMessageId });
    await preparePromptTransport({
      prompt,
      transport: "stdin",
      adapterId: this.id,
      command: this.command,
      eventStore: this.eventStore,
      runId,
      agentId,
    });
    const result = await this.runProcessImpl(this.command, args, {
      cwd: this.cwd,
      input: prompt,
      timeoutMs,
      signal,
      onStdout: (chunk) => collector.push(chunk),
    });
    collector.end();
    await Promise.all(pendingEvents);
    if (result.code !== 0) {
      const error = new Error(result.stderr.trim() || `Gemini exited ${result.code}`);
      error.code = "GEMINI_FAILED";
      throw error;
    }
    return { sessionId: nativeSessionId, text: finalText, nativePersistence: true, protocol: "stream-json-resume", acpAvailable: true };
  }
}
