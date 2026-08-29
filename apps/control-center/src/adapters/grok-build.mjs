// Grok Build CLI 适配器（v3.5 Phase 3）：headless `grok -p ... --output-format streaming-json`。
// 事件流三段式（2026-07-17 本机实测）：{"type":"thought","data":tok} 逐 token 推理流 /
// {"type":"text","data":...} 最终答案 / {"type":"end","sessionId","usage",...} 收尾。
// 续轮走 `-r <sessionId>`（grok --help 实证存在）。thought 逐 token 不入事件库（防洪水），
// 只在首个 thought 时 emit 一条 thinking 标记。会话由 grok 自身持久化（~/.grok）。
import { randomUUID } from "node:crypto";
import { runProcess } from "../process-runner.mjs";
import { preparePromptTransport } from "../prompt-transport.mjs";
import { isAbnormalProviderTurnStop } from "../provider-turn-outcome.mjs";
import { createLfCollector } from "./stream-utils.mjs";

// Grok headless 没有人能处理 permission_prompt。写轮采用 deny-by-default 的 dontAsk，
// 只批准当前 session cwd 内的 Edit/Write；run_terminal_cmd 仍可用于 Grok 自带的
// 只读命令判据，但不授予 Bash 规则，任何非只读命令都由 dontAsk 直接拒绝。
// 不再用 acceptEdits 在首次创建文件时弹出一个 2ms 后自动取消的无人权限框。
// 原生审批透传（2026-08-27 实证）：仅作用于只读语义轮（非写盘轮），把控制面的
// native:* 覆盖值原样透传给 grok（--permission-mode auto/acceptEdits 或 --always-approve）；
// 写盘轮完全忽略该值，仍固定 dontAsk + 白名单安全不变量。
const GROK_BUILD_TOOLS = "read_file,grep,list_dir,search_replace,run_terminal_cmd,todo_write";
const GROK_BUILD_ALLOW_RULES = Object.freeze([
  "Edit(./**)",
  "Write(./**)",
]);

// 原生审批透传白名单：每一档均经 2026-08-27 本机实证（headless 正常收尾、无权限挂起）。
// 未实证或行为异常的档位不得出现在这里；未知/非法值在 buildGrokArgs 中回落 plan。
const GROK_NATIVE_APPROVAL_ARGS = Object.freeze({
  "native:auto": Object.freeze(["--permission-mode", "auto"]),
  "native:acceptEdits": Object.freeze(["--permission-mode", "acceptEdits"]),
  "native:always-approve": Object.freeze(["--always-approve"]),
});

export function buildGrokArgs({
  prompt,
  sessionId = null,
  newSessionId = null,
  model = null,
  effort = null,
  permissionMode = "plan",
  nativeApprovalMode = null,
}) {
  const args = ["-p", prompt];
  if (sessionId) args.push("-r", sessionId);
  else if (newSessionId) args.push("--session-id", newSessionId);
  if (model) args.push("-m", model);
  if (effort) args.push("--reasoning-effort", effort); // grok 独立推理档位（--help 实证：--reasoning-effort，别名 --effort）
  // 强制 orchestrator 的 coordinator-plan 安全不变量：主脑/只读轮锁 plan（只读探索），
  // 仅审批过的 build 专家轮启用 headless deny-by-default 白名单，不依赖 grok 环境默认。
  if (permissionMode === "workspace-write") {
    // 写盘轮红线：原生审批档在此完全无效，忽略任何传入的 nativeApprovalMode。
    args.push("--permission-mode", "dontAsk", "--tools", GROK_BUILD_TOOLS, "--no-subagents", "--disable-web-search");
    for (const rule of GROK_BUILD_ALLOW_RULES) args.push("--allow", rule);
    args.push("--deny", "MCPTool");
  } else {
    const nativeArgs = GROK_NATIVE_APPROVAL_ARGS[nativeApprovalMode];
    if (nativeArgs) {
      // 实证通过的只读语义轮原生透传；非法/未知值回落 plan（fail-safe，不抛错）。
      args.push(...nativeArgs);
    } else {
      args.push("--permission-mode", "plan");
    }
  }
  args.push("--output-format", "streaming-json");
  return args;
}

function grokUsageTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  const reportedTotal = Number(usage.total_tokens ?? usage.totalTokens);
  if (Number.isFinite(reportedTotal) && reportedTotal > 0) return reportedTotal;
  const fields = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens", "reasoning_tokens"];
  const total = fields.reduce((sum, field) => sum + (Number(usage[field]) || 0), 0);
  return total || null;
}

