// OpenCode CLI 适配器：headless `opencode run --format json`，stdout JSONL 事件（1.18 实证）：
//   {"type":"step_start","sessionID":"ses_...",...}          步开始——顶层携带会话 ID
//   {"type":"text","part":{"type":"text","text":"..."}}      文本段（整段落盘，非增量）
//   {"type":"step_finish","part":{...,"tokens":{...}}}       步结束（tokens/cost 目前不记账）
// 续轮 `-s <sessionId>`；会话由 opencode 自身 SQLite 持久化（~/.local/share/opencode/opencode.db），
// 不绑定创建目录，per-turn cwd 天然安全。模型 `-m provider/model`（ProviderStore 投影到 opencode.json）。
// 权限映射：plan → --agent plan（原生只读规划代理）；read-only → 默认（headless 权限请求自动拒绝，fail-closed）；
// workspace-write → --auto（opencode 唯一受控写授权口，1.18 --help 实证）。
// effort 透传 `--variant`（provider 自定义推理档，1.18 --help 实证；档位语义由 provider 决定）。
import { randomUUID } from "node:crypto";
import { runProcess } from "../process-runner.mjs";
import { preparePromptTransport } from "../prompt-transport.mjs";
import { createBoundedTaskTracker, createLfCollector } from "./stream-utils.mjs";

export function extractOpencodeEventError(event) {
  if (!event || typeof event !== "object") return "";
  const err = event.error;
  if (typeof err === "string" && err.trim()) return err.trim();
  if (!err || typeof err !== "object") return "";
  const data = err.data;
  if (typeof data === "string" && data.trim()) return data.trim();
  if (data && typeof data === "object" && typeof data.message === "string" && data.message.trim()) {
    return data.message.trim();
  }
  if (typeof err.message === "string" && err.message.trim()) return err.message.trim();
  if (typeof err.name === "string" && err.name.trim()) return err.name.trim();
  return "";
}

export function formatOpencodeExitError({ code, stderr = "", sessionId = null, eventError = "" } = {}) {
  const details = [...new Set([String(eventError || "").trim(), String(stderr || "").trim()].filter(Boolean))];
  const detail = details.join(" — ");
  if (detail) {
    return sessionId
      ? `opencode exited ${code} (session ${sessionId}): ${detail}`
      : `opencode exited ${code}: ${detail}`;
  }
  return sessionId
    ? `opencode exited ${code} after opening session ${sessionId}`
    : `opencode exited ${code} without a session id`;
}

// OpenCode 原生 agent 档（LO 2026-08-27 本机 opencode 1.18.23 `agent list` 实证）：
// 内置 primary 只有 build（权限全开）与 plan（只读）两档，没有中间审批档。
// native:build 仅作用于只读治理轮（--agent build）；写盘轮维持 workspace-write → --auto
// 既有路径，红线不受影响。
const OPENCODE_NATIVE_AGENT_ARGS = Object.freeze({
  "native:build": Object.freeze(["--agent", "build"]),
});

export function buildOpencodeArgs({ prompt, sessionId = null, model = null, effort = null, permissionMode = "read-only", nativeApprovalMode = null }) {
  const args = ["run", "--format", "json"];
  const nativeArgs = nativeApprovalMode ? OPENCODE_NATIVE_AGENT_ARGS[nativeApprovalMode] : null;
  if (permissionMode === "workspace-write") args.push("--auto");
  else if (nativeArgs) args.push(...nativeArgs);
  else if (permissionMode === "plan") args.push("--agent", "plan");
  if (sessionId) args.push("-s", sessionId);
  if (model) args.push("-m", model);
  if (effort) args.push("--variant", effort);
  args.push(prompt); // message 位置参数放最后，避免吞掉后续旗标的歧义
  return args;
}

export class OpencodeCliAdapter {
  supportsPerTurnCwd = true; // 每 turn spawn，cwd 真实生效

  constructor({ command = "opencode", model = null, eventStore, cwd, runProcessImpl = runProcess }) {
    this.id = "opencode-run-json";
    this.command = command;
    this.model = model;
    this.eventStore = eventStore;
    this.cwd = cwd;
    this.runProcessImpl = runProcessImpl;
  }

