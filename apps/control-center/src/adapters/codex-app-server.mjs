import { randomUUID } from "node:crypto";
import { attachLfJsonl, encodeJsonLine } from "../jsonl.mjs";
import { childProcessEnv, spawnCommand, terminateChildProcess, terminateChildProcessAndWait } from "../process-runner.mjs";
import { preparePromptTransport } from "../prompt-transport.mjs";
import {
  createScrubbedLineCollector,
  DEFAULT_MAX_TURN_OUTPUT_BYTES,
  measureUtf8Append,
} from "./stream-utils.mjs";

const DEFAULT_OUTPUT_LIMIT_SETTLE_MS = 2_000;
const DEFAULT_EVENT_PERSISTENCE_TIMEOUT_MS = 1_000;
const DEFAULT_LIFECYCLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONTEXT_COMPACTION_TIMEOUT_MS = 5 * 60_000;
// 压缩收尾时打断原生轮的等待上限，必须显著小于编排器的中断闸（interruptTimeoutMs 默认 30s）。
// 两者取同值时，压缩窗口内的一次中断会让执行链恰好卡在闸的上限才 settle：run 被写成
// recovery_required，而 interruptingRuns 的释放只挂在 settlement.finally 上——此后每一次
// 「继续」都撞 RUN_INTERRUPTING，正是原报障的另一半"无法继续执行"。
const CONTEXT_COMPACTION_INTERRUPT_MS = 10_000;
// 双闸看门狗：静默闸测"挂死"（无任何原生事件即杀），总时长闸（send 的 timeoutMs）测"跑飞"。
// 静默闸必须远小于总时长闸才有意义；<=0 或非法值如实关闭静默闸，只留总时长兜底。
const DEFAULT_TURN_IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_LATE_RESPONSES = 64;
const DEFINITIVE_TURN_REJECTION_MARKERS = new Set(["INSUFFICIENT_BALANCE"]);
const CONTEXT_WINDOW_EXCEEDED_TEXT = /(?:ran out of room in the model'?s context window|context window (?:was )?(?:exceeded|is full)|maximum context length)/i;
const ACTIVE_WRITER_TEXT = /already has an active writer/i;

function codexErrorInfoKind(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.codexErrorInfo === "string") return value.codexErrorInfo;
  if (value.codexErrorInfo && typeof value.codexErrorInfo === "object") {
    return Object.keys(value.codexErrorInfo)[0] || null;
  }
  return Object.keys(value)[0] || null;
}

function nativeTurnError(turnError, { threadId, turnId } = {}) {
  // turn.error 存在即代表这一轮失败了。此前以 `!turnError?.message` 判空返回 null，只要 provider
  // 报错但未附 message（只给 codexErrorInfo / 只给字符串），失败轮就会走成功分支被结算成
  // "成功但正文为空"——contextWindowExceeded 落进这里就等于压缩恢复整条链不触发。这是 silent
  // fallback，按 §二.3 不允许：错误存在必须产出错误，message 缺失时用 errorInfo kind 兜底。
  if (turnError == null) return null;
  const raw = typeof turnError === "string" ? { message: turnError } : turnError;
  if (typeof raw !== "object") return null;
  const errorInfoKind = codexErrorInfoKind(raw.codexErrorInfo);
  const message = String(raw.message ?? "").trim()
    || (errorInfoKind ? `Codex turn failed: ${errorInfoKind}` : "Codex turn failed without an error message");
  const contextWindowExceeded = errorInfoKind === "contextWindowExceeded"
    || CONTEXT_WINDOW_EXCEEDED_TEXT.test(message);
  return Object.assign(new Error(message), {
    code: contextWindowExceeded ? "CONTEXT_WINDOW_EXCEEDED" : "CODEX_TURN_FAILED",
    codexErrorInfo: raw.codexErrorInfo ?? null,
    providerAdditionalDetails: raw.additionalDetails ?? null,
    nativeTurnSettled: true,
    requiresContextCompaction: contextWindowExceeded,
    sessionResumable: true,
    sessionId: threadId || null,
    turnId: turnId || null,
  });
}

function isDefinitiveTurnRejection(error) {
  if (error?.rpcResponseError !== true || error.rpcMethod !== "turn/start") return false;
  if (error.rpcErrorData?.submissionRejected === true) return true;
  if (error.nativeSessionBusy === true) return true;
  const marker = String(error.message ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return [402, 403].includes(Number(error.code)) && DEFINITIVE_TURN_REJECTION_MARKERS.has(marker);
}

function requestAbortReason(signal) {
  return signal?.reason ?? Object.assign(new Error("Codex app-server request aborted"), {
    name: "AbortError",
    code: "ABORTED",
  });
}

function waitForAbortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(requestAbortReason(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, requestAbortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal.aborted) onAbort();
  });
}

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
  "item/permissions/requestApproval",
]);

// Codex 官方权限档（与 Codex 桌面批准菜单一致）：原生组合 id → thread/start 的
// sandbox + approvalPolicy。返回 null = 自定义（config.toml）——不下发任何覆盖，
// 由 CLI 自己的 config.toml 决定权限，与官方「自定义」档语义一致。
// 未知/只读档一律 fail-closed 到 read-only + on-request。
export function codexPermissionPreset(permissionMode = "read-only") {
  switch (permissionMode) {
    case "workspace-write":
      // 请求批准：工作区内可写，外部文件与网络始终升级为审批请求（on-request）
      return { sandbox: "workspace-write", approvalPolicy: "on-request" };
    case "workspace-write:on-failure":
      // 帮我批准：沙箱内自动执行，仅被沙箱拦下的风险操作升级为审批请求（on-failure）
      return { sandbox: "workspace-write", approvalPolicy: "on-failure" };
    case "danger-full-access":
      // 完全访问权限：不限制互联网与文件，不询问（never）
      return { sandbox: "danger-full-access", approvalPolicy: "never" };
    case "config-default":
      return null;
    default:
      return { sandbox: "read-only", approvalPolicy: "on-request" };
  }
}

const TEXT_DELTA_METHODS = new Set([
  "item/agentMessage/delta",
  "item/outputText/delta",
  "item/output_text/delta",
  "response/output_text/delta",
]);

function isTurnScopedNotification(method) {
  return method.startsWith("turn/") || method.startsWith("item/") || TEXT_DELTA_METHODS.has(method);
}

const PRE_ACK_MAX_TURNS = 8;
const PRE_ACK_MAX_EVENTS = 256;
const PRE_ACK_MAX_DELTA_CHARS = 64 * 1024;
const PRE_ACK_MAX_PAYLOAD_BYTES = 512 * 1024;

// 过程可见性上界：Codex 的一条命令可以吐几 MB，一次改动可以覆盖上百文件。事件是要落盘并
// 长期回放的，所以每条只留够看懂发生了什么的量，其余按"已截断"如实标注，不假装完整。
const PROGRESS_OUTPUT_LIMIT = 4 * 1024;
const PROGRESS_DIFF_LIMIT = 2 * 1024;
const PROGRESS_TEXT_LIMIT = 2 * 1024;
const PROGRESS_CHANGE_LIMIT = 20;

/** 头尾各留一段：命令输出的结论与报错通常在尾部，只留头部等于把最有用的信息裁掉。 */
function boundedProgressText(value, limit) {
  const text = progressValueText(value);
  if (text.length <= limit) return { text, truncated: false };
  const head = Math.floor(limit * 0.4);
  return { text: `${text.slice(0, head)}\n…\n${text.slice(text.length - (limit - head))}`, truncated: true };
}

function progressValueText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/** 这些 item 不是"工具调用卡"。其余未知工作 item 一律落 tool 卡，不许再静默丢掉。 */
const SILENT_ITEM_TYPES = new Set([
  "usermessage",
  "hookprompt",
  "agentmessage",
  "plan",
  "reasoning",
  "commandexecution",
  "filechange",
  "contextcompaction",
  "enteredreviewmode",
  "exitedreviewmode",
]);

/** 工具调用 item 类型（归一化 key，与 codex app-server v2 JSON Schema 的 ThreadItem 枚举对齐）。
 *  collabAgentToolCall / subAgentActivity 无 server/tool 字段，必须显式列名，
 *  否则靠 `item.server || item.tool` 兜不住，整条工具卡又会静默蒸发。 */
const TOOL_ITEM_TYPES = new Set([
  "mcptoolcall",
  "dynamictoolcall",
  "collabagenttoolcall",
  "websearch",
  "subagentactivity",
]);

