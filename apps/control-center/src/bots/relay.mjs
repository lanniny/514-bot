/**
 * bots/relay.mjs — 514 Bot 协作体系 · Bot↔Bot 交接协议（Grok Bot 对标层二）。
 *
 * 对标 docs.x.ai/grok-bot/chat-and-collaboration（Message and collaborate）：
 *   - Let Bots hand work off：Bot 可向另一 Bot 发异步消息，接收方处理并可稍后回复，
 *     交接在会话里可见——「你不必在工具之间当路由器」。
 *   - Start a group chat：kickoff 模板「@A 收集素材；@B 写成草稿；@C 只列阻塞项；不要发布」
 *     —— @ 点名指派 owner，每阶段单一负责人。
 *   - Ask for a single owner at each stage：并行 handoff 过多会产生重复劳动和噪音——
 *     本协议提供机械守卫（kickoff 内同 handle 双指派 = 冲突；同 stage 跨消息双 owner = 告警）。
 *
 * 落点：不造第二消息通道——交接消息直接走 BusStore（run 级 JSONL 总线，写入即脱敏）：
 *   handoff 消息 = { kind: "task", refs: { stage, handoffId, handoff: true } }
 *   确认回执     = { kind: "say", refs: { ackOf: <handoffId>, ack: true } }
 *   开放交接面板 = kind=task 且 refs.handoff 的消息中，尚无 ackOf 指回者。
 */

import { randomUUID } from "node:crypto";
import { assertRunId } from "../bus.mjs";

export const RELAY_SCHEMA = "514cc.bot-relay/v1";

export const RELAY_LIMITS = Object.freeze({
  kickoffTextMax: 8_000,       // kickoff 总文本上限
  handoffTextMax: 4_000,       // 单条交接文本上限
  stageMax: 64,
  broadcastHandles: new Set(["@team", "@everyone", "@all"]), // 广播哨兵（不构成单 owner 冲突）
  boardMaxMessages: 128,
});

const HANDLE_TOKEN = /(@[A-Za-z0-9][A-Za-z0-9._:-]{0,31})/g;

function fail(message, code = "VALIDATION_FAILED", details = undefined) {
  throw Object.assign(new Error(message), { code }, details);
}

function cleanStage(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") fail("stage must be a string");
  const stage = value.trim();
  if (stage.length === 0) return null;
  if (stage.length > RELAY_LIMITS.stageMax) fail(`stage exceeds ${RELAY_LIMITS.stageMax} characters`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(stage)) fail("stage contains unsupported characters");
  return stage;
}

/**
 * 解析 kickoff 文本 → 指派段列表 + 共享目标。
 * 规则（Grok kickoff 模板的机械版）：
 *   - 第一个 @handle 之前的文本 = 共享目标（发给 team）；
 *   - 每个 @handle 开启一段指派，文本延续到下一个 @handle 或文末；
 *   - 广播哨兵（@team/@everyone/@all）不开启指派段，其后的文本并入共享目标；
 *   - 同一 @handle 出现多次 = 单 owner 冲突（fail-fast，交给调用方决定拒绝或去重）。
 * 返回 { sharedGoal, assignments: [{ handle, text }] }。
 */
export function parseKickoff(text) {
  if (typeof text !== "string") fail("kickoff text must be a string");
  const trimmed = text.trim();
  if (!trimmed) fail("kickoff text is required");
  if (trimmed.length > RELAY_LIMITS.kickoffTextMax) fail(`kickoff text exceeds ${RELAY_LIMITS.kickoffTextMax} characters`);

  const assignments = [];
  const sharedParts = [];
  let current = null; // { handle, parts: [] }
  for (const line of trimmed.split(/\r?\n/)) {
    let rest = line;
    let matched;
    HANDLE_TOKEN.lastIndex = 0;
    while ((matched = HANDLE_TOKEN.exec(rest)) !== null) {
      const handle = matched[1];
      const before = rest.slice(0, matched.index);
      if (before.trim()) {
        if (current) current.parts.push(before);
        else sharedParts.push(before);
      }
      if (RELAY_LIMITS.broadcastHandles.has(handle)) {
        // 广播哨兵：不开启指派段，后续文本并入共享目标
        if (current) {
          current = null; // 结束上一段，广播后的内容归共享层
        }
      } else {
        current = { handle, parts: [] };
        assignments.push(current);
      }
      rest = rest.slice(matched.index + handle.length);
      HANDLE_TOKEN.lastIndex = 0;
    }
    if (rest.trim() || rest) {
      if (current) current.parts.push(rest);
      else sharedParts.push(rest);
    }
  }

  const normalized = assignments.map((assignment) => ({
    handle: assignment.handle,
    text: assignment.parts.join("\n").trim(),
  }));

  return {
    sharedGoal: sharedParts.join("\n").trim(),
    assignments: normalized,
  };
}