  async send({ sessionId, prompt, runId, agentId = "opencode", signal, permissionMode = "read-only", model = null, effort = null, timeoutMs = 15 * 60_000, cwd = null, nativeApprovalMode = null, onSessionStarted, onTurnSubmitting }) {
    // Windows 命令行长度上限约 32K；位置参数传 prompt 超限时如实拒绝而非静默截断（与 kimi/grok 适配器同约束）
    if (prompt.length > 24_000) {
      const error = new Error("prompt exceeds the opencode run argument budget (24k chars); split the task instead");
      error.code = "INVALID_PROMPT";
      throw error;
    }
    const args = buildOpencodeArgs({ prompt, sessionId, model: model || this.model, effort, permissionMode, nativeApprovalMode });
    let resolvedSessionId = sessionId || null;
    const textParts = [];
    const eventErrors = [];
    const pendingTasks = createBoundedTaskTracker();
    const collector = createLfCollector(
      (event) => {
        if (!event || typeof event !== "object") return;
        const eventError = extractOpencodeEventError(event);
        if (eventError && !eventErrors.includes(eventError)) eventErrors.push(eventError);
        if (typeof event.sessionID === "string" && event.sessionID && event.sessionID !== resolvedSessionId) {
          resolvedSessionId = event.sessionID;
          pendingTasks.run(() => onSessionStarted?.({ sessionId: resolvedSessionId, protocol: "opencode-run-json" }));
        }
        const part = event.part;
        if (part?.type === "text" && typeof part.text === "string" && part.text) {
          textParts.push(part.text);
          pendingTasks.run(() =>
            this.eventStore.emit("assistant.message", { text: part.text }, { runId, sessionId: resolvedSessionId, agentId }));
          return;
        }
        if (part?.type === "reasoning") {
          pendingTasks.run(() =>
            this.eventStore.emit(
              "tool.event",
              { tool: "thinking", status: "reasoning", command: String(part.text ?? "").slice(0, 200) },
              { runId, sessionId: resolvedSessionId, agentId },
            ));
          return;
        }
        // 工具调用与其余事件形态宽容降级为工具活动行，不静默丢弃
        if (part && part.type && part.type !== "step-start" && part.type !== "step-finish") {
          pendingTasks.run(() =>
            this.eventStore.emit(
              "tool.event",
              { tool: String(part.tool || part.type), status: String(part.state?.status || event.type || ""), command: JSON.stringify(part.state?.input ?? part).slice(0, 200) },
              { runId, sessionId: resolvedSessionId, agentId },
            ));
        }
      },
      (error) => pendingTasks.run(() =>
        this.eventStore.emit("adapter.parse_error", { adapter: this.id, message: error.message }, { runId, agentId })),
    );
    if (sessionId) await onSessionStarted?.({ sessionId, protocol: "opencode-run-json" });
    await onTurnSubmitting?.({ sessionId: sessionId || null, protocol: "opencode-run-json", clientUserMessageId: randomUUID() });
    await preparePromptTransport({
      prompt,
      transport: "argv",
      adapterId: this.id,
      command: this.command,
      eventStore: this.eventStore,
      runId,
      agentId,
    });
    let result;
    let processError = null;
    try {
      result = await this.runProcessImpl(this.command, args, {
        cwd: cwd || this.cwd,
        provider: "opencode",
        timeoutMs,
        signal,
        onStdout: (chunk) => collector.push(chunk),
      });
    } catch (error) {
      processError = error;
    } finally {
      collector.end();
    }
    const persistence = await pendingTasks.drain();
    if (processError) throw processError;
    if (persistence.timedOut || persistence.pending || persistence.dropped || persistence.errors.length) {
      const error = persistence.errors[0] || new Error("OpenCode event persistence did not settle within its bounded drain window");
      if (!error.code) error.code = "EVENT_PERSISTENCE_INCOMPLETE";
      throw error;
    }
    if (result.code !== 0 || !resolvedSessionId) {
      let message = formatOpencodeExitError({
        code: result.code,
        stderr: result.stderr,
        sessionId: resolvedSessionId,
        eventError: eventErrors.join(" — "),
      });
      if (/api.?key|auth|unauthorized|401/i.test(message)) {
        message = `${message} — 检查供应商投影（~/.config/opencode/opencode.json）与密钥后重试。`;
      } else if (/certificate verification/i.test(message)) {
        message = `${message} — OpenCode/Bun 在 Windows 上默认不读系统证书库。514cc 已为子进程打开 NODE_USE_SYSTEM_CA；重启桌面壳后再试。不要关 TLS 校验。`;
      }
      const error = new Error(message);
      error.code = "OPENCODE_FAILED";
      throw error;
    }
    return { sessionId: resolvedSessionId, text: textParts.join("\n\n"), nativePersistence: true, protocol: "opencode-run-json" };
  }
}