function itemTypeKey(type) {
  return String(type || "").replace(/_/g, "").toLowerCase();
}

/** 子代理活动 → 中文动词（codex app-server v2 SubAgentActivityKind：started/interacted/interrupted）。 */
const SUB_AGENT_ACTIVITY_VERBS = Object.freeze({
  started: "已启动",
  interacted: "已交互",
  interrupted: "已中断",
});

function stringField(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function parseMaybeJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text || (text[0] !== "{" && text[0] !== "[")) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function objectField(value, key) {
  const parsed = parseMaybeJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  return stringField(parsed[key], parsed[camelToSnake(key)], parsed[snakeToCamel(key)]);
}

function camelToSnake(value) {
  return String(value).replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function snakeToCamel(value) {
  return String(value).replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function enumText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.type === "string") return value.type;
  return "";
}

function mcpNamespace(value) {
  return stringField(value).replace(/^mcp__/i, "");
}

function firstAgentPath(item) {
  const direct = stringField(item.agentPath, item.agent_path);
  if (direct) return direct;
  const task = objectField(item.arguments ?? item.args, "task_name")
    || objectField(item.result, "task_name")
    || objectField(item.output, "task_name");
  if (!task) return "";
  return task.startsWith("/") ? task : `/root/${task}`;
}

function toolItemName(item) {
  const path = firstAgentPath(item);
  if (path) return path;
  const server = mcpNamespace(item.server) || mcpNamespace(item.namespace);
  const tool = stringField(typeof item.tool === "string" ? item.tool : "", item.name, enumText(item.tool));
  if (server && tool) return `${server}.${tool}`;
  if (tool) return tool;
  if (server) return server;
  // webSearch 没有 server/tool 字段，只有 query——固定用协议名，别把 query 当工具名顶掉
  if (itemTypeKey(item.type) === "websearch") return "web_search";
  return stringField(item.title, item.path) || String(item.type || "tool");
}

function toolItemInput(item) {
  return item.arguments ?? item.args ?? item.input ?? item.params ?? item.query ?? item.prompt ?? item.path ?? null;
}

/** MCP/动态工具的输出块 → 纯文本：优先 content 数组里的 text 字段，别把整块 JSON 泼进会话流。 */
function contentBlocksToText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object" && typeof block.text === "string") return block.text;
      return "";
    })
    .filter((part) => part)
    .join("\n");
}

function toolItemOutput(item) {
  // 错误优先（MCP 错误是 { message }，dynamic 错误可能是字符串）——有错且无正常结果才展示
  if (item.error != null && item.result == null) {
    const message = typeof item.error === "string" ? item.error : (item.error?.message ?? "");
    if (message) return message;
  }
  // MCP result = { content:[{type:"text",text}], structuredContent }——展开 content 的 text
  if (item.result && typeof item.result === "object" && !Array.isArray(item.result)) {
    const text = contentBlocksToText(item.result.content);
    if (text) return text;
    if (item.result.structuredContent != null) return item.result.structuredContent;
  }
  if (Array.isArray(item.contentItems)) {
    const text = contentBlocksToText(item.contentItems);
    if (text) return text;
  }
  if (Array.isArray(item.content_items)) {
    const text = contentBlocksToText(item.content_items);
    if (text) return text;
  }
  if (Array.isArray(item.results)) return item.results;
  return item.result ?? item.aggregatedOutput ?? item.output ?? item.content ?? "";
}

/** 落盘用的短快照：旧会话没有 progress 时，前端还能凭 itemType/agentPath 把工具卡画出来。 */
export function compactCodexItemHint(item) {
  if (!item || typeof item !== "object") return undefined;
  const hint = {
    type: typeof item.type === "string" ? item.type : null,
    id: typeof item.id === "string" ? item.id : null,
    server: stringField(item.server) || null,
    namespace: stringField(item.namespace) || null,
    tool: stringField(typeof item.tool === "string" ? item.tool : "", enumText(item.tool)) || null,
    name: stringField(item.name, item.title) || null,
    agentPath: firstAgentPath(item) || null,
    status: stringField(item.status, enumText(item.kind)) || null,
  };
  return Object.values(hint).some((value) => value) ? hint : undefined;
}

/** reasoning item 的 summary/content 是分段数组；各家分段结构不同，只捞得出文本的部分。 */
function reasoningText(item) {
  const parts = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])];
  return parts
    .map((part) => (typeof part === "string" ? part : part?.text ?? part?.summary ?? ""))
    .filter((part) => typeof part === "string" && part)
    .join("\n");
}

/**
 * item 通知 → 会话流能渲染的过程载荷。字段名全部来自 codex app-server v2 实测抓包
 * （2026-08-08，codex 0.146.0）：commandExecution 的干净命令在 commandActions[].command，
 * 完整输出在完成时的 aggregatedOutput；fileChange 的改动在 changes[{path,kind.type,diff}]。
 * 返回 null 表示这条通知没有可展示的过程内容——调用方据此不落多余事件。
 */
export function codexItemProgress(method, params) {
  const item = params?.item;
  if (!item || typeof item !== "object") return null;
  const started = method === "item/started";
  const id = typeof item.id === "string" ? item.id : null;
  if (item.type === "commandExecution") {
    const command = item.commandActions?.find?.((action) => typeof action?.command === "string")?.command
      ?? (typeof item.command === "string" ? item.command : "");
    const output = started ? { text: "", truncated: false } : boundedProgressText(item.aggregatedOutput, PROGRESS_OUTPUT_LIMIT);
    return {
      kind: "command",
      id,
      command: boundedProgressText(command, PROGRESS_TEXT_LIMIT).text,
      cwd: typeof item.cwd === "string" ? item.cwd : null,
      status: typeof item.status === "string" ? item.status : null,
      exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null,
      durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null,
      output: output.text,
      outputTruncated: output.truncated,
    };
  }
  if (item.type === "fileChange") {
    const all = Array.isArray(item.changes) ? item.changes : [];
    return {
      kind: "file",
      id,
      status: typeof item.status === "string" ? item.status : null,
      changesTotal: all.length,
      changes: all.slice(0, PROGRESS_CHANGE_LIMIT).map((change) => {
        const diff = started ? { text: "", truncated: false } : boundedProgressText(change?.diff, PROGRESS_DIFF_LIMIT);
        return {
          path: typeof change?.path === "string" ? change.path : "",
          change: typeof change?.kind?.type === "string" ? change.kind.type : (typeof change?.kind === "string" ? change.kind : null),
          diff: diff.text,
          diffTruncated: diff.truncated,
        };
      }),
    };
  }
  // 非 final_answer 的 agentMessage 是 Codex 边干边说的旁白——它只会被后一条正文覆盖掉，
  // 这正是 LO 说"只看得到审批"缺的那一半。final_answer 走 assistant.message 正常通道，不重复。
  if (item.type === "agentMessage" && !started && item.phase && item.phase !== "final_answer") {
    const text = boundedProgressText(item.text, PROGRESS_TEXT_LIMIT);
    return text.text ? { kind: "note", id, phase: String(item.phase), text: text.text, truncated: text.truncated } : null;
  }
  if (TOOL_ITEM_TYPES.has(itemTypeKey(item.type)) || item.server || item.tool || item.arguments || item.args) {
    // app-server 的 started item 已经携带有界工具参数。保留它，实时活动行才能在
    // 工具完成前显示实际命令/路径；输出仍只接受 completed，绝不猜测执行结果。
    const input = boundedProgressText(toolItemInput(item), PROGRESS_TEXT_LIMIT);
    const output = started ? { text: "", truncated: false } : boundedProgressText(toolItemOutput(item), PROGRESS_OUTPUT_LIMIT);
    const isSubAgent = itemTypeKey(item.type) === "subagentactivity";
    return {
      kind: "tool",
      id,
      name: toolItemName(item),
      server: typeof item.server === "string" ? item.server : null,
      status: typeof item.status === "string" ? item.status : null,
      verb: isSubAgent ? (SUB_AGENT_ACTIVITY_VERBS[item.kind] ?? "已启动") : null,
      input: input.text,
      inputTruncated: input.truncated,
      output: output.text,
      outputTruncated: output.truncated,
    };
  }
  if (item.type === "reasoning") {
    // started：无摘要也发「思考开始」信号——活跃呼吸行据此显示「正在思考」（LO 2026-08-10）。
    // item/started 只喂活跃行、不进历史卡（前端只收 completed），不添噪声。
    if (started) return { kind: "reasoning", id, started: true };
    const text = boundedProgressText(reasoningText(item), PROGRESS_TEXT_LIMIT);
    // 反代供应商通常不下发推理摘要（实测 summary/content 皆空）——摘要落空、历史卡不收；
    // 但 id 要留住：started 侧已记活跃，completed 没 id 前端清不掉，「正在思考」会残留成假活
    return text.text ? { kind: "reasoning", id, text: text.text, truncated: text.truncated } : (id ? { kind: "reasoning", id } : null);
  }
  return null;
}

