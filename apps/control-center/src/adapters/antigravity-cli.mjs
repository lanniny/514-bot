import { randomUUID } from "node:crypto";
import { runProcess } from "../process-runner.mjs";
import { preparePromptTransport } from "../prompt-transport.mjs";
import { createLfCollector } from "./stream-utils.mjs";

// Antigravity 原生审批与权限档位映射：
// --approval-mode plan / auto_edit / yolo
// --dangerously-skip-permissions 用于全权限透传（需审批）
const ANTIGRAVITY_NATIVE_APPROVAL_ARGS = Object.freeze({
  "native:auto": Object.freeze(["--approval-mode", "auto_edit"]),
  "native:always-approve": Object.freeze(["--dangerously-skip-permissions"]),
  "native:dangerously-skip-permissions": Object.freeze(["--dangerously-skip-permissions"]),
});

export function buildAntigravityArgs({
  sessionId = null,
  nativeSessionId = null,
  model = null,
  requestedModel = null,
  nativeApprovalMode = null,
  permissionMode = "plan",
} = {}) {
  const args = ["--output-format", "stream-json"];

  if (nativeApprovalMode && ANTIGRAVITY_NATIVE_APPROVAL_ARGS[nativeApprovalMode]) {
    args.push(...ANTIGRAVITY_NATIVE_APPROVAL_ARGS[nativeApprovalMode]);
  } else if (permissionMode === "workspace-write") {
    args.push("--approval-mode", "auto_edit");
  } else {
    args.push("--approval-mode", "plan");
  }

  const modelToUse = (requestedModel || model)?.trim();
  if (modelToUse) args.push("--model", modelToUse);
  if (sessionId) args.push("--resume", sessionId);
  else if (nativeSessionId) args.push("--session-id", nativeSessionId);

  // 通过 stdin 输送完整 prompt，避免跨平台 argv 命令行字符与转义截断
  args.push("--prompt", "");
  return args;
}

export class AntigravityCliAdapter {
  constructor({ command = "agy", model = null, eventStore, cwd, runProcessImpl = runProcess }) {
    this.id = "antigravity-stream-json";
    this.command = command;
    this.model = model;
    this.eventStore = eventStore;
    this.cwd = cwd;
    this.runProcessImpl = runProcessImpl;
  }

  async send({
    sessionId,
    prompt,
    runId,
    agentId = "antigravity-agent",
    signal,
    model = null,
    requestedModel = null,
    permissionMode = "plan",
    timeoutMs = 20 * 60_000,
    nativeApprovalMode = null,
    onSessionStarted,
    onTurnSubmitting,
  }) {
    const nativeSessionId = sessionId || randomUUID();
    const clientUserMessageId = randomUUID();
    const args = buildAntigravityArgs({
      sessionId,
      nativeSessionId,
      requestedModel: requestedModel || model || this.model,
      nativeApprovalMode,
      permissionMode,
    });

    let finalText = "";
    let remoteSessionId = null;
    const pendingEvents = [];
    const collector = createLfCollector(
      (event) => {
        const type = event.type || event.event;
        const text = event.text || event.content || event.message?.content || "";
        if (event.session_id || event.sessionId || event.thread_id || (type === "session_id" && event.id)) {
          remoteSessionId = event.session_id || event.sessionId || event.thread_id || event.id;
        }
        if (typeof text === "string" && text && /message|content|result/i.test(String(type))) {
          finalText += text;
        }
        if (/tool/i.test(String(type))) {
          pendingEvents.push(
            this.eventStore.emit(
              "tool.event",
              { adapter: this.id, type, tool: event.name || event.tool_name || null, args: event.args || null },
              { runId, sessionId: nativeSessionId, agentId },
            ),
          );
        } else if (/thought|thinking/i.test(String(type))) {
          const thoughtText = event.thought || event.thinking || text;
          if (thoughtText) {
            pendingEvents.push(
              this.eventStore.emit("assistant.thought", { thought: thoughtText }, { runId, sessionId: nativeSessionId, agentId }),
            );
          }
        } else if (typeof text === "string" && text) {
          pendingEvents.push(
            this.eventStore.emit("assistant.message", { text }, { runId, sessionId: nativeSessionId, agentId }),
          );
        }
      },
      (error) => pendingEvents.push(
        this.eventStore.emit("adapter.parse_error", { adapter: this.id, message: error.message }, { runId, agentId }),
      ),
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
      let message = result.stderr.trim() || `Antigravity CLI exited with code ${result.code}`;
      const isAuth = /login|auth|unauthorized|expired|token|sign.?in|credential/i.test(message);
      if (isAuth) {
        message = `${message} — 请在终端运行 agy login（或 agy auth）登录 Google 账号，或在 Console Provider 绑定 Google/Gemini API Key。`;
      }
      const error = new Error(message);
      error.code = isAuth ? "ANTIGRAVITY_AUTH_REQUIRED" : "ANTIGRAVITY_FAILED";
      error.failureKind = isAuth ? "auth_required" : "process_failed";
      error.retryable = false;
      error.nativeTurnSettled = true;
      error.interruptConfirmed = true;
      error.sessionId = sessionId || null;
      error.sessionResumable = Boolean(sessionId);
      throw error;
    }

    return {
      sessionId: remoteSessionId || nativeSessionId,
      text: finalText,
      nativePersistence: true,
      protocol: "stream-json-resume",
      acpAvailable: true,
    };
  }

  async close() {
    // 独立子进程由 runProcessImpl 生命周期自动管理，此处实现 close 契约
  }
}
