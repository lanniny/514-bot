// Kimi Code CLI 适配器（前端工程师成员，当前本机 0.31.1）：
// headless `kimi -p <prompt> --output-format stream-json`，事件两型：
//   {"role":"assistant","content":"..."} 文本段 /
//   {"role":"meta","type":"session.resume_hint","session_id":"session_xxx",...} 会话 ID。
// 续轮 `-S <sessionId>`（实测续接保留上下文）；session 绑定创建目录——resume 必须在同 cwd，
// run.cwd 固化不变恰好天然满足该约束。会话由 kimi 自身持久化（~/.kimi-code）。
// 权限映射：plan/read-only 轮显式 --plan；--auto 会取消逐工具确认，不能表达受控
// workspace-write，因此写权限继续 fail-closed。
// effort 接线（2026-08-09 LO）：kimi headless 没有 --effort argv 开关，走官方 env
// KIMI_MODEL_THINKING_EFFORT 逐轮注入（仅 kimi provider 生效、thinking 开启时上线；
// 会绕过模型声明的 support_efforts——kimi-for-coding 这类未列档位的模型可能被服务端
// 拒绝或回退默认档，档位目录因此只放 managed k3 实测的 low/high/max）。
import { randomUUID } from "node:crypto";
import { runProcess } from "../process-runner.mjs";
import { preparePromptTransport } from "../prompt-transport.mjs";
import { createBoundedTaskTracker, createLfCollector } from "./stream-utils.mjs";

// 原生审批档透传（LO 2026-08-27 本机 kimi 0.36.0 --help 实证）：--yolo 自动批准常规
// 工具调用（agent 仍可提问）；--auto 完全自治。二者仅作用于只读治理轮；写盘轮本来就被
// UNSUPPORTED_PERMISSION 拦截，红线不受影响。
const KIMI_NATIVE_APPROVAL_ARGS = Object.freeze({
  "native:yolo": Object.freeze(["--yolo"]),
  "native:auto": Object.freeze(["--auto"]),
});

export function buildKimiArgs({ prompt, sessionId = null, model = null, permissionMode = "plan", nativeApprovalMode = null }) {
  const args = ["-p", prompt, "--output-format", "stream-json"];
  if (nativeApprovalMode && KIMI_NATIVE_APPROVAL_ARGS[nativeApprovalMode]) args.push(...KIMI_NATIVE_APPROVAL_ARGS[nativeApprovalMode]);
  else if (permissionMode !== "workspace-write") args.push("--plan");
  if (sessionId) args.push("-S", sessionId);
  if (model) args.push("-m", model);
  return args;
}

export function buildKimiEnv({ effort = null } = {}) {
  const normalized = String(effort ?? "").trim().toLowerCase();
  return normalized ? { KIMI_MODEL_THINKING_EFFORT: normalized } : {};
}

export class KimiCliAdapter {
  supportsPerTurnCwd = true; // 每 turn spawn，cwd 真实生效（写盘轮本身已被 UNSUPPORTED_PERMISSION 拦截）

  constructor({ command = "kimi", model = null, eventStore, cwd, runProcessImpl = runProcess }) {
    this.id = "kimi-headless-resume";
    this.command = command;
    this.model = model;
    this.eventStore = eventStore;
    this.cwd = cwd;
    this.runProcessImpl = runProcessImpl;
  }

