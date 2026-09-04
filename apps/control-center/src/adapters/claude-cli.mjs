import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../process-runner.mjs";
import { preparePromptTransport } from "../prompt-transport.mjs";
import { createPermissionEndpoint } from "../permission-endpoint.mjs";
import { PERMISSION_MCP_SERVER_NAME, PERMISSION_TOOL_FULL_NAME, buildPermissionServerSource } from "../permission-server-script.mjs";
import { createLfCollector, claudeResultUsage, publicClaudeEvent } from "./stream-utils.mjs";

/** broker 白名单里对应的方法名（`approval-methods.mjs` 登记，inbound: true）。 */
const CLAUDE_TOOL_PERMISSION_METHOD = "claude/toolPermission/requestApproval";

// Claude 原生审批档透传白名单（LO 2026-08-27）：值原样作为 --permission-mode 下发。
// native:default 有意不入表：headless -p 下 default=逐项询问，无人应答必然挂起（与
// grok 同款决策，agent-control-catalog 测试锁此边界）。写盘轮红线在调用方维持。
const CLAUDE_NATIVE_PERMISSION_ARGS = Object.freeze({
  "native:acceptEdits": Object.freeze(["--permission-mode", "acceptEdits"]),
  "native:bypassPermissions": Object.freeze(["--permission-mode", "bypassPermissions"]),
});

export function buildClaudeArgs({
  sessionId = null,
  nativeSessionId,
  requestedModel,
  permissionMode = "plan",
  maxBudgetUsd = 2,
  effort = null,
  settingsFile = null,
  systemPromptFile = null,
  nativeCommand = false,
  nativeApprovalMode = null,
  permissionMcpConfigPath = null,
}) {
  // 治理三档维持既有映射；native:* 覆盖仅在只读轮生效——写盘轮（workspace-write，
  // 经审批的 build）完全忽略 native 覆盖，固定 acceptEdits，保住审批不变量。
  const nativeArgs = permissionMode === "workspace-write" ? null : CLAUDE_NATIVE_PERMISSION_ARGS[nativeApprovalMode];
  const args = [
    "-p",
    "--strict-mcp-config",
    "--no-chrome",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(nativeArgs ?? [
      "--permission-mode",
      permissionMode === "workspace-write" ? "acceptEdits" : "plan",
    ]),
    // maxBudgetUsd=null = 无限预算：省略旗标（CLI 侧不设上限），成本止损仍由 orchestrator 结算层负责
    ...(maxBudgetUsd == null ? [] : ["--max-budget-usd", String(maxBudgetUsd)]),
  ];
  // 许可通道（v50）：把该轮专属的 MCP server 挂上，让 CLI 在需要工具许可时
  // 回来问操作者，而不是无人应答后超时变成一条红色"工具错误"。
  //
  // 这两个旗标必须同时给：`--permission-prompt-tool` 是 CLI 判定"存在可应答宿主"的
  // 唯一本地依据（二进制偏移 187945707：`Uft({permissionPromptTool:e, sdkUrl:n})`，
  // 两者皆空即无宿主，官方 schema 自述 "bare -p ... 'ask' decisions are terminal"）。
  // 缺了它，需审批的工具会被直接摘除（实测：plan 档下 ExitPlanMode 不在 init.tools 里）。
  //
  // 注意 `--strict-mcp-config` 已在上面：用户级 MCP 不会被加载，这里注入的是
  // 该轮唯一的 MCP server，其脚本内联了本轮 runId，沙箱侧无法冒名。
  if (permissionMcpConfigPath) {
    args.push("--mcp-config", permissionMcpConfigPath);
    args.push("--permission-prompt-tool", PERMISSION_TOOL_FULL_NAME);
  }
  // 默认禁斜杠命令：普通提示词里的 "/" 只是文本（防提示注入触发 CLI 内部命令）。
  // 原生命令轮例外：用户显式发送 /compact 等，CLI 需要解释执行——与 Desktop 同通道。
  if (!nativeCommand) args.splice(2, 0, "--disable-slash-commands");
  const model = typeof requestedModel === "string" ? requestedModel.trim() : "";
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (settingsFile) args.push("--settings", settingsFile);
  if (systemPromptFile) args.push("--system-prompt-file", systemPromptFile);
  if (sessionId) args.push("--resume", sessionId);
  else args.push("--session-id", nativeSessionId);
  return args;
}

export class ClaudeCliAdapter {
  supportsPerTurnCwd = true; // 每 turn spawn，cwd 参数真实生效——worktree 隔离可托付（烛 v3.6 致命7）