function tomlValue(value) {
  return JSON.stringify(value);
}

export function buildIsolatedMcpArgs(servers = []) {
  const args = ["-c", "mcp_servers={}"];
  for (const server of servers) {
    const name = String(server?.name || "");
    if (!/^[A-Za-z0-9_-]+$/.test(name) || typeof server?.command !== "string" || !server.command) {
      const error = new Error("isolated MCP servers require a safe name and non-empty command");
      error.code = "INVALID_MCP_CONFIG";
      throw error;
    }
    const serverArgs = server.args ?? [];
    const envVars = server.envVars ?? [];
    if (!Array.isArray(serverArgs) || serverArgs.some((value) => typeof value !== "string")) {
      throw Object.assign(new Error(`isolated MCP server ${name} args must be strings`), { code: "INVALID_MCP_CONFIG" });
    }
    if (!Array.isArray(envVars) || envVars.some((value) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))) {
      throw Object.assign(new Error(`isolated MCP server ${name} envVars must be environment names`), { code: "INVALID_MCP_CONFIG" });
    }
    args.push("-c", `mcp_servers.${name}.command=${tomlValue(server.command)}`);
    args.push("-c", `mcp_servers.${name}.args=${tomlValue(serverArgs)}`);
    if (envVars.length) args.push("-c", `mcp_servers.${name}.env_vars=${tomlValue(envVars)}`);
    if (server.startupTimeoutSec != null) {
      if (!Number.isInteger(server.startupTimeoutSec) || server.startupTimeoutSec < 1) {
        throw Object.assign(new Error(`isolated MCP server ${name} startup timeout is invalid`), { code: "INVALID_MCP_CONFIG" });
      }
      args.push("-c", `mcp_servers.${name}.startup_timeout_sec=${server.startupTimeoutSec}`);
    }
    if (server.toolTimeoutSec != null) {
      if (!Number.isInteger(server.toolTimeoutSec) || server.toolTimeoutSec < 1) {
        throw Object.assign(new Error(`isolated MCP server ${name} tool timeout is invalid`), { code: "INVALID_MCP_CONFIG" });
      }
      args.push("-c", `mcp_servers.${name}.tool_timeout_sec=${server.toolTimeoutSec}`);
    }
  }
  return args;
}

export class CodexAppServerAdapter {
  constructor({
    command = "codex",
    model = null,
    eventStore,
    cwd,
    approvalResolver = null,
    spawnImpl = spawnCommand,
    disableMcp = true,
    mcpServers = [],
    environmentProvider = "openai",
    runtimeProfileId = "codex-technical",
    environmentAllowlist = null,
    environmentBase = process.env,
    deltaFlushMs = 40,
    deltaFlushChars = 3 * 1024,
    deltaScheduler = null,
    maxTurnOutputBytes = DEFAULT_MAX_TURN_OUTPUT_BYTES,
    outputLimitSettleMs = DEFAULT_OUTPUT_LIMIT_SETTLE_MS,
    eventPersistenceTimeoutMs = DEFAULT_EVENT_PERSISTENCE_TIMEOUT_MS,
    lifecycleTimeoutMs = DEFAULT_LIFECYCLE_TIMEOUT_MS,
    lifecycleScheduler = null,
  }) {
    this.id = "codex-app-server";
    this.command = command;
    this.model = model;
    this.eventStore = eventStore;
    this.cwd = cwd;
    this.approvalResolver = approvalResolver;
    this.spawnImpl = spawnImpl;
    this.disableMcp = disableMcp;
    this.mcpServers = mcpServers;
    this.environmentProvider = environmentProvider;
    this.runtimeProfileId = runtimeProfileId;
    this.environmentAllowlist = environmentAllowlist;
    this.environmentBase = environmentBase;
    this.deltaFlushMs = deltaFlushMs;
    this.deltaFlushChars = deltaFlushChars;
    this.maxTurnOutputBytes = maxTurnOutputBytes;
    this.outputLimitSettleMs = outputLimitSettleMs;
    this.eventPersistenceTimeoutMs = eventPersistenceTimeoutMs;
    this.lifecycleTimeoutMs = lifecycleTimeoutMs;
    this.lifecycleScheduler = lifecycleScheduler || {
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (timer) => clearTimeout(timer),
    };
    this.deltaScheduler = deltaScheduler || {
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (timer) => clearTimeout(timer),
    };
    if (!Number.isFinite(deltaFlushMs) || deltaFlushMs < 1 || !Number.isInteger(deltaFlushChars) || deltaFlushChars < 1) {
      throw Object.assign(new Error("Codex delta coalescer limits must be positive"), { code: "INVALID_DELTA_POLICY" });
    }
    if (!Number.isSafeInteger(maxTurnOutputBytes) || maxTurnOutputBytes < 1
      || !Number.isSafeInteger(outputLimitSettleMs) || outputLimitSettleMs < 1) {
      throw Object.assign(new Error("Codex output limits must be positive safe integers"), { code: "INVALID_OUTPUT_POLICY" });
    }
    if (!Number.isSafeInteger(eventPersistenceTimeoutMs) || eventPersistenceTimeoutMs < 1) {
      throw Object.assign(new Error("Codex event persistence timeout must be a positive safe integer"), { code: "INVALID_EVENT_POLICY" });
    }
    if (!Number.isSafeInteger(lifecycleTimeoutMs) || lifecycleTimeoutMs < 1) {
      throw Object.assign(new Error("Codex lifecycle timeout must be a positive safe integer"), { code: "INVALID_EVENT_POLICY" });
    }
    if (typeof this.lifecycleScheduler.setTimeout !== "function" || typeof this.lifecycleScheduler.clearTimeout !== "function") {
      throw Object.assign(new Error("Codex lifecycle scheduler requires setTimeout and clearTimeout"), { code: "INVALID_EVENT_POLICY" });
    }
    if (typeof this.deltaScheduler.setTimeout !== "function" || typeof this.deltaScheduler.clearTimeout !== "function") {
      throw Object.assign(new Error("Codex delta scheduler requires setTimeout and clearTimeout"), { code: "INVALID_DELTA_POLICY" });
    }
    this.child = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.lateResponses = new Map();
    this.compensationReservations = new Set();
    this.loadedThreads = new Set();
    this.activeByThread = new Map();
    this.compactionsByThread = new Map();
    this.startPromise = null;
    this.failPromise = null;
  }

  write(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server is not writable");
    this.child.stdin.write(encodeJsonLine(message));
  }

  emitBestEffort(type, data, context = {}) {
    void Promise.resolve()
      .then(() => this.eventStore.emit(type, data, context))
      .catch(() => {});
  }