  async send({ sessionId, prompt, runId, agentId = "kimi-frontend", signal, permissionMode = "plan", model = null, effort = null, timeoutMs = 15 * 60_000, cwd = null, nativeApprovalMode = null, onSessionStarted, onTurnSubmitting }) {
    // 受控写权限 fail-closed：--auto 是全自动批准，不等价于 514cc 的限工作区写权限。
    if (permissionMode === "workspace-write") {
      const error = new Error("kimi --auto removes per-tool confirmation and cannot express scoped workspace-write; dispatch write turns to codex or claude instead");
      error.code = "UNSUPPORTED_PERMISSION";
      throw error;
    }
    // Windows 命令行长度上限约 32K；-p 传参超限时如实拒绝而非静默截断（与 grok 适配器同约束）
    if (prompt.length > 24_000) {
      const error = new Error("prompt exceeds the kimi -p argument budget (24k chars); split the task instead");
      error.code = "INVALID_PROMPT";
      throw error;
    }
    const args = buildKimiArgs({ prompt, sessionId, model: model || this.model, permissionMode, nativeApprovalMode });
    let resolvedSessionId = sessionId || null;
    const textParts = [];
    const pendingTasks = createBoundedTaskTracker();
    const collector = createLfCollector(
      (event) => {
        if (event?.role === "assistant" && typeof event.content === "string" && event.content) {
          textParts.push(event.content);
          pendingTasks.run(() =>
            this.eventStore.emit("assistant.message", { text: event.content }, { runId, sessionId: resolvedSessionId, agentId }));
          return;
        }
        if (event?.role === "meta" && event.type === "session.resume_hint" && event.session_id) {
          const previousSessionId = resolvedSessionId;
          resolvedSessionId = event.session_id;
          if (resolvedSessionId !== previousSessionId) {
            pendingTasks.run(() => onSessionStarted?.({ sessionId: resolvedSessionId, protocol: "kimi-headless-resume" }));
          }
          return;
        }
        // 未知事件形态（未来的工具/状态型 role）宽容降级为工具活动行，不静默丢弃
        if (event?.role && event.role !== "assistant" && event.role !== "meta") {
          pendingTasks.run(() =>
            this.eventStore.emit(
              "tool.event",
              { tool: String(event.role), status: String(event.type || ""), command: String(event.content ?? "").slice(0, 200) },
              { runId, sessionId: resolvedSessionId, agentId },
            ));
        }
      },
      (error) => pendingTasks.run(() =>
        this.eventStore.emit("adapter.parse_error", { adapter: this.id, message: error.message }, { runId, agentId })),
    );
    if (sessionId) await onSessionStarted?.({ sessionId, protocol: "kimi-headless-resume" });
    await onTurnSubmitting?.({ sessionId: sessionId || null, protocol: "kimi-headless-resume", clientUserMessageId: randomUUID() });
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
        cwd: cwd || this.cwd, // 会话项目地址（kimi session 绑定创建目录，同 run 恒同 cwd）
        env: buildKimiEnv({ effort }), // effort 只走 env 线；空对象不改变既有环境裁剪行为
        provider: "kimi",
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
    if (processError) {
      // 进程级失败（超时/中断/spawn）：进程已终止或从未启动，原生轮不可能仍在运行
      if (processError.code === "PROCESS_TIMEOUT" || processError.name === "AbortError" || processError.code === "ENOENT") {
        processError.nativeTurnSettled = true;
        processError.interruptConfirmed = true;
      }
      processError.sessionId = sessionId || null;
      processError.sessionResumable = Boolean(sessionId);
      throw processError;
    }
    if (persistence.timedOut || persistence.pending || persistence.dropped || persistence.errors.length) {
      const error = persistence.errors[0] || new Error("Kimi event persistence did not settle within its bounded drain window");
      if (!error.code) error.code = "EVENT_PERSISTENCE_INCOMPLETE";
      throw error;
    }
    if (result.code !== 0 || !resolvedSessionId) {
      let message = result.stderr.trim() || `kimi exited ${result.code} without a session id`;
      if (/login|auth|unauthorized|expired/i.test(message)) {
        message = `${message} — 在任意终端运行 kimi login 完成设备码登录后重试。`;
      }
      const error = new Error(message);
      error.code = "KIMI_FAILED";
      // headless 进程已退出，原生轮必然已死（与 grok 适配器同语义）：
      // 编排器据此允许超时族错误自动续跑，而不是一律落 recovery_required 人工闸
      error.nativeTurnSettled = true;
      error.interruptConfirmed = true;
      error.sessionId = sessionId || null;
      error.sessionResumable = Boolean(sessionId);
      throw error;
    }
    return { sessionId: resolvedSessionId, text: textParts.join("\n\n"), nativePersistence: true, protocol: "kimi-headless-resume" };
  }
}