function grokFailureDetails(stderr) {
  const raw = String(stderr ?? "").trim();
  const marker = raw.lastIndexOf("Internal error:");
  if (marker >= 0) {
    const jsonStart = raw.indexOf("{", marker);
    if (jsonStart >= 0) {
      try {
        const detail = JSON.parse(raw.slice(jsonStart));
        return {
          message: String(detail?.message || "").trim() || null,
          httpStatus: Number.isFinite(Number(detail?.http_status)) ? Number(detail.http_status) : null,
          successfulModelCalls: Number.isFinite(Number(detail?.promptUsage?.modelCalls))
            ? Number(detail.promptUsage.modelCalls)
            : null,
        };
      } catch {}
    }
  }
  return {
    message: null,
    httpStatus: Number(raw.match(/status\s+(\d{3})\b/i)?.[1]) || null,
    successfulModelCalls: Number(raw.match(/["']modelCalls["']\s*:\s*(\d+)/)?.[1]) || null,
  };
}

function grokFailureMessage(stderr, details, sessionId) {
  const raw = String(stderr ?? "").trim();
  if (!details.httpStatus) {
    if (!sessionId) return raw;
    const base = raw || "Grok Build exited without a complete end event";
    return `${base}; 原生会话 ${sessionId} 已确认保留，可在当前任务中继续。`;
  }
  const priorCalls = details.successfulModelCalls;
  const stage = Number.isInteger(priorCalls) && priorCalls > 0
    ? `前 ${priorCalls} 次模型调用成功后，于第 ${priorCalls + 1} 次续调`
    : "首次模型调用时";
  const upstream = details.message ? ` 上游信息：${details.message}` : "";
  const recovery = sessionId
    ? `；原生会话 ${sessionId} 已确认保留，可在当前任务中继续。`
    : "；本次未确认创建可恢复的原生会话，请以同一任务重新发起。";
  return `Grok Build Responses 上游在${stage}返回 HTTP ${details.httpStatus}${recovery}${upstream}`;
}

function isSpawnRejected(error) {
  return ["ENOENT", "EACCES", "EPERM", "UNSAFE_COMMAND_SHIM"].includes(error?.code);
}

export class GrokBuildAdapter {
  supportsPerTurnCwd = true; // 每 turn spawn，cwd 参数真实生效——worktree 隔离可托付（烛 v3.6 致命7）

  constructor({
    command = "grok",
    model = null,
    eventStore,
    cwd,
    runProcessImpl = runProcess,
    sessionIdFactory = randomUUID,
  }) {
    this.id = "grok-build-headless";
    this.command = command;
    this.model = model;
    this.eventStore = eventStore;
    this.cwd = cwd;
    this.runProcessImpl = runProcessImpl; // v41：远程 run 注入 SSH 桥（默认本机 runProcess）
    this.sessionIdFactory = sessionIdFactory;
  }

  async send({ sessionId, prompt, runId, agentId = "grok-build", signal, permissionMode = "plan", nativeApprovalMode = null, model = null, effort = null, timeoutMs = 15 * 60_000, cwd = null, onSessionStarted, onTurnSubmitting }) {
    // Windows 命令行长度上限约 32K；-p 传参超限时如实拒绝而非静默截断
    if (prompt.length > 24_000) {
      const error = new Error("prompt exceeds the grok -p argument budget (24k chars); split the task instead");
      error.code = "INVALID_PROMPT";
      throw error;
    }
    // 由控制面预分配原生 session：即使 Grok 在工具回传后的 Responses 续调中失败、来不及发 end，
    // 也能在失败 attempt 上保留可恢复的会话 ID，而不是让下一条“继续”从空会话重来。
    const newSessionId = sessionId ? null : this.sessionIdFactory();
    const args = buildGrokArgs({
      prompt,
      sessionId,
      newSessionId,
      model: model || this.model,
      effort,
      permissionMode,
      nativeApprovalMode,
    });
    let resolvedSessionId = sessionId || newSessionId;
    let endReceived = false;
    let finalText = "";
    let usage = null;
    let stopReason = null;
    let thinkingEmitted = false;
    const pendingEvents = [];
    const collector = createLfCollector(
      (event) => {
        if (event?.type === "thought") {
          if (!thinkingEmitted) {
            thinkingEmitted = true;
            pendingEvents.push(
              this.eventStore.emit("grok.thinking", { adapter: this.id }, { runId, sessionId: resolvedSessionId, agentId }),
            );
          }
          return; // 逐 token 推理流不入事件库
        }
        if (event?.type === "text" && typeof event.data === "string") {
          finalText += event.data;
          pendingEvents.push(
            this.eventStore.emit("grok.item/agentMessage/delta", { delta: event.data }, { runId, sessionId: resolvedSessionId, agentId }),
          );
          return;
        }
        if (event?.type === "end") {
          endReceived = true;
          resolvedSessionId = event.sessionId || resolvedSessionId;
          usage = event.usage || null;
          stopReason = event.stopReason || null;
        }
      },
      (error) =>
        pendingEvents.push(
          this.eventStore.emit("adapter.parse_error", { adapter: this.id, message: error.message }, { runId, agentId }),
        ),
    );
    const clientUserMessageId = randomUUID();
    if (sessionId) await onSessionStarted?.({ sessionId, protocol: "grok-headless-resume" });
    // 预分配 UUID 只是一项控制面意图。原生进程尚未证明创建 session 前，必须保留在
    // tentativeSessionId，不能写入 run.sessions 或向 UI 承诺“可继续”。
    await onTurnSubmitting?.({
      sessionId: sessionId || null,
      tentativeSessionId: newSessionId,
      sessionResumable: Boolean(sessionId),
      protocol: "grok-headless-resume",
      clientUserMessageId,
    });
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
    try {
      result = await this.runProcessImpl(this.command, args, {
        cwd: cwd || this.cwd, // 会话项目地址（spawn 型适配器随会话切换工作目录）
        timeoutMs,
        signal,
        onStdout: (chunk) => collector.push(chunk),
      });
    } catch (error) {
      collector.end();
      await Promise.all(pendingEvents);
      if (isSpawnRejected(error)) {
        error.submissionRejected = true;
        error.nativeTurnSettled = true;
        error.interruptConfirmed = true;
      }
      error.sessionId = sessionId || null;
      error.tentativeSessionId = newSessionId;
      error.sessionResumable = Boolean(sessionId);
      error.protocol = error.protocol || "grok-headless-resume";
      error.clientUserMessageId = error.clientUserMessageId || clientUserMessageId;
      throw error;
    }
    collector.end();
    await Promise.all(pendingEvents);
    if (result.code !== 0 || !endReceived) {
      const details = grokFailureDetails(result.stderr);
      // end.sessionId 是原生确认；第三次 Responses 续调失败时，modelCalls>0 也证明该
      // 预分配 session 已经实际工作。首次调用即失败、空截断和 spawn 失败都不能提升。
      const resumableSessionId = sessionId
        || (endReceived && resolvedSessionId)
        || ((details.successfulModelCalls ?? 0) > 0 ? newSessionId : null);
      const message = grokFailureMessage(result.stderr, details, resumableSessionId)
        || `grok exited ${result.code} without an end event`;
      const error = new Error(message);
      error.code = "GROK_BUILD_FAILED";
      error.sessionId = resumableSessionId;
      error.tentativeSessionId = newSessionId;
      error.sessionResumable = Boolean(resumableSessionId);
      error.protocol = "grok-headless-resume";
      error.clientUserMessageId = clientUserMessageId;
      error.httpStatus = details.httpStatus;
      error.successfulModelCalls = details.successfulModelCalls;
      // headless 进程已经退出，绝不存在仍占用原生 session 的并发 turn。编排器可把 durable
      // claim 保留为可重试工作，但不能误报「可能仍有 native turn 在运行」逼人工恢复。
      error.nativeTurnSettled = true;
      error.interruptConfirmed = true;
      throw error;
    }
    // 只有进程正常退出且 end 已确认后，才发布正常完成事件。避免 end 后非零退出时
    // 会话流先出现 assistant.message/grok.completed，随后 run 又翻成 failed。
    if (!sessionId) {
      // 复用 submitting 相位做 tentative -> resumable 提升，不能在模型已完成后倒退到
      // session_ready（该相位在退款/恢复语义上仍被视为尚未提交）。
      await onTurnSubmitting?.({
        sessionId: resolvedSessionId,
        tentativeSessionId: newSessionId,
        sessionResumable: true,
        protocol: "grok-headless-resume",
        clientUserMessageId,
      });
    }
    if (finalText && !isAbnormalProviderTurnStop(stopReason)) {
      await this.eventStore.emit("assistant.message", { text: finalText }, { runId, sessionId: resolvedSessionId, agentId });
    }
    await this.eventStore.emit(
      "grok.completed",
      { adapter: this.id, stopReason, usage }, // 正文已走 assistant.message，不双份入库
      { runId, sessionId: resolvedSessionId, agentId },
    );
    // stopReason 必须回传编排器：grok 以 exit 0 + stopReason=cancelled 报「这轮被中断」，
    // 只落事件不回传就等于让编排器把中断轮当正常完成记账（LO 2026-08-14 报障：第 5 轮
    // stopReason=cancelled、443 output tokens 全丢，UI 仍显示「第 5 轮完成」的空白气泡）
    return {
      sessionId: resolvedSessionId,
      text: finalText,
      nativePersistence: true,
      protocol: "grok-headless-resume",
      stopReason,
      tokens: grokUsageTokens(usage),
    };
  }
}
