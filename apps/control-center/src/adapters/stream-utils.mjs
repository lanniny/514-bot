import { StringDecoder } from "node:string_decoder";
import { createLfJsonlCollector } from "../jsonl.mjs";
import { findPrivateKeyBoundary, scrub } from "../redaction.mjs";

export const DEFAULT_MAX_TURN_OUTPUT_BYTES = 8 * 1024 * 1024;

export function measureUtf8Append(currentBytes, previousEndsWithHighSurrogate, chunk) {
  let appendedBytes = Buffer.byteLength(chunk, "utf8");
  if (previousEndsWithHighSurrogate && chunk.length > 0) {
    const first = chunk.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) appendedBytes -= 2;
  }
  const last = chunk.length > 0 ? chunk.charCodeAt(chunk.length - 1) : -1;
  return {
    bytes: currentBytes + appendedBytes,
    endsWithHighSurrogate: chunk.length > 0
      ? last >= 0xd800 && last <= 0xdbff
      : previousEndsWithHighSurrogate,
  };
}

export function createLfCollector(onMessage, onParseError = () => {}, options = {}) {
  return createLfJsonlCollector(onMessage, onParseError, options);
}

export function createBoundedTaskTracker({ maxPending = 128, drainTimeoutMs = 1_000, onError = () => {} } = {}) {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || !Number.isFinite(drainTimeoutMs) || drainTimeoutMs < 0) {
    throw Object.assign(new Error("invalid bounded task tracker limits"), { code: "INVALID_TASK_TRACKER_LIMIT" });
  }
  const pending = new Set();
  const errors = [];
  let dropped = 0;

  const rememberError = (error) => {
    if (errors.length < 16) errors.push(error);
    try { onError(error); } catch {}
  };

  return {
    run(task) {
      if (pending.size >= maxPending) {
        dropped += 1;
        rememberError(Object.assign(new Error("bounded async task queue is full"), { code: "ASYNC_TASK_QUEUE_FULL" }));
        return false;
      }
      const handled = Promise.resolve()
        .then(task)
        .catch((error) => { rememberError(error); });
      pending.add(handled);
      void handled.then(() => pending.delete(handled));
      return true;
    },
    async drain(timeoutMs = drainTimeoutMs) {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      let timedOut = false;
      while (pending.size) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          timedOut = true;
          break;
        }
        let timer;
        const settled = await Promise.race([
          Promise.all([...pending]).then(() => true),
          new Promise((resolve) => { timer = setTimeout(() => resolve(false), remaining); }),
        ]);
        clearTimeout(timer);
        if (!settled) {
          timedOut = true;
          break;
        }
      }
      return { timedOut, errors: [...errors], dropped, pending: pending.size };
    },
    get size() {
      return pending.size;
    },
  };
}

/**
 * Buffers stderr by logical line before redacting it. Child-process chunks may
 * split a credential at any byte, so emitting each chunk independently can
 * persist both halves without either half matching the scrubber.
 */
export function createScrubbedLineCollector(onText, { maxLineChars = 64 * 1024 } = {}) {
  const decoder = new StringDecoder("utf8");
  const lineLimit = Number.isSafeInteger(maxLineChars) && maxLineChars > 0 ? maxLineChars : 64 * 1024;
  let buffer = "";
  let droppingOverflow = false;
  let overflowBoundaryTail = "";
  let privateKeyLabel = null;

  const inspectPrivateKey = (text) => {
    const wasPrivate = privateKeyLabel != null;
    let began = false;
    let boundary = findPrivateKeyBoundary(text);
    while (boundary) {
      if (privateKeyLabel) {
        if (boundary.type === "END" && boundary.label === privateKeyLabel) privateKeyLabel = null;
      } else if (boundary.type === "BEGIN") {
        privateKeyLabel = boundary.label;
        began = true;
      }
      boundary = findPrivateKeyBoundary(text, boundary.end);
    }
    return { wasPrivate, began };
  };

  const lineEnding = (text) => text.endsWith("\r\n") ? "\r\n" : text.endsWith("\n") ? "\n" : "";
  const emitSafeLine = (text, suffix = "") => {
    const security = inspectPrivateKey(text);
    if (security.wasPrivate) return;
    if (security.began) {
      onText(`[REDACTED]${lineEnding(text)}${suffix}`);
      return;
    }
    onText(`${scrub(text)}${suffix}`);
  };

  const append = (value) => {
    while (value) {
      if (droppingOverflow) {
        const newline = value.indexOf("\n");
        const end = newline < 0 ? value.length : newline + 1;
        const probe = `${overflowBoundaryTail}${value.slice(0, end)}`;
        inspectPrivateKey(probe);
        overflowBoundaryTail = probe.slice(-384);
        if (newline < 0) return;
        droppingOverflow = false;
        overflowBoundaryTail = "";
        value = value.slice(newline + 1);
        continue;
      }

      const newline = value.indexOf("\n");
      const pieceEnd = newline < 0 ? value.length : newline + 1;
      const piece = value.slice(0, pieceEnd);
      const room = lineLimit - buffer.length;
      if (piece.length > room) {
        // Scrub the retained prefix, then discard the rest of this oversized
        // logical line. Never resume halfway through a possible credential.
        const retained = `${buffer}${piece.slice(0, Math.max(0, room))}`;
        const securityProbe = `${buffer}${piece}`;
        const security = inspectPrivateKey(securityProbe);
        if (!security.wasPrivate) {
          if (security.began) onText(`[REDACTED]\n…[line truncated]\n`);
          else onText(`${scrub(retained)}\n…[line truncated]\n`);
        }
        buffer = "";
        droppingOverflow = newline < 0;
        overflowBoundaryTail = droppingOverflow ? securityProbe.slice(-384) : "";
      } else {
        buffer += piece;
        if (newline >= 0) {
          emitSafeLine(buffer);
          buffer = "";
        }
      }
      value = value.slice(pieceEnd);
    }
  };

  return {
    push(chunk) {
      append(typeof chunk === "string" ? chunk : decoder.write(chunk));
    },
    end() {
      append(decoder.end());
      if (buffer && !droppingOverflow) emitSafeLine(buffer);
      buffer = "";
      droppingOverflow = false;
      overflowBoundaryTail = "";
      privateKeyLabel = null;
    },
  };
}

