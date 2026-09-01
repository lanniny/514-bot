// modules/conversation-event-markup.js — Wave B slice 16
// 工具调用卡/结果卡/治理事件表/轮次元数据：会话流渲染的"事件→HTML"层。
// 工厂 + DI：agentLabel/payloadText/declaredPayloadLength 从 app.js 注入；
// escapeHtml/redact/formatDuration/lucideIcon/failurePresentation 走静态导入。

import { escapeHtml, redact, formatDuration } from "../utils.js";
import { lucideIcon } from "../lucide.js";
import { failurePresentation } from "./failure-presentation.js";

export function createConversationEventMarkup({
  agentLabel,
  payloadText,
  declaredPayloadLength,
  GOVERNANCE_ERROR_SUMMARY_LIMIT,
  INLINE_TOOL_RESULT_TEXT_LIMIT,
  INLINE_TOOL_INPUT_TEXT_LIMIT,
}) {
  function compactPayloadCount(length, unit = "字符") {
    return `${Number(length || 0).toLocaleString("zh-CN")} ${unit}`;
  }

  function payloadRenderGuardMarkup(label, length, unit = "字符") {
    return `<div class="payload-render-guard" role="note"><strong>${escapeHtml(label)}过大，未直接渲染</strong><span>${escapeHtml(compactPayloadCount(length, unit))} · 源记录仍保留</span></div>`;
  }

  function boundedMetadataText(value, limit = 160) {
    const text = payloadText(value);
    const clipped = text.length > limit ? `${text.slice(0, limit)}…` : text;
    return redact(clipped);
  }

  const TOOL_GLYPHS = Object.freeze({
    bash: "terminal", shell: "terminal",
    read: "file-text", write: "file-text", edit: "file-text", notebookedit: "file-text",
    glob: "search", grep: "search", websearch: "search", webfetch: "search", search: "search",
    task: "bot", todowrite: "check", todoread: "check",
    mcp: "puzzle", mcptoolcall: "puzzle", fastctx: "puzzle",
    subagent: "bot",
  });
  function toolGlyphFor(name) {
    const full = String(name ?? "").toLowerCase();
    if (TOOL_GLYPHS[full]) return TOOL_GLYPHS[full];
    for (const segment of full.split(/[.\/_-]+/)) {
      if (TOOL_GLYPHS[segment]) return TOOL_GLYPHS[segment];
    }
    return "wrench";
  }
  function toolSlugFor(name) {
    return String(name ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "") || "tool";
  }

  const TOOL_ITEM_TYPE_KEYS = new Set(["mcptoolcall", "dynamictoolcall", "collabagenttoolcall", "websearch", "subagentactivity"]);
  const TOOL_TYPE_DISPLAY = Object.freeze({
    mcptoolcall: "mcp",
    dynamictoolcall: "dynamic_tool",
    collabagenttoolcall: "collab_agent",
    websearch: "web_search",
    subagentactivity: "sub_agent",
  });
  function toolItemTypeKey(type) {
    return String(type || "").replace(/_/g, "").toLowerCase();
  }

  function toolProgressFromFallback(hint, itemType) {
    const type = toolItemTypeKey(hint?.type ?? itemType ?? "");
    if (!TOOL_ITEM_TYPE_KEYS.has(type)) return null;
    const server = hint?.server || null;
    const tool = hint?.tool || null;
    const name = server && tool
      ? `${server}.${tool}`
      : (tool || hint?.agentPath || hint?.name || TOOL_TYPE_DISPLAY[type] || String(hint?.type ?? itemType ?? "tool"));
    return {
      kind: "tool",
      name,
      server,
      status: hint?.status || null,
      input: "",
      output: "",
      degraded: true,
    };
  }

  function toolCallMarkup(tool) {
    const name = String(tool.name || "tool");
    const slug = toolSlugFor(name);
    const glyph = lucideIcon(toolGlyphFor(name));
    const status = `<span class="tool-status is-done" title="已完成" aria-hidden="true">${lucideIcon("circle-check")}</span>`;
    const rawInput = payloadText(tool.input);
    const inputLength = declaredPayloadLength(rawInput, tool.inputLength);
    if (inputLength > INLINE_TOOL_INPUT_TEXT_LIMIT) {
      return `<div class="tool-call tool-card" data-tool="${escapeHtml(slug)}"><span class="tool-glyph" aria-hidden="true">${glyph}</span><strong>${escapeHtml(boundedMetadataText(name))}</strong><span class="tool-args">（输入过大 · ${escapeHtml(compactPayloadCount(inputLength))}）</span>${status}</div>`;
    }
    const full = redact(rawInput).replace(/\s+/g, " ");
    const shown = full.slice(0, 160) + (full.length > 160 ? "…" : "");
    const title = full.length > 160 ? ` title="${escapeHtml(full.slice(0, 600))}"` : "";
    return `<div class="tool-call tool-card" data-tool="${escapeHtml(slug)}"><span class="tool-glyph" aria-hidden="true">${glyph}</span><strong>${escapeHtml(boundedMetadataText(name))}</strong><span class="tool-args"${title}>${escapeHtml(full ? `(${shown})` : "")}</span>${status}</div>`;
  }

  function toolResultMarkup(result, { allowInline = true } = {}) {
    const rawText = payloadText(result.text);
    const textLength = declaredPayloadLength(rawText, result.textLength);
    const statusIcon = `<span class="tool-status ${result.isError ? "is-error" : "is-done"}" aria-hidden="true">${lucideIcon(result.isError ? "circle-alert" : "circle-check")}</span>`;
    const label = result.isError ? "工具错误" : "工具结果";
    if (!allowInline || textLength > INLINE_TOOL_RESULT_TEXT_LIMIT) {
      return `<details class="tool-result tool-card${result.isError ? " is-error" : ""}">
      <summary>${statusIcon}${label} · 超过显示预算</summary>
      ${payloadRenderGuardMarkup("工具结果", textLength)}
    </details>`;
    }
    const text = redact(rawText);
    const lineCount = text ? text.split("\n").length : 0;
    return `<details class="tool-result tool-card${result.isError ? " is-error" : ""}">
    <summary>${statusIcon}${label} · ${lineCount} 行</summary>
    <pre>${escapeHtml(text) || "(空)"}</pre>
  </details>`;
  }

  const GOVERNANCE_EVENTS = {
    "run.coordinator_write_skipped": { tone: "rose", text: (data) => data.note || "主脑兼任执行者，本轮仅规划不落盘" },
    "run.recovery_acknowledged": { tone: "amber", text: () => "已确认恢复：放弃提交状态不明的声明工作，会话停在可续聊的闲置态" },
    "adapter.fallback": { tone: "amber", text: (data) => `适配器降级：${data.from || "?"} → ${data.to || "?"}${data.reason ? `（${data.reason}）` : ""}` },
    "adapter.replay_blocked": {
      tone: "rose",
      text: (data) => `已阻止不安全的原生轮重放：${data.reason || "提交状态不明确"}${data.interruptConfirmed === true ? "（原生轮已确认打断，会话无活跃占用）" : ""}`,
    },
    "run.auto_recovery": {
      tone: "amber",
      text: (data) => `${agentLabel(data.agentId || "")} 第 ${data.round ?? "?"} 轮超时且原生轮已确认打断——已自动原生续跑（第 ${data.count ?? "?"}/${data.cap ?? "?"} 次，只读轮无写盘残留）`,
    },
    "run.context_compaction_started": {
      tone: "amber",
      text: (data) => `${agentLabel(data.agentId || "")} 上下文已满——正在原生压缩后继续（第 ${data.attempt ?? "?"}/${data.cap ?? "?"} 次${
        Number.isFinite(Number(data.timeoutMs)) && Number(data.timeoutMs) > 0 ? `，最长 ${Math.max(1, Math.round(Number(data.timeoutMs) / 60000))} 分钟` : ""
      }）。此期间请勿中断：中断会作废当前原生会话。`,
    },
    "run.context_compaction_completed": {
      tone: "amber",
      text: (data) => `${agentLabel(data.agentId || "")} 上下文压缩完成，原生会话保留，正在自动续跑第 ${data.nextRound ?? "?"} 轮`,
    },
    "run.context_compaction_failed": {
      tone: "rose",
      text: (data) => `${agentLabel(data.agentId || "")} 上下文压缩未完成（${data.code || "未知原因"}）——${
        data.sessionInvalidated ? "已作废耗尽的原生会话以免下次「继续」原地重演；确认后继续将开启新会话" : "原生会话状态不明"
      }`,
    },
    "run.authorization_revoked": { tone: "rose", text: (data) => `Build 授权已撤销：${data.reason || "运行时策略变更"}` },
    "run.write_degraded": {
      tone: "amber",
      text: (data) => `${agentLabel(data.agentId || "")} 本轮降为只读——${
        data.reason === "CAPABILITY_LEASE_INACTIVE" ? "执行租约已过期或被吊销"
          : data.reason === "BUILD_APPROVAL_INVALID" ? "Build 审批已失效（工作区/执行者/权限档发生变化）"
          : data.reason || "授权链不完整"
      }。要继续写盘请重新发起 Build 任务或续期租约。`,
    },
    "agent.turn_unproductive": {
      tone: "rose",
      text: (data) => `第 ${data.round ?? "?"} 轮 ${agentLabel(data.agentId || "")}${
        data.hasPartialOutput ? "异常中止；已有部分输出仅供排查，未形成交付" : "没有产出内容"
      }${
        data.stopReason ? `（provider 收束原因：${data.stopReason}）` : ""
      }——该轮预算已消耗，任务不会按成功结算。`,
    },
    "agent.turn_failed": {
      tone: "rose",
      detail: (data) => {
        const raw = String(data.message || "");
        const presentation = failurePresentation(raw, { summaryLimit: GOVERNANCE_ERROR_SUMMARY_LIMIT });
        return presentation.detail;
      },
      text: (data, event) => {
        const agent = agentLabel(data.agentId ?? event.agentId ?? "");
        const limitMs = Number(data.timeoutMs);
        const limit = Number.isFinite(limitMs) && limitMs > 0 ? formatDuration(limitMs) : "配置的时限";
        const continuation = data.interruptConfirmed === true
          ? "原生轮已确认停止，可在同一会话继续"
          : "原生轮退出状态未确认，继续前需要恢复确认";
        if (data.code === "TURN_IDLE_TIMEOUT") return `${agent} 连续 ${limit} 没有原生事件，静默看门狗已停止本轮；${continuation}`;
        if (data.code === "TURN_TIMEOUT") return `${agent} 达到 ${limit} 总时长上限，控制面已停止本轮；${continuation}`;
        const rawMessage = String(data.message || "provider turn failed");
        const presentation = failurePresentation(rawMessage, { summaryLimit: GOVERNANCE_ERROR_SUMMARY_LIMIT });
        return `${agent} 本轮失败（${data.code || "PROVIDER_ERROR"}）：${presentation.summary} ${continuation}`;
      },
    },
    "agent.turn_checkpoint": { tone: "rose", text: (data, event) => (data.phase === "ambiguous" ? `第 ${data.round ?? "?"} 轮 ${agentLabel(data.agentId ?? event.agentId ?? "")} 提交状态不明确——自动重放已阻止，需人工确认` : null) },
    "run.steer_queued": { tone: "amber", text: (data) => `轮间插话已排队（第 ${data.depth ?? "?"} 位）· 当前轮结束后送达 ${agentLabel(data.agentId || "")}` },
    "run.round_refunded": {
      tone: "amber",
      text: (data) => `已退还一次未提交的自主步骤（停在「${data.phase ?? "未完成"}」）· 总轮次仍为 ${data.round ?? "?"} · 本次步骤 ${data.interactionStep ?? "?"}/${data.maxStepsPerInteraction ?? "?"}`,
    },
    "bus.routed": {
      tone: "amber",
      text: (data) => {
        const snippet = `${String(data.text || "").slice(0, 60)}${String(data.text || "").length > 60 ? "…" : ""}`;
        if (data.to === "memo") return `${agentLabel(data.from || "")} 记入全员黑板：${snippet}`;
        if (data.to === "lo") return `${agentLabel(data.from || "")} 向你提问：${snippet}`;
        if (data.to === "team") return `${agentLabel(data.from || "")} 向全员广播：${snippet}`;
        return `${agentLabel(data.from || "")} → ${agentLabel(data.to || "")}：${snippet}`;
      },
      toneOf: (data) => (data.to === "memo" ? "violet" : "amber"),
    },
    "run.waiting_input": { tone: "amber", text: (data) => `团队向你提问（来自 ${agentLabel(data.from || "")}），在下方回答即继续：${String(data.text || "").slice(0, 60)}${String(data.text || "").length > 60 ? "…" : ""}` },
    "run.ask_throttled": { tone: "rose", text: (data) => `${agentLabel(data.from || "")} 的旧版会话曾触发提问熔断；当前版本已取消整场回答次数上限` },
    "run.worktree_created": { tone: "amber", text: (data) => `已创建隔离工作树：写盘轮在 ${String(data.worktree || "").split(/[\\/]/).pop() || "worktree"} 进行，真实目录零污染` },
    "run.worktree_skipped": { tone: "rose", text: () => "本会话未设项目地址——写盘将发生在默认目录，无工作树隔离" },
    "run.budget_exhausted": { tone: "rose", text: (data) => `本次交互已知成本已达硬顶（$${Number(data.interactionCostUsd ?? 0).toFixed(2)}），自主派发已收束；可继续发送新消息` },
    "run.interaction_steps_exhausted": { tone: "amber", text: (data) => `本次交互自主步骤已收束（${data.interactionStep ?? "?"}/${data.maxStepsPerInteraction ?? "?"}），仍有 ${data.queuedWork ?? 0} 项工作保留；发送下一条消息即可继续` },
    "run.interrupted": { tone: "amber", text: () => "当前回复已中断，原生会话、工作树与有效授权均已保留，可直接继续对话" },
    "run.interrupt_timeout": {
      tone: "rose",
      text: (data) => `当前 provider turn 在 ${
        Number.isFinite(Number(data.timeoutMs)) && Number(data.timeoutMs) > 0 ? `${Math.round(Number(data.timeoutMs) / 1000)} 秒` : "限定时间"
      }内未确认退出；为避免并发占用，继续发送暂时被阻止。原生轮确认退出后会自动恢复；若长时间不恢复，用「取消」结束本轮即可解除。`,
    },
    "run.steer_dropped": { tone: "rose", text: (data) => { const safe = redact(String(data.text || "")); return `轮间插话被丢弃（${data.reason === "ROUND_LIMIT" ? "旧版会话轮次限制" : data.reason || "未知原因"}）：${safe.slice(0, 60)}${safe.length > 60 ? "…" : ""}`; } },
  };

  function turnMetaText(data, event) {
    const parts = [`第 ${data.round ?? "?"} 轮完成`, agentLabel(data.agentId ?? event.agentId ?? "")];
    if (data.interactionStep != null && data.maxStepsPerInteraction != null) {
      parts.push(`本次 ${data.interactionStep}/${data.maxStepsPerInteraction}`);
    }
    if (data.permissionMode === "workspace-write") parts.push("可写盘");
    else if (data.permissionMode && data.permissionMode !== "plan" && data.permissionMode !== "read-only") parts.push(String(data.permissionMode));
    if (data.effectiveModel) parts.push(String(data.effectiveModel));
    if (data.tokens != null && String(data.tokens).trim() !== "" && Number.isFinite(Number(data.tokens))) {
      const tokens = Number(data.tokens);
      parts.push(tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tokens` : `${tokens} tokens`);
    }
    if (data.costUsd != null && String(data.costUsd).trim() !== "" && Number.isFinite(Number(data.costUsd))) parts.push(`$${Number(data.costUsd).toFixed(2)}`);
    return parts.filter(Boolean).join(" · ");
  }

  return {
    payloadRenderGuardMarkup,
    boundedMetadataText,
    toolGlyphFor,
    toolProgressFromFallback,
    toolCallMarkup,
    toolResultMarkup,
    GOVERNANCE_EVENTS,
    turnMetaText,
  };
}