/** 单 owner 守卫（kickoff 内）：同一 handle 双指派 = 冲突。返回冲突列表（空 = 通过）。 */
export function singleOwnerConflicts(assignments) {
  const seen = new Map();
  const conflicts = [];
  for (const assignment of assignments) {
    if (seen.has(assignment.handle)) {
      conflicts.push({
        handle: assignment.handle,
        first: seen.get(assignment.handle),
        duplicate: assignment.text,
      });
    } else {
      seen.set(assignment.handle, assignment.text);
    }
  }
  return conflicts;
}

/**
 * 跨消息阶段守卫：同一 run 的同一 stage 已由别的 member 认领时返回告警。
 * Grok 原则是建议级（"Ask for a single owner at each stage"），默认返回 warning 不阻断；
 * 调用方可传 strict: true 升级为 fail。
 */
export function stageOwnerWarning(existingMessages, { stage, ownerMemberId }) {
  const normalizedStage = cleanStage(stage);
  if (!normalizedStage) return null;
  for (const message of existingMessages) {
    if (message?.kind !== "task" || message?.refs?.stage !== normalizedStage) continue;
    if (message.from === ownerMemberId || message.from === "lo") continue;
    return {
      stage: normalizedStage,
      claimedBy: message.from,
      message: `stage "${normalizedStage}" already has an owner (${message.from}); duplicate ownership creates parallel work`,
    };
  }
  return null;
}

/** 从 bus 消息投影交接视图。 */
export function projectRelayBoard(messages) {
  const handoffs = [];
  const acksByHandoffId = new Map();
  for (const message of messages) {
    const refs = message?.refs;
    if (message?.kind === "task" && typeof refs?.handoffId === "string") {
      handoffs.push({
        id: message.id,
        handoffId: refs.handoffId,
        from: message.from,
        to: message.to,
        stage: typeof refs.stage === "string" ? refs.stage : null,
        text: message.text,
        ts: message.ts,
      });
    } else if (refs?.ackOf) {
      acksByHandoffId.set(String(refs.ackOf), { id: message.id, from: message.from, ts: message.ts });
    }
  }
  const open = handoffs.filter((handoff) => !acksByHandoffId.has(handoff.handoffId));
  return {
    schema: RELAY_SCHEMA,
    handoffs: handoffs.slice(-RELAY_LIMITS.boardMaxMessages),
    openHandoffs: open.slice(-RELAY_LIMITS.boardMaxMessages),
    acknowledgedHandoffs: handoffs
      .filter((handoff) => acksByHandoffId.has(handoff.handoffId))
      .map((handoff) => ({ ...handoff, ack: acksByHandoffId.get(handoff.handoffId) }))
      .slice(-RELAY_LIMITS.boardMaxMessages),
  };
}

export class BotRelayService {
  /**
   * @param {object} options
   * @param {import("../bus.mjs").BusStore} options.bus —— run 级消息总线（orchestrator.bus）
   * @param {(handleOrMemberId: string) => string|null} options.resolveHandle —— @handle/裸 id → memberId
   * @param {(memberId: string) => object|null} [options.resolveMember] —— 校验成员存在（可空）
   */
  constructor({ bus, resolveHandle, resolveMember = null } = {}) {
    if (!bus || typeof bus.append !== "function" || typeof bus.readTail !== "function") {
      fail("bus (BusStore) is required for the relay service");
    }
    if (typeof resolveHandle !== "function") fail("resolveHandle callback is required for the relay service");
    this.bus = bus;
    this.resolveHandle = resolveHandle;
    this.resolveMember = typeof resolveMember === "function" ? resolveMember : null;
  }

