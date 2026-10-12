// CodeBuddy Code CLI 适配器（腾讯，本机实测 2.154.0，npm 包 @tencent-ai/codebuddy-code）。
//
// headless 通道与 Claude Code 同族（本机 `codebuddy -p --output-format stream-json` 实证）：
//   stdin 文本 prompt（默认 --input-format text）→ stdout JSONL：
//   system/init（含 session_id / model / permissionMode）→ assistant → result（含 total_cost_usd、usage）。
//   会话：新建 `--session-id <uuid>`，续接 `--resume <sessionId>`；会话由 CLI 自身持久化（~/.codebuddy）。
//
// 权限：CodeBuddy 的 --permission-mode 取值 acceptEdits/bypassPermissions/default/plan/dontAsk/auto。
// 514cc 的许可通道载体是 `--permission-prompt-tool`——CodeBuddy **不支持**该旗标（bundle 零命中），
// 因此本适配器不提供受控写盘轮：permissionModes 只有 plan/read-only，workspace-write 在入口即
// fail-closed（与 kimi 同款纪律：不能用 --permission-mode acceptEdits 冒充经审批的写盘）。
// 原生审批档（native:*）同样不透传——无许可通道时透传即等于绕过治理。
//
// 已知边界（如实，不隐藏）：
//   1. 无 --max-budget-usd（bundle 零命中）：成本止损完全依赖 orchestrator 结算层。
//   2. 无 --disable-slash-commands（bundle 零命中）：无法像 claude 适配器那样关闭斜杠命令解释，
//      以 "/" 开头的提示词存在被 CLI 当内部命令解释的残留风险（只读档下无写盘后果）。
//   3. 鉴权：本机裸环境（无 CODEBUDDY_API_KEY、无 CODEBUDDY_* 会话变量）实测可用，init 报
//      apiKeySource=copilot.tencent.com —— 走 CLI 自身登录态，故 providerBindingMode=adapter-managed。
import { randomUUID } from "node:crypto";
import { runProcess } from "../process-runner.mjs";
import { preparePromptTransport } from "../prompt-transport.mjs";
import { createLfCollector, claudeResultUsage, publicClaudeEvent } from "./stream-utils.mjs";

/** 治理档 → CLI 原生 --permission-mode。只读两档都落 plan：CodeBuddy 无独立 read-only 档。 */
const CODEBUDDY_PERMISSION_MODES = Object.freeze({
  plan: "plan",
  "read-only": "plan",
});

export function buildCodebuddyArgs({
  sessionId = null,
  nativeSessionId,
  requestedModel = null,
  permissionMode = "plan",
  effort = null,
  settingsFile = null,
  systemPromptFile = null,
}) {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    // 用户级/项目级 MCP 在 headless 下无法交互认证，加载即挂起——与本机 claude 适配器同款隔离
    "--strict-mcp-config",
    "--permission-mode",
    CODEBUDDY_PERMISSION_MODES[permissionMode] || "plan",
  ];
  const model = typeof requestedModel === "string" ? requestedModel.trim() : "";
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (settingsFile) args.push("--settings", settingsFile);
  if (systemPromptFile) args.push("--system-prompt-file", systemPromptFile);
  if (sessionId) args.push("--resume", sessionId);
  else args.push("--session-id", nativeSessionId);
  return args;
}

export class CodeBuddyCliAdapter {
  supportsPerTurnCwd = true; // 每 turn spawn，cwd 参数真实生效（写盘轮本就被 UNSUPPORTED_PERMISSION 拦截）

  constructor({ command = "codebuddy", model = null, settingsFile = null, systemPromptFile = null, eventStore, cwd, runProcessImpl = runProcess }) {
    this.id = "codebuddy-stream-json";
    this.command = command;
    this.model = model;
    this.settingsFile = settingsFile;
    this.systemPromptFile = systemPromptFile;
    this.eventStore = eventStore;
    this.cwd = cwd;
    this.runProcessImpl = runProcessImpl; // v41：远程 run 注入 SSH 桥（默认本机 runProcess）
  }

  // 异构 resume 契约：只声明本 provider 的原生恢复命令，禁止跨 CLI 静默 resume
  canResume(sessionId) {
    return Boolean(sessionId);
  }

  resumeCommand(sessionId) {
    return sessionId ? `codebuddy -r ${sessionId}` : null;
  }