// 单条事件里工具入参/结果的持久化截断上限——完整呈现 CLI 对话的同时防事件仓被大产物撑爆
const TOOL_PAYLOAD_MAX = 4000;

function clip(value, max = TOOL_PAYLOAD_MAX) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const safe = scrub(text);
  if (safe.length <= max) return safe;
  let end = max;
  const marker = "[REDACTED]";
  const markerStart = safe.lastIndexOf(marker, max);
  if (markerStart >= 0 && markerStart + marker.length > max) end = markerStart + marker.length;
  if (end >= safe.length) return safe;
  return `${safe.slice(0, end)}\n…[截断 ${safe.length - end} 字符]`;
}

function toolResultText(part) {
  if (typeof part.content === "string") return part.content;
  if (Array.isArray(part.content)) {
    return part.content.filter((item) => item?.type === "text").map((item) => item.text).join("\n");
  }
  return "";
}

export function claudeResultUsage(event) {
  if (event?.type !== "result") return { costUsd: null, durationMs: null, tokens: null };
  const usage = event.usage || {};
  const tokens =
    (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.output_tokens ?? 0);
  return {
    costUsd: Number.isFinite(event.total_cost_usd) ? Number(event.total_cost_usd) : null,
    durationMs: Number.isFinite(event.duration_ms) ? Number(event.duration_ms) : null,
    tokens: tokens || null,
  };
}

export function publicClaudeEvent(event) {
  if (event?.type === "system" && event?.subtype === "init") {
    return { type: "session.started", sessionId: event.session_id, model: event.model || null };
  }
  if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
    const text = scrub(event.message.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
    // 与真实 CLI 呈现一致：工具调用保留名字 + 入参（截断），前端渲染 "⏺ Tool(args)" 行
    const tools = event.message.content
      .filter((part) => part.type === "tool_use")
      .map((part) => ({ id: part.id, name: part.name, input: clip(part.input, 600) }));
    return text || tools.length ? { type: "assistant.message", text, tools } : null;
  }
  if (event?.type === "user" && Array.isArray(event.message?.content)) {
    // 工具结果（CLI 回填的 user turn）——完整对话不可缺失的一半
    const results = event.message.content
      .filter((part) => part.type === "tool_result")
      .map((part) => ({ toolUseId: part.tool_use_id || null, isError: Boolean(part.is_error), text: clip(toolResultText(part)) }));
    return results.length ? { type: "tool.result", results } : null;
  }
  if (event?.type === "result") {
    const usage = event.usage || {};
    const tokens =
      (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.output_tokens ?? 0);
    return {
      type: "turn.completed",
      sessionId: event.session_id || null,
      text: typeof event.result === "string" ? scrub(event.result) : "",
      costUsd: event.total_cost_usd ?? null,
      durationMs: event.duration_ms ?? null,
      tokens: tokens || null, // 状态栏用：本轮总 token（输入+缓存写+缓存读+输出）
      isError: Boolean(event.is_error),
    };
  }
  return null;
}

export function publicCodexEvent(event) {
  if (event?.type === "thread.started") return { type: "session.started", sessionId: event.thread_id };
  if (event?.type === "turn.started") return { type: "turn.started" };
  if (event?.type === "item.started" || event?.type === "item.completed") {
    const item = event.item || {};
    if (item.type === "agent_message") return { type: "assistant.message", text: scrub(item.text || "") };
    if (item.type === "command_execution") return { type: "tool.event", tool: "command", status: item.status || null, command: item.command == null ? null : clip(item.command, 600) };
    if (item.type === "file_change") return { type: "tool.event", tool: "file_change", status: item.status || null };
    if (["mcp_tool_call", "tool_call", "web_search"].includes(item.type) || item.server || item.tool) {
      const name = [item.server, item.tool || item.name].filter(Boolean).join(".") || item.type || "tool";
      const input = item.arguments ?? item.args ?? item.input ?? item.query ?? "";
      return { type: "tool.event", tool: name, status: item.status || null, command: clip(input, 600) };
    }
  }
  if (event?.type === "turn.completed") return { type: "turn.completed", usage: event.usage || null };
  if (event?.type === "error") return { type: "agent.error", message: clip(event.message || "Codex error") };
  return null;
}