  #resolveTarget(handleOrMemberId, label = "target") {
    const memberId = this.resolveHandle(handleOrMemberId);
    if (!memberId) fail(`unknown ${label}: ${handleOrMemberId}`, "RELAY_TARGET_UNKNOWN");
    if (this.resolveMember && !this.resolveMember(memberId)) {
      fail(`member ${memberId} does not exist in the team roster`, "MEMBER_NOT_FOUND");
    }
    return memberId;
  }

  /** 署名身份校验："lo"（主人）放行；其余必须是真实成员——防伪造署名发交接。 */
  #resolveFrom(from) {
    if (typeof from !== "string" || !from.trim()) fail("from is required");
    const identity = from.trim();
    if (identity === "lo") return identity;
    if (this.resolveMember && !this.resolveMember(identity)) {
      fail(`from ${identity} does not exist in the team roster`, "MEMBER_NOT_FOUND");
    }
    return identity;
  }

  /**
   * kickoff：把「@A 做 X；@B 做 Y」的群聊派发文本翻译成逐条 task 交接消息。
   * 单 owner 守卫 fail-fast；每条消息 to = 对应 memberId（接收 Bot 醒来即处理）。
   */
  async kickoff({ runId, from = "lo", text, strictStages = false }) {
    const normalizedRunId = assertRunId(runId);
    const sender = this.#resolveFrom(from);
    const parsed = parseKickoff(text);
    const conflicts = singleOwnerConflicts(parsed.assignments);
    if (conflicts.length) {
      fail(
        `kickoff assigns the same bot twice: ${conflicts.map((item) => item.handle).join(", ")}; keep a single owner per stage`,
        "RELAY_DUPLICATE_OWNER",
        { conflicts },
      );
    }
    if (!parsed.assignments.length) fail("kickoff text contains no @handle assignment", "RELAY_NO_ASSIGNMENT");

    const existing = (await this.bus.readTail(normalizedRunId, { maxMessages: RELAY_LIMITS.boardMaxMessages })).messages;
    const dispatched = [];
    const warnings = [];
    for (const assignment of parsed.assignments) {
      const to = this.#resolveTarget(assignment.handle);
      // kickoff 文本不携带 stage 语法：阶段归属由后续 handoff 显式声明，
      // 不拿 handle 冒充 stage（handle 是身份，stage 是工作阶段，两者语义不同）。
      const stage = null;
      const warning = stageOwnerWarning(existing, { stage, ownerMemberId: to });
      if (warning) {
        if (strictStages) {
          fail(warning.message, "RELAY_STAGE_OWNER_CONFLICT", { warning });
        }
        warnings.push(warning);
      }
      const message = await this.bus.append(normalizedRunId, {
        from: sender,
        to,
        kind: "task",
        text: [parsed.sharedGoal ? `【共享目标】${parsed.sharedGoal}` : null, assignment.text || "（见共享目标）"]
          .filter(Boolean)
          .join("\n"),
        refs: { stage, handoff: true, handoffId: randomUUID() },
      });
      dispatched.push({ to, stage, messageId: message.id, handle: assignment.handle });
    }
    return { runId: normalizedRunId, sharedGoal: parsed.sharedGoal, dispatched, warnings };
  }

  /** 单点交接：Bot A → Bot B 的异步任务传递（接收方稍后处理，交接在会话可见）。 */
  async handoff({ runId, from, to, stage = null, text }) {
    const normalizedRunId = assertRunId(runId);
    const sender = this.#resolveFrom(from);
    const targetMemberId = this.#resolveTarget(to);
    if (typeof text !== "string" || !text.trim()) fail("handoff text is required");
    if (text.trim().length > RELAY_LIMITS.handoffTextMax) fail(`handoff text exceeds ${RELAY_LIMITS.handoffTextMax} characters`);
    const normalizedStage = cleanStage(stage);
    const message = await this.bus.append(normalizedRunId, {
      from: sender,
      to: targetMemberId,
      kind: "task",
      text: text.trim(),
      refs: { stage: normalizedStage, handoff: true, handoffId: randomUUID() },
    });
    return { runId: normalizedRunId, messageId: message.id, to: targetMemberId, stage: normalizedStage };
  }

  /** 确认回执：只有交接的接收方（to）能对 handoffId 确认——「醒了、接了」。 */
  async acknowledge({ runId, from, handoffId }) {
    const normalizedRunId = assertRunId(runId);
    if (typeof from !== "string" || !from.trim()) fail("from is required");
    if (typeof handoffId !== "string" || !handoffId.trim()) fail("handoffId is required");
    const tail = await this.bus.readTail(normalizedRunId, { maxMessages: RELAY_LIMITS.boardMaxMessages });
    const target = tail.messages.find((message) => message?.refs?.handoffId === handoffId);
    if (!target) fail(`handoff ${handoffId} is not visible in this run's bus tail`, "RELAY_HANDOFF_NOT_FOUND");
    const acker = this.#resolveTarget(from, "from");
    if (target.to !== acker) {
      fail(`only the handoff receiver (${target.to}) may acknowledge handoff ${handoffId}`, "RELAY_ACK_FORBIDDEN");
    }
    const alreadyAcked = tail.messages.some((message) => message?.refs?.ackOf === handoffId);
    if (alreadyAcked) {
      return { runId: normalizedRunId, handoffId, state: "already-acknowledged" };
    }
    const message = await this.bus.append(normalizedRunId, {
      from: acker,
      to: target.from,
      kind: "say",
      text: `已接手：${target.text.slice(0, 120)}`,
      refs: { ackOf: handoffId, ack: true },
    });
    return { runId: normalizedRunId, handoffId, state: "acknowledged", messageId: message.id };
  }

  /** 交接板：开放交接（未确认）/ 已确认 / 全量（对齐 Grok「handoff 在会话里可见」）。 */
  async readBoard(runId) {
    const normalizedRunId = assertRunId(runId);
    const tail = await this.bus.readTail(normalizedRunId, { maxMessages: RELAY_LIMITS.boardMaxMessages });
    return {
      ...projectRelayBoard(tail.messages),
      runId: normalizedRunId,
      diagnostics: tail.diagnostics,
    };
  }
}