  async send({ sessionId, prompt, runId, agentId = "codebuddy-seat", signal, permissionMode = "plan", model = null, effort = null, timeoutMs = 15 * 60_000, cwd = null, onSessionStarted, onTurnSubmitting }) {
    // 受控写权限 fail-closed：CodeBuddy 没有许可通道（不支持 --permission-prompt-tool），
    // 用 acceptEdits/bypassPermissions 顶上就等于放弃审批不变量。
    const nativePermission = CODEBUDDY_PERMISSION_MODES[permissionMode];
    if (!nativePermission) {
      const error = new Error(`codebuddy cannot express ${permissionMode}: no permission channel (--permission-prompt-tool unsupported); dispatch write turns to codex or claude instead`);
      error.code = "UNSUPPORTED_PERMISSION";
      throw error;
    }
    const nativeSessionId = sessionId || randomUUID();
    const effectiveRequestedModel = model || this.model;
    const args = buildCodebuddyArgs({
      sessionId,
      nativeSessionId,
      requestedModel: effectiveRequestedModel,
      permissionMode,
      effort,
      settingsFile: this.settingsFile,
      systemPromptFile: this.systemPromptFile,
    });

    const clientUserMessageId = randomUUID();
    let finalText = "";
    let resolvedSessionId = nativeSessionId;
    let effectiveModel = this.model;
    let costUsd = null;
    let tokens = null;
    let terminalResult = null;
    let terminalError = null;
    const pendingEvents = [];
    const collector = createLfCollector(
      (event) => {
        if (event?.type === "system" && event?.subtype === "init") {
          if (event.session_id) resolvedSessionId = event.session_id;
          if (event.model) effectiveModel = event.model;
        }
        if (event?.type === "result") {
          terminalResult = event;
          if (event.session_id) resolvedSessionId = event.session_id;
          // 错误真因优先 errors → result 文本 → subtype，绝不拿 subtype 掩盖（与 claude 适配器同纪律）
          if (event.is_error) {
            terminalError =
              event.errors?.join("; ") ||
              (typeof event.result === "string" && event.result.trim()) ||
              (event.subtype && event.subtype !== "success" ? event.subtype : "") ||
              "CodeBuddy returned an error result";
          }
        }
        const normalized = publicClaudeEvent(event);
        if (!normalized) return; // file-history-snapshot / system.status 等非对话事件如实忽略
        if (normalized.type === "assistant.message" && normalized.text) finalText = normalized.text;
        if (normalized.type === "turn.completed") {
          if (normalized.text) finalText = normalized.text;
          costUsd = normalized.costUsd ?? costUsd;
          tokens = normalized.tokens ?? tokens;
        }
        pendingEvents.push(
          this.eventStore.emit(normalized.type, normalized, { runId, sessionId: resolvedSessionId, agentId }),
        );
      },
      (error) => pendingEvents.push(this.eventStore.emit("adapter.parse_error", { adapter: this.id, message: error.message }, { runId, agentId })),
    );
    await onSessionStarted?.({ sessionId: nativeSessionId, protocol: "codebuddy-stream-json" });
    await onTurnSubmitting?.({ sessionId: nativeSessionId, protocol: "codebuddy-stream-json", clientUserMessageId });
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
      cwd: cwd || this.cwd,
      input: prompt,
      timeoutMs,
      signal,
      provider: "codebuddy",
      // 真实工具轮（Read/grep 大文件）会把 tool_result 全文写进 stdout，默认 2MB 上限会中途强杀，
      // 与 claude 适配器同档放宽到 64MB（本地单用户控制面，内存可接受）。
      maxOutputBytes: 64 * 1024 * 1024,
      onStdout: (chunk) => collector.push(chunk),
    });
    collector.end();
    await Promise.all(pendingEvents);

    if (terminalResult?.is_error) {
      const usage = claudeResultUsage(terminalResult);
      const error = new Error(terminalError || "CodeBuddy returned an error result");
      // 成本以 CLI 上报为准（本机实测 total_cost_usd 为 0，网关按套餐不按 token 计费）——不臆造估值
      Object.assign(error, {
        code: "CODEBUDDY_FAILED",
        nativeTurnSettled: true,
        providerResultReceived: true,
        sessionId: resolvedSessionId,
        sessionResumable: true,
        protocol: "codebuddy-stream-json",
        clientUserMessageId,
        costUsd: usage.costUsd,
        tokens: usage.tokens,
        resultSubtype: terminalResult.subtype || null,
      });
      throw error;
    }
    if (!terminalResult && (result.code !== 0 || terminalError)) {
      let message = terminalError || result.stderr.trim() || `CodeBuddy exited ${result.code}`;
      if (/not logged in|login|unauthorized|authentication/i.test(message)) {
        message = `${message} — 在任意终端运行 codebuddy 完成登录（或导出 CODEBUDDY_API_KEY）后重试。`;
      }
      const error = new Error(message);
      error.code = "CODEBUDDY_FAILED";
      error.nativeTurnSettled = true;
      error.interruptConfirmed = true;
      error.sessionId = sessionId || null;
      error.sessionResumable = Boolean(sessionId);
      throw error;
    }
    return {
      sessionId: resolvedSessionId,
      text: finalText,
      nativePersistence: true,
      protocol: "codebuddy-stream-json",
      requestedModel: effectiveRequestedModel,
      effectiveModel,
      costUsd,
      tokens,
    };
  }

  async close() {
    // 独立子进程由 runProcessImpl 生命周期自动管理，此处实现 close 契约
  }
}