  constructor({ command = "claude", model = "fable", systemPromptFile = null, settingsFile = null, eventStore, cwd, runProcessImpl = runProcess, approvalResolver = null }) {
    this.id = "claude-stream-json";
    this.command = command;
    this.model = model ?? "fable";
    this.systemPromptFile = systemPromptFile;
    this.settingsFile = settingsFile;
    this.eventStore = eventStore;
    this.cwd = cwd;
    this.runProcessImpl = runProcessImpl; // v41：远程 run 注入 SSH 桥（默认本机 runProcess）
    // v50 许可通道：有 resolver 才开通道。没有就不开 —— 让 CLI 以为有宿主
    // 却无人应答，比现在的"无宿主直接拒"更糟（请求会挂到超时）。
    this.approvalResolver = approvalResolver;
  }

  // 异构 resume 契约：只声明本 provider 的原生恢复命令，禁止跨 CLI 静默 resume
  canResume(sessionId) {
    return Boolean(sessionId);
  }

  resumeCommand(sessionId) {
    return sessionId ? `claude -r ${sessionId}` : null;
  }

  /**
   * 为这一轮开一条许可通道（v50）。
   *
   * 返回 `null` 表示不开（没有 approvalResolver 时不该假装有人能应答 ——
   * 那会让 CLI 以为有宿主，实际请求无人接，反而比现在更糟）。
   *
   * 生命周期严格绑定单轮：端点、脚本、临时目录都在 `dispose()` 里清理。
   * 脚本内联了本轮 runId，**不经 argv**，沙箱侧读不到也伪造不了（烛 S-2）。
   */
  async #openPermissionChannel({ runId, sessionId, agentId, timeoutMs }) {
    if (typeof this.approvalResolver !== "function" || !runId) return null;
    // 通道是增强，不是这一轮能否跑的前提。任何一步失败（端口占用、临时目录不可写、
    // runId 形态超出脚本生成器的安全字符集…）都退回"无通道"而不是让整轮挂掉 ——
    // 退回后 CLI 判定无宿主，行为与 v50 之前一致（ask 直接终结为拒绝），有界且如实。
    try {
      return await this.#createPermissionChannel({ runId, sessionId, agentId, timeoutMs });
    } catch (error) {
      void this.eventStore.emit(
        "approval.channel_unavailable",
        { adapter: this.id, reason: String(error?.message || error).slice(0, 200) },
        { runId, sessionId, agentId, sensitivity: "sensitive" },
      ).catch(() => {});
      return null;
    }
  }

  async #createPermissionChannel({ runId, sessionId, agentId, timeoutMs }) {
    const endpoint = createPermissionEndpoint({
      runId,
      sessionId,
      agentId,
      // 审批等待上限收在整轮超时之内：两个倒计时赛跑的话，CLI 的进程超时会先杀掉
      // 整轮，操作者的决定就白做了。留 30s 余量给回程与工具实际执行。
      decisionTimeoutMs: Math.max(30_000, timeoutMs - 30_000),
      decide: async (request) => {
        // broker 认 `{method, params}`：method 查白名单表（`approval-methods.mjs`），
        // params 是审批卡要渲染给操作者看的内容，也是 actionSha256 的哈希输入。
        // 工具名与真实入参必须原样进 params —— 卡上显示的就是将要执行的那份
        // （v1 禁 updatedInput，所以不存在"显示 A 执行 B"的缝）。
        const wire = await this.approvalResolver({
          method: CLAUDE_TOOL_PERMISSION_METHOD,
          params: { toolName: request.toolName, input: request.input, toolUseId: request.toolUseId },
        }, { runId, sessionId: request.sessionId, agentId: request.agentId });
        // broker 回 `{decision:"accept"|"decline"}`；只有显式 accept 才算批准。
        return { approved: wire?.decision === "accept" };
      },
      emit: (type, data) => { void this.eventStore.emit(type, data, { runId, sessionId, agentId, sensitivity: "sensitive" }).catch(() => {}); },
    });
    await endpoint.ready;

    // 端点已起、脚本还没写成时若抛错，端点会悬着不关 —— 这里兜住。
    let dir = null;
    try {
      dir = await mkdtemp(join(tmpdir(), "cc-approval-"));
      const scriptPath = join(dir, "permission-server.mjs");
      await writeFile(scriptPath, buildPermissionServerSource({
        runId,
        sessionId: sessionId || runId,
        endpointPath: endpoint.path,
        timeoutMs: Math.max(30_000, timeoutMs - 30_000),
      }), "utf8");

      const configPath = join(dir, "mcp.json");
      await writeFile(configPath, JSON.stringify({
        mcpServers: {
          [PERMISSION_MCP_SERVER_NAME]: { type: "stdio", command: process.execPath, args: [scriptPath] },
        },
      }), "utf8");

      const scratchDir = dir;
      return {
        configPath,
        // 轮末必删：脚本内联着本轮归属，留在盘上既是信息泄露也是下一轮的混淆源
        dispose: async () => {
          await endpoint.close().catch(() => {});
          await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
        },
      };
    } catch (error) {
      await endpoint.close().catch(() => {});
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async send(request) {
    const nativeSessionId = request.sessionId || randomUUID();
    const permissionChannel = await this.#openPermissionChannel({
      runId: request.runId,
      sessionId: nativeSessionId,
      agentId: request.agentId ?? "claude-fable",
      timeoutMs: request.timeoutMs ?? 15 * 60_000,
    });
    // finally 而非在各 return/throw 前手动清理：`#sendTurn` 有多条抛错退出路径
    // （预算耗尽 / 未登录 / 上游 5xx / 进程超时…），漏掉任何一条都会在盘上
    // 留下内联着 runId 的脚本，并让管道悬着不关。
    try {
      return await this.#sendTurn(request, { nativeSessionId, permissionChannel });
    } finally {
      await permissionChannel?.dispose();
    }
  }

  async #sendTurn({ sessionId, prompt, runId, agentId = "claude-fable", signal, permissionMode = "plan", maxBudgetUsd = 2, timeoutMs = 15 * 60_000, model = null, effort = null, cwd = null, nativeCommand = false, nativeApprovalMode = null, onSessionStarted, onTurnSubmitting }, { nativeSessionId, permissionChannel }) {
    const clientUserMessageId = randomUUID();
    const effectiveRequestedModel = model || this.model; // /model 会话级覆盖（orchestrator 已白名单校验）
    const effectiveCwd = cwd || this.cwd; // 会话项目地址：CLI 在此目录跑，原生会话自动归属对应项目
    // 真实 CLI 对话：不再禁用工具（--tools ""）；运行席位按当前 permissionMode 使用实际 CLI 工具能力。
    // 权限走 CLI 原生模式：plan/read-only=只读探索；workspace-write（经审批的 build 轮）=acceptEdits。
    // 保留 --strict-mcp-config：headless 下用户级 MCP 无法交互认证，加载即挂起（明示的能力边界）。
    // 不用 --bare：它把认证限死为 ANTHROPIC_API_KEY（OAuth/keychain 永不读取），登录态用户必然
    // "Not logged in"。hooks 隔离改由 settingsFile 的 disableAllHooks 承担——OAuth 可用 + 全局
    // route/stop/mirror-gate 不注入子进程（2026-07-18 双向实测：无 --bare 登录态直接可用；
    // disableAllHooks 后体检卡不再混入输出）。
    const args = buildClaudeArgs({
      sessionId,
      nativeSessionId,
      requestedModel: effectiveRequestedModel,
      permissionMode,
      maxBudgetUsd,
      effort,
      settingsFile: this.settingsFile,
      systemPromptFile: this.systemPromptFile,
      nativeCommand,
      nativeApprovalMode,
      permissionMcpConfigPath: permissionChannel?.configPath ?? null,
    });

    let finalText = "";
    let resolvedSessionId = nativeSessionId;
    let effectiveModel = this.model;
    let costUsd = null;
    let tokens = null;
    let terminalError = null;
    let terminalResult = null;
    const pendingEvents = [];
    const collector = createLfCollector(
      (event) => {
        if (event?.type === "system" && event?.subtype === "init" && event.model) effectiveModel = event.model;
        if (event?.type === "result") {
          terminalResult = event;
          costUsd = event.total_cost_usd ?? costUsd;
          // 真实错误常在 result 字段（如 "Not logged in · Please run /login"）；subtype 可能误报 "success"。
          // 优先 errors → result 文本 → subtype，绝不用误导性 subtype 掩盖真因（诚实错误报告）。
          if (event.is_error) {
            terminalError =
              event.errors?.join("; ") ||
              (typeof event.result === "string" && event.result.trim()) ||
              (event.subtype && event.subtype !== "success" ? event.subtype : "") ||
              "Claude returned an error result";
          }
        }
        const normalized = publicClaudeEvent(event);
        if (!normalized) return;
        resolvedSessionId = normalized.sessionId || resolvedSessionId;
        if (normalized.type === "assistant.message" && normalized.text) finalText = normalized.text;
        if (normalized.type === "turn.completed") {
          if (normalized.text) finalText = normalized.text;
          tokens = normalized.tokens ?? tokens;
        }
        pendingEvents.push(
          this.eventStore.emit(normalized.type, normalized, {
            runId,
            sessionId: resolvedSessionId,
            agentId,
          }),
        );
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
      cwd: effectiveCwd,
      input: prompt,
      timeoutMs,
      signal,
      // 启用工具的真实 CLI 轮次：每个 tool_result 原文全量走 stdout，2MB 默认上限会中途强杀整轮。
      // 64MB 容纳带大文件 Read/grep 的正常长轮次（本地单用户控制面，内存可接受）。
      maxOutputBytes: 64 * 1024 * 1024,
      onStdout: (chunk) => collector.push(chunk),
    });
    collector.end();
    await Promise.all(pendingEvents);
    if (terminalResult?.is_error) {
      const usage = claudeResultUsage(terminalResult);
      const errorText = terminalError || "Claude returned an error result";
      // 上游 API 额度耗尽常以 403 + 余额文案出现（DeepSeek "额度不足"、Anthropic "insufficient credits" 等），
      // 与本机 --max-budget-usd 触发的 subtype=error_max_budget_usd 同源——都是钱没了，止损策略一致。
      const upstreamBudgetPattern = /额度不足|insufficient\s+(?:credits|balance|funds)|remaining\s+(?:credit|balance).*[¥$]-|quota\s+exceeded|rate.*limit.*exhausted/i;
      const failureKind = terminalResult.subtype === "error_max_budget_usd"
        || /reached maximum budget/i.test(errorText)
        || upstreamBudgetPattern.test(errorText)
        ? "budget_exhausted"
        : /content block not found/i.test(errorText)
          ? "content_block_error"
          : /(?:API Error|HTTP)\s*[: ]\s*5\d{2}\b/i.test(errorText)
            ? "upstream_5xx"
            : "provider_error";
      const error = new Error(errorText);
      error.code = failureKind === "budget_exhausted"
        ? "CLAUDE_BUDGET_EXHAUSTED"
        : failureKind === "content_block_error"
          ? "CLAUDE_CONTENT_BLOCK_ERROR"
          : failureKind === "upstream_5xx" ? "CLAUDE_UPSTREAM_5XX" : "CLAUDE_FAILED";
      Object.assign(error, {
        failureKind,
        retryable: failureKind === "upstream_5xx",
        nativeTurnSettled: true,
        providerResultReceived: true,
        sessionId: terminalResult.session_id || resolvedSessionId,
        sessionResumable: true,
        protocol: "stream-json-resume",
        clientUserMessageId,
        costUsd: usage.costUsd,
        tokens: usage.tokens,
        resultSubtype: terminalResult.subtype || null,
        stopReason: terminalResult.stop_reason || null,
      });
      throw error;
    }
    if (!terminalResult && (result.code !== 0 || terminalError)) {
      let message = terminalError || result.stderr.trim() || `Claude exited ${result.code}`;
      // 已弃 --bare，headless 子进程与交互 CLI 同源读 OAuth 登录态——报未登录即真的未登录
      if (/not logged in|please run \/login|authentication_failed/i.test(message)) {
        message = `${message} — 在任意终端运行 claude 并完成 /login（或导出 ANTHROPIC_API_KEY）后重试。`;
      }
      const error = new Error(message);
      // 上游额度耗尽也可能走非 result 路径（子进程被远端 403 后直接退出，无 stream event）
      const upstreamBudgetPattern = /额度不足|insufficient\s+(?:credits|balance|funds)|remaining\s+(?:credit|balance).*[¥$]-|quota\s+exceeded|rate.*limit.*exhausted/i;
      if (upstreamBudgetPattern.test(message)) {
        error.code = "CLAUDE_BUDGET_EXHAUSTED";
        error.failureKind = "budget_exhausted";
      } else {
        error.code = "CLAUDE_FAILED";
      }
      throw error;
    }
    return {
      sessionId: resolvedSessionId,
      text: finalText,
      nativePersistence: true,
      protocol: "stream-json-resume",
      requestedModel: effectiveRequestedModel,
      effectiveModel,
      costUsd,
      tokens,
    };
  }
}