  async waitForLifecycle(callback, data, phase, signal, timeoutMs = this.lifecycleTimeoutMs) {
    if (typeof callback !== "function") return;
    if (signal?.aborted) throw requestAbortReason(signal);
    let timer;
    let settled = false;
    let onAbort;
    const execution = Promise.resolve().then(() => callback(data));
    await new Promise((resolve, reject) => {
      const finish = (callbackFn, value) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) this.lifecycleScheduler.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        callbackFn(value);
      };
      onAbort = () => finish(reject, requestAbortReason(signal));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
      } else {
        timer = this.lifecycleScheduler.setTimeout(() => finish(reject, Object.assign(
          new Error(`Codex ${phase} lifecycle callback timed out`),
          { code: "APP_SERVER_LIFECYCLE_TIMEOUT", lifecyclePhase: phase },
        )), timeoutMs);
      }
      execution.then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
    });
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (this.child) return;
    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async startInternal() {
    const args = ["-c", "features.code_mode_host=false"];
    if (this.mcpServers.length) args.push(...buildIsolatedMcpArgs(this.mcpServers));
    else if (this.disableMcp) args.push("-c", "mcp_servers={}");
    args.push("app-server", "--stdio");
    const child = this.spawnImpl(this.command, args, {
      cwd: this.cwd,
      env: childProcessEnv({}, this.environmentBase, {
        provider: this.environmentProvider,
        providerKeys: this.environmentAllowlist,
      }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    this.child = child;
    attachLfJsonl(
      child.stdout,
      (message) => {
        if (this.child === child) this.handleMessage(message);
      },
      (error, line) => {
        if (this.child === child) {
          this.emitBestEffort(
            "adapter.parse_error",
            { adapter: this.id, message: error.message, sample: line.slice(0, 240) },
            { agentId: this.runtimeProfileId },
          );
        }
      },
    );
    child.once("error", (error) => {
      if (this.child === child) void this.failAll(error);
    });
    child.once("exit", (code) => {
      if (this.child !== child) return;
      const error = new Error(`Codex app-server exited ${code}`);
      error.code = "APP_SERVER_EXIT";
      void this.failAll(error);
      this.child = null;
    });
    const stderrCollector = createScrubbedLineCollector((safeText) => {
      if (this.child !== child) return;
      const message = safeText.trim();
      if (message) this.emitBestEffort(
        "adapter.stderr",
        { adapter: this.id, message: message.slice(-2000) },
        { agentId: this.runtimeProfileId },
      );
    });
    child.stderr.on("data", (chunk) => {
      if (this.child === child) stderrCollector.push(chunk);
    });
    child.stderr.once("end", () => stderrCollector.end());
    try {
      await this.request("initialize", {
        clientInfo: { name: "514cc-control-center", title: "514cc Control Center", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      this.write({ method: "initialized", params: {} });
    } catch (error) {
      terminateChildProcess(child);
      if (this.child === child) this.child = null;
      throw error;
    }
  }

  rememberLateResponse(id, method, onLateResponse) {
    if (typeof onLateResponse !== "function") return;
    this.lateResponses.set(id, { method, onLateResponse });
  }

  request(method, params, timeoutMs = 30_000, { signal, onLateResponse } = {}) {
    if (signal?.aborted) return Promise.reject(requestAbortReason(signal));
    const compensable = typeof onLateResponse === "function";
    if (compensable && this.compensationReservations.size >= MAX_LATE_RESPONSES) {
      return Promise.reject(Object.assign(
        new Error("Codex app-server compensation capacity is exhausted"),
        { code: "APP_SERVER_COMPENSATION_BUSY", requestWritten: false },
      ));
    }
    const id = this.nextRequestId++;
    if (compensable) this.compensationReservations.add(id);
    return new Promise((resolve, reject) => {
      let written = false;
      const removeAbortListener = () => signal?.removeEventListener("abort", onAbort);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        removeAbortListener();
        if (written) this.rememberLateResponse(id, method, onLateResponse);
        else this.compensationReservations.delete(id);
        const error = new Error(`${method} timed out`);
        error.code = "APP_SERVER_TIMEOUT";
        reject(error);
      }, timeoutMs);
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        removeAbortListener();
        if (written) this.rememberLateResponse(id, method, onLateResponse);
        else this.compensationReservations.delete(id);
        reject(requestAbortReason(signal));
      };
      this.pending.set(id, { resolve, reject, timer, method, signal, onAbort });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        this.write({ id, method, params });
        written = true;
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.compensationReservations.delete(id);
        removeAbortListener();
        error.requestWritten = false;
        reject(error);
      }
    });
  }

  handleMessage(message) {
    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        const late = this.lateResponses.get(message.id);
        if (!late) return;
        this.lateResponses.delete(message.id);
        this.compensationReservations.delete(message.id);
        void Promise.resolve()
          .then(() => late.onLateResponse(message))
          .catch((error) => this.emitBestEffort(
            "adapter.compensation_failed",
            { adapter: this.id, method: late.method, requestId: message.id, message: error.message },
            { agentId: this.runtimeProfileId },
          ));
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      this.compensationReservations.delete(message.id);
      pending.signal?.removeEventListener("abort", pending.onAbort);
      if (message.error) {
        const messageText = message.error.message || "app-server error";
        const errorInfoKind = codexErrorInfoKind(message.error.data?.codexErrorInfo ?? message.error.data);
        const nativeSessionBusy = pending.method === "turn/start"
          && (ACTIVE_WRITER_TEXT.test(messageText) || errorInfoKind === "activeTurnNotSteerable");
        // An error response does not by itself prove that turn/start had no provider-side effect.
        pending.reject(Object.assign(new Error(messageText), {
          code: nativeSessionBusy ? "TURN_ACTIVE" : message.error.code,
          rpcResponseError: true,
          rpcMethod: pending.method,
          rpcErrorData: message.error.data ?? null,
          nativeSessionBusy,
        }));
      }
      else pending.resolve(message.result);
      return;
    }
    if (Object.hasOwn(message, "id") && message.method) {
      void this.handleServerRequest(message);
      return;
    }
    if (message.method) this.handleNotification(message.method, message.params || {});
  }

  async handleServerRequest(message) {
    const threadId = message.params?.threadId || message.params?.thread?.id || null;
    const active = threadId ? this.activeByThread.get(threadId) : null;
    const eventContext = {
      runId: active?.runId || null,
      sessionId: threadId,
      agentId: active?.agentId || this.runtimeProfileId,
    };
    if (!APPROVAL_METHODS.has(message.method)) {
      await this.eventStore.emit(
        "adapter.server_request_unsupported",
        { adapter: this.id, method: message.method, requestId: message.id },
        { ...eventContext, sensitivity: "internal" },
      ).catch(() => {});
      try { this.write({ id: message.id, error: { code: -32601, message: `unsupported server request: ${message.method}` } }); } catch {}
      return;
    }
    await this.eventStore.emit(
      "approval.requested",
      { adapter: this.id, method: message.method, requestId: message.id, summary: "Codex requested an operator decision" },
      { ...eventContext, sensitivity: "sensitive" },
    ).catch(() => {});
    try {
      let result = await this.approvalResolver?.(message, {
        runId: active?.runId || null,
        sessionId: threadId,
        agentId: active?.agentId || this.runtimeProfileId,
        runtimeProfileId: this.runtimeProfileId,
      });
      if (result == null) {
        if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(message.method)) result = { decision: "decline" };
        else throw Object.assign(new Error("approval requires an interactive operator"), { code: -32001 });
      }
      try { this.write({ id: message.id, result }); } catch {}
    } catch (error) {
      try { this.write({ id: message.id, error: { code: Number(error.code) || -32001, message: error.message } }); } catch {}
    }
  }

  notificationTurnId(params) {
    return params.turnId || params.turn?.id || null;
  }

  activeForNotification(threadId, params, method) {
    if (!threadId) return null;
    const active = this.activeByThread.get(threadId) || null;
    if (!active || active.closing) return null;
    const eventTurnId = this.notificationTurnId(params);
    if (!active.turnId) return null;
    if (isTurnScopedNotification(method) && !eventTurnId) return null;
    if (eventTurnId && active.turnId !== eventTurnId) return null;
    return active;
  }

  deferPreAckNotification(active, method, params, turnId) {
    let bucket = active.preAckByTurn.get(turnId);
    if (!bucket) {
      if (active.preAckByTurn.size >= PRE_ACK_MAX_TURNS) {
        active.preAckSaturated = true;
        return;
      }
      bucket = { events: [], deltaChars: 0, payloadBytes: 0, overflow: false };
      active.preAckByTurn.set(turnId, bucket);
    }
    if (bucket.overflow) return;
    try {
      bucket.payloadBytes += Buffer.byteLength(JSON.stringify(params) ?? "", "utf8");
    } catch {
      bucket.payloadBytes = Number.POSITIVE_INFINITY;
    }
    if (bucket.payloadBytes > PRE_ACK_MAX_PAYLOAD_BYTES) {
      bucket.overflow = true;
      bucket.events = [];
      return;
    }
    const delta = TEXT_DELTA_METHODS.has(method) && typeof params.delta === "string" ? params.delta : null;
    if (delta != null) {
      bucket.deltaChars += delta.length;
      if (bucket.deltaChars > PRE_ACK_MAX_DELTA_CHARS) {
        bucket.overflow = true;
        bucket.events = [];
        return;
      }
      const previous = bucket.events.at(-1);
      if (previous?.method === method) {
        previous.params = { ...previous.params, delta: `${previous.params.delta || ""}${delta}` };
        return;
      }
    }
    if (bucket.events.length >= PRE_ACK_MAX_EVENTS) {
      bucket.overflow = true;
      bucket.events = [];
      return;
    }
    bucket.events.push({ method, params });
  }

  acknowledgeTurn(active, turnId) {
    if (!turnId) return Object.assign(new Error("Codex turn/start returned no turn id"), { code: "APP_SERVER_PROTOCOL" });
    if (active.turnId && active.turnId !== turnId) {
      return Object.assign(new Error(`Codex turn id changed from ${active.turnId} to ${turnId}`), { code: "APP_SERVER_PROTOCOL" });
    }
    const bucket = active.preAckByTurn.get(turnId) || null;
    const saturatedWithoutMatch = active.preAckSaturated && !bucket;
    active.preAckByTurn.clear();
    active.preAckSaturated = false;
    active.turnId = turnId;
    if (active.preAckError) return active.preAckError;
    if (bucket?.overflow || saturatedWithoutMatch) {
      return Object.assign(new Error("Codex emitted too much data before turn/start acknowledgement"), { code: "APP_SERVER_PROTOCOL" });
    }
    for (const notification of bucket?.events || []) this.handleNotification(notification.method, notification.params);
    return null;
  }

  notificationEvent(method, params, threadId) {
    const item = params?.item;
    return {
      type: `codex.${method}`,
      data: {
        method,
        threadId,
        turnId: this.notificationTurnId(params),
        itemType: item?.type || null,
        delta: TEXT_DELTA_METHODS.has(method) ? params.delta : undefined,
        // 过程可见性：只带 itemType 的事件等于"发生过某件事但不告诉你是什么"，
        // 会话流除了审批什么都渲染不出来（LO 2026-08-08 报障的根因之一）
        progress: codexItemProgress(method, params) ?? undefined,
        // 短快照兜底：progress 为 null（字段不识别/边界 item）时，前端仍凭 hint 画降级工具卡，
        // 不重演"CLI 里有、会话框里蒸发"的历史丢件
        hint: compactCodexItemHint(item),
      },
    };
  }

  emitDetachedNotification(method, params, threadId) {
    const event = this.notificationEvent(method, params, threadId);
    this.emitBestEffort(
      event.type,
      event.data,
      { runId: null, sessionId: threadId, agentId: this.runtimeProfileId },
    );
  }

  queueActiveEvent(active, type, data) {
    const emit = async () => {
      if (active.eventPersistenceTimedOut) return;
      const persistence = Promise.resolve().then(() => this.eventStore.emit(
        type,
        data,
        { runId: active.runId || null, sessionId: active.threadId, agentId: active.agentId },
      ));
      const handled = persistence.then(
        () => ({ status: "fulfilled" }),
        (error) => ({ status: "rejected", error }),
      );
      let timer;
      const outcome = await Promise.race([
        handled,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ status: "timeout" }), this.eventPersistenceTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (outcome.status === "timeout") {
        active.eventPersistenceTimedOut = true;
        active.eventPersistenceError = Object.assign(
          new Error(`Codex event persistence exceeded ${this.eventPersistenceTimeoutMs}ms`),
          { code: "EVENT_PERSISTENCE_TIMEOUT" },
        );
      }
      // Rejections remain best-effort. The handled branch is attached in the
      // same tick, so neither rejection nor a later timeout can go unhandled.
    };
    active.eventChain = active.eventChain.then(emit, emit);
    return active.eventChain;
  }

  queueActiveNotification(active, method, params) {
    const event = this.notificationEvent(method, params, active.threadId);
    return this.queueActiveEvent(active, event.type, event.data);
  }

  cancelDeltaFlush(active) {
    if (active.deltaTimer == null) return;
    this.deltaScheduler.clearTimeout(active.deltaTimer);
    active.deltaTimer = null;
  }

  flushDelta(active) {
    if (!active?.deltaBuffer) return active?.eventChain || Promise.resolve();
    const delta = active.deltaBuffer;
    const method = active.deltaMethod || "item/agentMessage/delta";
    const turnId = active.deltaTurnId || active.turnId || null;
    active.deltaBuffer = "";
    active.deltaMethod = null;
    active.deltaTurnId = null;
    return this.queueActiveNotification(active, method, { threadId: active.threadId, turnId, delta });
  }

  enqueueDelta(active, method, params) {
    const delta = params.delta;
    const measurement = measureUtf8Append(active.outputBytes, active.endsWithHighSurrogate, delta);
    if (measurement.bytes > this.maxTurnOutputBytes) {
      this.failActiveOutputLimit(active);
      return;
    }
    const turnId = this.notificationTurnId(params) || active.turnId || null;
    if (active.deltaBuffer && (active.deltaMethod !== method || active.deltaTurnId !== turnId)) {
      this.cancelDeltaFlush(active);
      void this.flushDelta(active);
    }
    active.text += delta;
    active.outputBytes = measurement.bytes;
    active.endsWithHighSurrogate = measurement.endsWithHighSurrogate;
    active.deltaBuffer += delta;
    active.deltaMethod = method;
    active.deltaTurnId = turnId;
    if (active.deltaBuffer.length >= this.deltaFlushChars) {
      this.cancelDeltaFlush(active);
      void this.flushDelta(active);
      return;
    }
    if (active.deltaTimer != null) return;
    active.deltaTimer = this.deltaScheduler.setTimeout(() => {
      active.deltaTimer = null;
      if (!active.closing) void this.flushDelta(active);
    }, this.deltaFlushMs);
  }

  async archiveThread(threadId, { reason = "cancelled thread/start", runId = null, agentId = this.runtimeProfileId } = {}) {
    if (!threadId) return false;
    try {
      await this.request("thread/archive", { threadId }, 10_000);
      this.loadedThreads.delete(threadId);
      this.emitBestEffort(
        "adapter.compensation_succeeded",
        { adapter: this.id, method: "thread/archive", threadId, reason },
        { runId, sessionId: threadId, agentId },
      );
      return true;
    } catch (error) {
      this.emitBestEffort(
        "adapter.compensation_failed",
        { adapter: this.id, method: "thread/archive", threadId, reason, message: error.message },
        { runId, sessionId: threadId, agentId },
      );
      return false;
    }
  }

  async interruptTurn(threadId, turnId, timeoutMs = 30_000, {
    reason = "turn cancellation",
    runId = null,
    agentId = this.runtimeProfileId,
  } = {}) {
    try {
      const result = await this.request("turn/interrupt", { threadId, turnId }, timeoutMs);
      this.emitBestEffort(
        "adapter.interrupt_confirmed",
        { adapter: this.id, threadId, turnId, reason },
        { runId, sessionId: threadId, agentId },
      );
      return result;
    } catch (error) {
      this.emitBestEffort(
        "adapter.interrupt_failed",
        { adapter: this.id, threadId, turnId, reason, message: error.message, code: error.code || null },
        { runId, sessionId: threadId, agentId },
      );
      throw error;
    }
  }

  interruptActive(active, timeoutMs = 30_000) {
    if (!active?.turnId) return Promise.resolve();
    if (active.interruptPromise) return active.interruptPromise;
    active.interruptPromise = this.interruptTurn(active.threadId, active.turnId, timeoutMs, {
      reason: active.cancellationError?.code || active.cancellationError?.message || "turn cancellation",
      runId: active.runId || null,
      agentId: active.agentId,
    });
    void active.interruptPromise.catch(() => {});
    return active.interruptPromise;
  }

  /**
   * 静默看门狗（双闸之一）：每次原生事件（delta/item/turn 通知、审批请求）都重置。
   * 只有连续 idleTimeoutMs 完全无原生流量才判定挂死——慢但健在的轮不会被误杀，
   * 这正是它区别于总时长闸（send 的 timeoutMs 墙钟）的地方。
   */
  armIdleWatchdog(active) {
    if (!active || active.closing) return;
    if (!Number.isFinite(active.idleTimeoutMs) || active.idleTimeoutMs <= 0) return;
    if (active.idleTimer) clearTimeout(active.idleTimer);
    active.idleTimer = setTimeout(() => {
      active.idleTimer = null;
      const current = this.activeByThread.get(active.threadId);
      if (current === active && !current.closing) {
        void this.cancelActive(current, current.outputLimitError || Object.assign(
          new Error(`Codex turn silent for ${Math.round(active.idleTimeoutMs / 1000)}s`),
          { code: "TURN_IDLE_TIMEOUT", timeoutKind: "idle", timeoutMs: active.idleTimeoutMs, idleTimeoutMs: active.idleTimeoutMs },
        ));
      }
    }, active.idleTimeoutMs);
  }

  cancelActive(active, error, { timeoutMs = 30_000 } = {}) {
    if (!active || active.closing) return active?.finalizePromise || Promise.resolve();
    active.cancelling = true;
    active.cancellationError ||= error;
    if (!active.turnId) return Promise.resolve();
    if (active.cancelPromise) return active.cancelPromise;
    const primaryError = active.cancellationError;
    active.cancelPromise = Promise.race([
      this.interruptActive(active, timeoutMs).then(
        () => ({ boundary: "interrupt", error: null }),
        (interruptError) => ({ boundary: "interrupt-failed", error: interruptError }),
      ),
      active.terminalBoundary.then(() => ({ boundary: "terminal", error: null })),
    ]).then(async ({ boundary, error: interruptError }) => {
      if (boundary === "interrupt-failed") {
        primaryError.interruptConfirmed = false;
        primaryError.interruptErrorCode = interruptError?.code || null;
        primaryError.interruptErrorMessage = interruptError?.message || "Codex turn interrupt failed";
      } else {
        primaryError.interruptConfirmed = true;
        primaryError.interruptBoundary = boundary;
      }
      if (!active.finalizePromise) {
        await this.finalizeActive(active.threadId, active, { error: primaryError });
      } else {
        await active.finalizePromise;
      }
    });
    void active.cancelPromise.catch(() => {});
    return active.cancelPromise;
  }

  failActiveOutputLimit(active) {
    if (!active || active.outputLimitError) return active?.outputLimitPromise || Promise.resolve();
    const error = Object.assign(
      new Error(`Codex turn output exceeded ${this.maxTurnOutputBytes} UTF-8 bytes`),
      { code: "OUTPUT_LIMIT", maxOutputBytes: this.maxTurnOutputBytes },
    );
    active.outputLimitError = error;
    this.cancelDeltaFlush(active);
    void this.flushDelta(active);
    active.outputLimitPromise = this.cancelActive(active, error, { timeoutMs: this.outputLimitSettleMs });
    void active.outputLimitPromise.catch(() => {});
    return active.outputLimitPromise;
  }

  failActiveProtocol(threadId, active, message) {
    if (!active || active.closing) return;
    const error = Object.assign(new Error(message), { code: "APP_SERVER_PROTOCOL" });
    void this.cancelActive(active, error);
  }

  finalizeActive(threadId, active, { error = null, result = null, terminal = null } = {}) {
    if (active.finalizePromise) return active.finalizePromise;
    active.closing = true;
    clearTimeout(active.timer);
    if (active.idleTimer) {
      clearTimeout(active.idleTimer);
      active.idleTimer = null;
    }
    active.resolveTerminalBoundary();
    this.cancelDeltaFlush(active);
    void this.flushDelta(active);
    if (terminal) void this.queueActiveNotification(active, terminal.method, terminal.params);
    const text = String(active.text || "");
    if (text.trim() && !active.assistantMessageEmitted) {
      // 评论说 final_answer 走 assistant.message，但此前只写进 active.text / run.turns，
      // 会话流不认 turns——正文在 CLI 里完整、控制台里蒸发（LO 2026-08-19）。
      // 终态判据不可省：被中断/超时/OUTPUT_LIMIT 的轮同样带半截正文，一律发 assistant.message
      // 会让"答完了"和"答了一半被杀"在会话流里长得一模一样。grok-build.mjs 与 pi-rpc.mjs
      // 早有同款负向契约（异常收束不得冒充正常回复），此处对齐：异常终局改发
      // assistant.partial_message，正文照样可见但明确标注未形成交付。
      active.assistantMessageEmitted = true;
      if (error) {
        void this.queueActiveEvent(active, "assistant.partial_message", {
          text,
          code: error.code || null,
          reason: error.message || null,
        });
      } else {
        void this.queueActiveEvent(active, "assistant.message", { text });
      }
    }
    active.finalizePromise = active.eventChain.then(() => {
      if (this.activeByThread.get(threadId) === active) this.activeByThread.delete(threadId);
      if (active.settled) return;
      active.settled = true;
      if (error) active.reject(error);
      else active.resolve(result);
    });
    return active.finalizePromise;
  }

  handleNotification(method, params) {
    const threadId = params.threadId || params.thread?.id || null;
    this.observeCompaction(method, params, threadId);
    const registered = threadId ? this.activeByThread.get(threadId) : null;
    if (registered?.closing) return;
    // 任何抵达该线程的原生流量都是"健在"证据：delta、item、审批请求、reasoning 都算。
    if (registered) this.armIdleWatchdog(registered);
    const eventTurnId = this.notificationTurnId(params);
    if (registered?.outputLimitError) {
      if (method === "turn/completed" && eventTurnId === registered.turnId) {
        this.cancelDeltaFlush(registered);
        void this.flushDelta(registered);
        void this.queueActiveNotification(registered, method, params);
        registered.resolveTerminalBoundary();
      }
      return;
    }
    if (registered && isTurnScopedNotification(method) && !eventTurnId) {
      const message = `Codex ${method} notification omitted its turn id`;
      if (!registered.turnId) {
        registered.preAckError ||= Object.assign(new Error(message), { code: "APP_SERVER_PROTOCOL" });
      } else {
        this.failActiveProtocol(threadId, registered, message);
      }
      return;
    }
    if (registered && !registered.turnId && eventTurnId) {
      this.deferPreAckNotification(registered, method, params, eventTurnId);
      return;
    }
    const active = this.activeForNotification(threadId, params, method);

    if (TEXT_DELTA_METHODS.has(method)) {
      if (active && typeof params.delta === "string" && params.delta) this.enqueueDelta(active, method, params);
      return;
    }
    if (method.startsWith("item/reasoning/")) return;

    if (active && method === "item/completed") {
      const item = params.item || {};
      if ((item.type === "agentMessage" || item.type === "agent_message") && typeof item.text === "string") {
        // 旁白（phase=commentary）与正文（final_answer）走同一个 item 类型。一旦收到过正文，
        // 后续旁白不得再覆盖 active.text——否则本轮结论会被一句"我这就去改"顶掉。
        const commentary = Boolean(item.phase) && item.phase !== "final_answer";
        if (commentary && active.sawFinalAnswer) {
          this.cancelDeltaFlush(active);
          void this.flushDelta(active);
          void this.queueActiveNotification(active, method, params);
          return;
        }
        const outputBytes = Buffer.byteLength(item.text, "utf8");
        if (outputBytes > this.maxTurnOutputBytes) {
          this.failActiveOutputLimit(active);
          return;
        }
        if (!commentary) active.sawFinalAnswer = true;
        active.text = item.text;
        active.outputBytes = outputBytes;
        const last = item.text.length > 0 ? item.text.charCodeAt(item.text.length - 1) : -1;
        active.endsWithHighSurrogate = last >= 0xd800 && last <= 0xdbff;
      }
    }
    if (active && method === "turn/completed") {
      const providerError = nativeTurnError(params.turn?.error, {
        threadId,
        turnId: eventTurnId || active.turnId,
      });
      const error = active.cancellationError || providerError;
      if (active.cancellationError && providerError) active.cancellationError.providerError = providerError.message;
      const result = error ? null : {
        sessionId: threadId,
        text: active.text,
        turn: params.turn,
        nativePersistence: true,
        protocol: "app-server-v2",
      };
      void this.finalizeActive(threadId, active, { error, result, terminal: { method, params } });
      return;
    }
    if (active) {
      // Consecutive deltas may coalesce; any visible non-delta notification is
      // an ordering barrier and therefore drains the buffered text first.
      this.cancelDeltaFlush(active);
      void this.flushDelta(active);
      void this.queueActiveNotification(active, method, params);
      return;
    }
    this.emitDetachedNotification(method, params, threadId);
  }

  async createThread({
    permissionMode = "read-only",
    signal,
    runId = null,
    agentId = this.runtimeProfileId,
    model = null,
  } = {}) {
    if (signal?.aborted) throw requestAbortReason(signal);
    await waitForAbortable(this.start(), signal);
    if (signal?.aborted) throw requestAbortReason(signal);
    const preset = codexPermissionPreset(permissionMode);
    const result = await this.request("thread/start", {
      cwd: this.cwd,
      model: model || this.model,
      // config-default（自定义 config.toml）不下发覆盖，其余档位按官方语义下发组合
      ...(preset ? { sandbox: preset.sandbox, approvalPolicy: preset.approvalPolicy } : {}),
      experimentalRawEvents: false,
      developerInstructions: "You are a 514cc runtime seat. The current turn prompt is authoritative for whether you act as team coordinator, executor, researcher, or verifier. Never infer leadership from the provider identity. Report evidence and ask precise questions when blocked.",
    }, 30_000, {
      signal,
      onLateResponse: async (message) => {
        const lateThreadId = message.result?.thread?.id || null;
        if (lateThreadId) await this.archiveThread(lateThreadId, { reason: "late thread/start acknowledgement", runId, agentId });
      },
    });
    const threadId = result.thread.id;
    if (signal?.aborted) {
      await this.archiveThread(threadId, { reason: "thread/start acknowledged after caller cancellation", runId, agentId });
      throw requestAbortReason(signal);
    }
    this.loadedThreads.add(threadId);
    return threadId;
  }

  async ensureThread(threadId, { signal } = {}) {
    if (signal?.aborted) throw requestAbortReason(signal);
    await waitForAbortable(this.start(), signal);
    if (signal?.aborted) throw requestAbortReason(signal);
    if (this.loadedThreads.has(threadId)) return;
    await this.request("thread/resume", { threadId }, 30_000, { signal });
    this.loadedThreads.add(threadId);
  }

  finishCompaction(compaction, { error = null, result = null } = {}) {
    if (!compaction || compaction.settled) return;
    compaction.settled = true;
    clearTimeout(compaction.timer);
    compaction.signal?.removeEventListener("abort", compaction.onAbort);
    if (this.compactionsByThread.get(compaction.threadId) === compaction) {
      this.compactionsByThread.delete(compaction.threadId);
    }
    if (error) compaction.reject(error);
    else compaction.resolve(result || {
      sessionId: compaction.threadId,
      turnId: compaction.turnId,
      protocol: "app-server-v2",
    });
  }

  observeCompaction(method, params, threadId) {
    const compaction = threadId ? this.compactionsByThread.get(threadId) : null;
    if (!compaction || compaction.settled) return;
    const eventTurnId = this.notificationTurnId(params);
    const itemIsCompaction = itemTypeKey(params.item?.type) === "contextcompaction";

    if (method === "turn/started" && eventTurnId && !compaction.turnId) {
      compaction.turnId = eventTurnId;
    }
    if ((method === "item/started" || method === "item/completed") && itemIsCompaction && eventTurnId) {
      if (compaction.turnId && compaction.turnId !== eventTurnId) {
        this.finishCompaction(compaction, {
          error: Object.assign(new Error("Codex context compaction turn id changed"), {
            code: "APP_SERVER_PROTOCOL",
            sessionId: threadId,
          }),
        });
        return;
      }
      compaction.turnId = eventTurnId;
    }
    if (method === "thread/compacted") {
      if (eventTurnId) compaction.turnId ||= eventTurnId;
      this.finishCompaction(compaction);
      return;
    }
    if (method !== "turn/completed" || !eventTurnId) return;
    // turnId 未绑定前不得认任意 turn/completed 为压缩成功：跨实例迟到通知会制造假成功，
    // 编排器会在未压缩的线程上立刻重试并再次撞满上下文。
    if (!compaction.turnId || compaction.turnId !== eventTurnId) return;
    const providerError = nativeTurnError(params.turn?.error, { threadId, turnId: eventTurnId });
    if (providerError) {
      this.finishCompaction(compaction, {
        error: Object.assign(new Error(`Codex context compaction failed: ${providerError.message}`), {
          code: "CONTEXT_COMPACTION_FAILED",
          providerCode: providerError.code,
          codexErrorInfo: providerError.codexErrorInfo,
          nativeTurnSettled: true,
          sessionId: threadId,
          turnId: eventTurnId,
        }),
      });
      return;
    }
    this.finishCompaction(compaction);
  }

  async compactThread(threadId, {
    signal,
    timeoutMs = DEFAULT_CONTEXT_COMPACTION_TIMEOUT_MS,
    runId = null,
    agentId = this.runtimeProfileId,
  } = {}) {
    if (!threadId) throw Object.assign(new Error("Codex context compaction requires a thread id"), { code: "INVALID_SESSION" });
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw Object.assign(new Error("Codex context compaction timeout must be a positive safe integer"), { code: "INVALID_EVENT_POLICY" });
    }
    if (signal?.aborted) throw requestAbortReason(signal);
    await this.ensureThread(threadId, { signal });
    if (this.activeByThread.has(threadId)) {
      throw Object.assign(new Error("Codex thread still has an active turn"), {
        code: "TURN_ACTIVE",
        nativeSessionBusy: true,
        sessionId: threadId,
      });
    }
    if (this.compactionsByThread.has(threadId)) {
      throw Object.assign(new Error("Codex thread context compaction is already active"), {
        code: "CONTEXT_COMPACTION_ACTIVE",
        nativeSessionBusy: true,
        sessionId: threadId,
      });
    }

    let resolveCompaction;
    let rejectCompaction;
    const promise = new Promise((resolve, reject) => {
      resolveCompaction = resolve;
      rejectCompaction = reject;
    });
    void promise.catch(() => {});
    const compaction = {
      threadId,
      runId,
      agentId,
      turnId: null,
      settled: false,
      signal,
      onAbort: null,
      timer: null,
      promise,
      resolve: resolveCompaction,
      reject: rejectCompaction,
    };
    compaction.onAbort = () => {
      const reason = requestAbortReason(signal);
      if (compaction.turnId) {
        void this.interruptTurn(threadId, compaction.turnId, CONTEXT_COMPACTION_INTERRUPT_MS, {
          reason: "context compaction caller cancelled",
          runId,
          agentId,
        }).catch(() => {}).finally(() => this.finishCompaction(compaction, { error: reason }));
      } else {
        this.finishCompaction(compaction, { error: reason });
      }
    };
    compaction.timer = setTimeout(() => {
      // 超时路径同样要打断原生轮：只 reject 会让 provider 侧的 contextCompaction turn 继续活着，
      // 而适配器已把它从 compactionsByThread 里遗忘——之后同 thread 的 send() 必撞 active writer。
      // 这条路径没有调用方在等打断结果，故走后台补偿，不再往已满 5 分钟的窗口上加时间。
      if (compaction.turnId) {
        void this.interruptTurn(threadId, compaction.turnId, CONTEXT_COMPACTION_INTERRUPT_MS, {
          reason: "context compaction timed out",
          runId,
          agentId,
        }).catch(() => {});
      }
      this.finishCompaction(compaction, {
        error: Object.assign(new Error("Codex context compaction timed out"), {
          code: "CONTEXT_COMPACTION_TIMEOUT",
          nativeTurnSettled: false,
          sessionId: threadId,
          turnId: compaction.turnId,
        }),
      });
    }, timeoutMs);
    this.compactionsByThread.set(threadId, compaction);
    signal?.addEventListener("abort", compaction.onAbort, { once: true });
    if (signal?.aborted) compaction.onAbort();

    try {
      // The RPC only acknowledges that compaction was launched. Codex 0.147.0 starts a
      // separate contextCompaction turn afterwards, so completion is observed above.
      await this.request("thread/compact/start", { threadId }, 30_000, { signal });
    } catch (error) {
      this.finishCompaction(compaction, {
        error: Object.assign(error, {
          code: error.code || "CONTEXT_COMPACTION_FAILED",
          contextCompactionPhase: "start",
          sessionId: threadId,
        }),
      });
    }
    return promise;
  }

  async send({
    sessionId,
    prompt,
    runId,
    agentId = "codex-technical",
    signal,
    model = null,
    permissionMode = "read-only",
    effort = "xhigh",
    timeoutMs = 20 * 60_000,
    idleTimeoutMs = DEFAULT_TURN_IDLE_TIMEOUT_MS,
    onSessionStarted,
    onTurnSubmitting,
    onTurnAccepted,
  }) {
    if (signal?.aborted) throw requestAbortReason(signal);
    let threadId = sessionId || null;
    let turnSubmissionAttempted = false;
    try {
      threadId = threadId || (await this.createThread({ permissionMode, signal, runId, agentId, model }));
      await this.ensureThread(threadId, { signal });
      if (signal?.aborted) throw requestAbortReason(signal);
      await this.waitForLifecycle(
        onSessionStarted,
        { sessionId: threadId, protocol: "app-server-v2" },
        "session-started",
        signal,
      );
      if (signal?.aborted) throw requestAbortReason(signal);
    } catch (error) {
      error.codexPhase = "session-setup";
      error.safeToFallback = true;
      error.sessionId = threadId;
      throw error;
    }
    if (this.activeByThread.has(threadId) || this.compactionsByThread.has(threadId)) {
      throw Object.assign(new Error("thread already has an active writer"), {
        code: "TURN_ACTIVE",
        submissionRejected: true,
        nativeSessionBusy: true,
        safeToFallback: false,
        sessionId: threadId,
      });
    }
    const clientUserMessageId = randomUUID();
    let abortHandler;
    let activeTurn;
    const turnPromise = new Promise((resolve, reject) => {
      let resolveTerminalBoundary;
      const terminalBoundary = new Promise((resolveBoundary) => { resolveTerminalBoundary = resolveBoundary; });
      const active = {
        resolve,
        reject,
        timer: null,
        text: "",
        assistantMessageEmitted: false,
        sawFinalAnswer: false,
        outputBytes: 0,
        endsWithHighSurrogate: false,
        outputLimitError: null,
        outputLimitPromise: null,
        runId,
        agentId,
        threadId,
        turnId: null,
        deltaBuffer: "",
        deltaMethod: null,
        deltaTurnId: null,
        deltaTimer: null,
        eventChain: Promise.resolve(),
        eventPersistenceTimedOut: false,
        eventPersistenceError: null,
        preAckByTurn: new Map(),
        preAckSaturated: false,
        preAckError: null,
        closing: false,
        settled: false,
        finalizePromise: null,
        interruptPromise: null,
        cancelPromise: null,
        cancelling: false,
        cancellationError: null,
        terminalBoundary,
        resolveTerminalBoundary,
        idleTimer: null,
        idleTimeoutMs,
      };
      activeTurn = active;
      active.timer = setTimeout(() => {
        const current = this.activeByThread.get(threadId);
        if (current) {
          void this.cancelActive(
            current,
            current.outputLimitError || Object.assign(new Error(`Codex turn reached the ${Math.round(timeoutMs / 60_000)} minute duration limit`), {
              code: "TURN_TIMEOUT",
              timeoutKind: "max-duration",
              timeoutMs,
              idleTimeoutMs,
            }),
          );
        }
      }, timeoutMs);
      this.activeByThread.set(threadId, active);
    });
    void turnPromise.catch(() => {});
    let acceptedTurnId = null;
    let turnReady = false;
    try {
      if (signal?.aborted) throw requestAbortReason(signal);
      await this.waitForLifecycle(
        onTurnSubmitting,
        {
          sessionId: threadId,
          protocol: "app-server-v2",
          clientUserMessageId,
        },
        "turn-submitting",
        signal,
        Math.min(this.lifecycleTimeoutMs, timeoutMs),
      );
      if (signal?.aborted) throw requestAbortReason(signal);
      if (activeTurn?.cancellationError) throw activeTurn.cancellationError;
      await preparePromptTransport({
        prompt,
        transport: "jsonl",
        adapterId: this.id,
        command: this.command,
        eventStore: this.eventStore,
        runId,
        agentId,
        auditTimeoutMs: this.eventPersistenceTimeoutMs,
      });
      // Once this request is written, a transport failure cannot prove that the
      // turn was not accepted. The caller must not replay the prompt blindly.
      turnSubmissionAttempted = true;
      // turn 级 approvalPolicy 与线程档一致；config-default 同样不下发覆盖（跟 config.toml 走）
      const preset = codexPermissionPreset(permissionMode);
      const started = await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        clientUserMessageId,
        effort,
        ...(preset ? { approvalPolicy: preset.approvalPolicy } : {}),
        // per-turn 模型覆盖：thread/start 只定初始模型，turn/start 的 model 经 0.146.0 实测
        // 可会话中切换（触发 thread/settings/updated），与 CLI /model 同一机制；无 override 不下发
        ...(model ? { model } : {}),
      }, 30_000, {
        signal,
        onLateResponse: async (message) => {
          const lateTurnId = message.result?.turn?.id || null;
          if (lateTurnId) {
            await this.interruptTurn(threadId, lateTurnId, 30_000, {
              reason: "late turn/start acknowledgement",
              runId,
              agentId,
            });
          }
        },
      });
      acceptedTurnId = started.turn?.id || null;
      const active = this.activeByThread.get(threadId);
      if (active) {
        const protocolError = this.acknowledgeTurn(active, acceptedTurnId);
        if (protocolError) throw protocolError;
        if (active.outputLimitError) throw active.outputLimitError;
        if (active.cancellationError) {
          await this.cancelActive(active, active.cancellationError);
          return await turnPromise;
        }
      }
      abortHandler = () => {
        const current = this.activeByThread.get(threadId);
        if (current && !current.closing) {
          void this.cancelActive(current, requestAbortReason(signal));
        }
      };
      signal?.addEventListener("abort", abortHandler, { once: true });
      if (signal?.aborted) abortHandler();
      await this.waitForLifecycle(
        onTurnAccepted,
        {
          sessionId: threadId,
          protocol: "app-server-v2",
          clientUserMessageId,
          turnId: acceptedTurnId,
        },
        "turn-accepted",
        signal,
        Math.min(this.lifecycleTimeoutMs, timeoutMs),
      );
      if (signal?.aborted) throw requestAbortReason(signal);
      turnReady = true;
      // 静默闸只在轮被接受后上弦：提交/就绪阶段已由 request/lifecycle 超时看护，
      // 提前上弦会让 idle 闸与合法的 lifecycle 等待互相误伤。
      if (activeTurn) this.armIdleWatchdog(activeTurn);
      return await turnPromise;
    } catch (error) {
      const active = activeTurn;
      const primaryError = active?.outputLimitError || error;
      if (error?.requestWritten === false) turnSubmissionAttempted = false;
      const submissionRejected = isDefinitiveTurnRejection(error);
      if (active?.outputLimitError && active.outputLimitPromise) {
        await active.outputLimitPromise.catch(() => {});
      } else if (!turnReady && acceptedTurnId && active?.turnId === acceptedTurnId) {
        await this.cancelActive(active, primaryError);
      } else if (active?.cancellationError && active?.turnId) {
        await this.cancelActive(active, active.cancellationError);
      } else if (active && this.activeByThread.get(threadId) === active) {
        await this.finalizeActive(threadId, active, { error: primaryError });
      } else if (active?.finalizePromise) {
        await active.finalizePromise;
      }
      primaryError.codexPhase = primaryError.nativeTurnSettled === true
        ? "turn-settled-failed"
        : submissionRejected ? "turn-rejected" : turnSubmissionAttempted ? "turn-submitted-or-unknown" : "session-ready";
      primaryError.safeToFallback = primaryError.nativeSessionBusy === true
        ? false
        : primaryError.nativeTurnSettled === true ? false : submissionRejected || !turnSubmissionAttempted;
      primaryError.submissionRejected = submissionRejected;
      primaryError.sessionId = threadId;
      primaryError.turnId ||= acceptedTurnId;
      primaryError.protocol ||= "app-server-v2";
      primaryError.clientUserMessageId = clientUserMessageId;
      throw primaryError;
    } finally {
      if (abortHandler) signal?.removeEventListener("abort", abortHandler);
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.onAbort);
      pending.reject(error);
    }
    this.pending.clear();
    this.lateResponses.clear();
    this.compensationReservations.clear();
    this.loadedThreads.clear();
    for (const compaction of [...this.compactionsByThread.values()]) {
      this.finishCompaction(compaction, { error });
    }
    const finalizations = [...this.activeByThread.entries()].map(([threadId, active]) =>
      this.finalizeActive(threadId, active, { error: active.outputLimitError || error }));
    const previous = this.failPromise || Promise.resolve();
    const current = Promise.all([previous, ...finalizations]).then(() => {});
    this.failPromise = current;
    void current.then(() => {
      if (this.failPromise === current) this.failPromise = null;
    });
    return current;
  }

  async close() {
    if (!this.child) {
      if (this.failPromise) await this.failPromise;
      return;
    }
    const child = this.child;
    this.child = null;
    await this.failAll(Object.assign(new Error("Codex app-server closed"), { code: "ABORTED" }));
    child.stdin?.end?.();
    await terminateChildProcessAndWait(child);
  }
}
