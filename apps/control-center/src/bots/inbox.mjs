/**
 * bots/inbox.mjs — Bot 面协作收件箱：复用 collaboration-inbox 的投影，由调用方声明作用域。
 *
 * 为什么需要这个模块（2026-09-11 代码层确证，非猜测）：
 *   Bot 群聊提交走 ephemeralTeam（public/app.js:19923 → :19977），编排器把它物化成独立 id
 *   （orchestrator.mjs:2397 → teams.mjs:524 `id = team-ephemeral-<uuid>`）并写进 run.teamId
 *   （orchestrator.mjs:2740）。而既有 collectTeamInbox 有两个硬约束：
 *     · collaboration-inbox.mjs:104  `(run.teamId || "team-514cc") === teamId` 过滤 run
 *     · collaboration-inbox.mjs:135  校验 `team.id === teamId`
 *   于是既有 /api/teams/<id>/inbox 对 Bot 会话**结构性不可用**：
 *     用 "team-514cc" 查 → Bot 会话的 run 全部被过滤掉（恒空）；
 *     用 "team-ephemeral-<uuid>" 查 → 临时团队不落 TeamStore（teams.mjs:519-531 只返回对象），校验拒。
 *
 * 本模块的做法（刻意保守）：
 *   **不改 collectTeamInbox** —— src/team-attention.mjs:1 依赖它，且 /api/teams/:id/attention
 *   与 view-team 的 #team-inbox-root 同源，改动会波及已上线的团队面。
 *   改为**调用方声明作用域**：把目标会话的 runs 盖上合成 scope id 传入，team 传
 *   { id: scope, name: 会话标题 }。投影、ask 生命周期、源降级诊断、有界读取全部复用同一实现，
 *   不产生第二真源。
 *
 * 作用域语义（消费方必读）：返回载荷里 run.teamId 是**合成 scope**（`bot-conversation:<id>`），
 * 不是 run 的真实团队归属。要拿真实归属看载荷根的 conversation.id。
 */

import { collectTeamInbox, INBOX_LIMITS } from "../collaboration-inbox.mjs";

export const BOT_INBOX_SCHEMA = "514cc.bot-inbox/v1";

/** Bot 面收件箱的作用域前缀。刻意带前缀以便与真实 teamId 一眼区分。 */
export const BOT_INBOX_SCOPE_PREFIX = "bot-conversation:";

export function botInboxScopeId(conversationId) {
  const id = String(conversationId ?? "").trim();
  return id ? `${BOT_INBOX_SCOPE_PREFIX}${id}` : "";
}

function validationError(message) {
  return Object.assign(new Error(message), { code: "VALIDATION_FAILED" });
}

/**
 * 属于某会话的 run id 集合。会话两侧都要看：历史 runIds + 当前 activeRunId
 * （activeRunId 必在 runIds 内由 ConversationStore 保证，这里仍做并集以免上游形状漂移）。
 */
export function conversationRunIds(conversation) {
  const ids = new Set();
  if (Array.isArray(conversation?.runIds)) {
    for (const id of conversation.runIds) {
      const value = String(id ?? "").trim();
      if (value) ids.add(value);
    }
  }
  const active = String(conversation?.activeRunId ?? "").trim();
  if (active) ids.add(active);
  return ids;
}

/**
 * 收集某个 Bot 会话的协作收件箱。
 * @param {object} options
 * @param {{id: string, title?: string, runIds?: string[], activeRunId?: string|null}} options.conversation
 * @param {Array<object>} [options.runs]  全量 run（通常 state.orchestrator.list()），本函数自行按会话裁剪
 * @param {(runId: string, options?: object) => Promise<object>} options.readTail  run bus 有界读取
 * @param {object|null} [options.lifecycleByKey]  ask 生命周期快照
 * @param {number} [options.maxRuns]
 * @param {number} [options.maxMessages]
 * @param {number} [options.maxConcurrentReads]
 * @param {AbortSignal} [options.signal]
 */
export async function collectBotConversationInbox({
  conversation,
  runs = [],
  readTail,
  lifecycleByKey = null,
  maxRuns = INBOX_LIMITS.maxRuns,
  maxMessages = INBOX_LIMITS.maxMessages,
  maxConcurrentReads = INBOX_LIMITS.maxConcurrentReads,
  signal,
} = {}) {
  const conversationId = String(conversation?.id ?? "").trim();
  if (!conversationId) throw validationError("conversation is required for the Bot inbox projection");
  if (typeof readTail !== "function") throw validationError("readTail is required for the Bot inbox projection");

  const scope = botInboxScopeId(conversationId);
  const wanted = conversationRunIds(conversation);

  // 作用域声明：只把属于本会话的 run 交出去，并盖上合成 scope id 让上游过滤通过。
  const scopedRuns = (Array.isArray(runs) ? runs : [])
    .filter((run) => run && wanted.has(String(run.id ?? "").trim()))
    .map((run) => ({ ...run, teamId: scope }));

  const inbox = await collectTeamInbox({
    teamId: scope,
    team: { id: scope, name: String(conversation.title ?? "").trim() || conversationId },
    runs: scopedRuns,
    readTail,
    lifecycleByKey,
    maxRuns,
    maxMessages,
    maxConcurrentReads,
    signal,
  });

  // 消息级截断在上游是**无声的**：`collaboration-inbox.mjs:191` 先 slice(0, maxMessages)，
  // `:214` 才从截断后的窗口里过滤 pendingAsks；而 `:224` 的 partial 只看 run 级截断与源状态。
  // 后果：一条悬而未答的旧 ask 一旦落到窗口外，就从「待我处理」彻底消失，而 status 仍是 ok
  // —— 恰恰在「最该被提醒」的场景给出静默假阴性。本模块对外承诺就是「待我处理」，
  // 所以在这一层补信号（不动上游，保持"不产生第二真源"的取舍）。
  //
  // 判定只能是**保守近似**：公开的 sources 投影刻意不含 messages
  // （collaboration-inbox.mjs:242 只留 runId/status/diagnostics），而上游也没暴露
  // 「slice 前有多少条」；sources[].diagnostics.parsedMessages 是 **kind 过滤前**的原始条数，
  // 拿来比会把 relay 的 task 之类非协作消息算成"被截断"（假阳性）。
  // 因此取 `messageCount >= maxMessages`：窗口满即报警。
  // 代价：窗口**恰好**装满时也会报一次降级（轻微假阳性）。这个方向的错我们接受——
  // 本条要修的正是反方向的静默假阴性（旧 ask 消失而面板说"没有待办"），
  // 宁可多提醒一次「可能不全」，也不能让用户漏掉待办。措辞用「可能」，不谎报具体条数。
  const messageWindowFull = Number(inbox.diagnostics?.messageCount ?? 0) >= maxMessages;
  const diagnostics = messageWindowFull
    ? {
        ...inbox.diagnostics,
        status: "partial",
        issues: [
          {
            code: "INBOX_MESSAGES_TRUNCATED",
            message: `消息窗口已达上限（${inbox.diagnostics.messageCount} 条），更早的待办可能未列出`,
            systemCode: null,
          },
          ...(Array.isArray(inbox.diagnostics.issues) ? inbox.diagnostics.issues : []),
        ].slice(0, INBOX_LIMITS.maxIssues),
      }
    : inbox.diagnostics;

  return {
    ...inbox,
    schema: BOT_INBOX_SCHEMA,
    scope,
    diagnostics,
    // 覆盖上游的 team 投影：这里不是真实团队，如实标注避免消费方误读为团队收件箱。
    team: { id: scope, name: inbox.team?.name ?? conversationId, synthetic: true },
    conversation: {
      id: conversationId,
      title: String(conversation.title ?? "").trim() || conversationId,
      // runCount = 实际命中现存 run 的数量；linkedRunIds = 会话登记的总数。
      // 两者不等说明会话里有已不存在的 run id——分开报，别让消费方把差额当无事发生。
      runCount: scopedRuns.length,
      linkedRunIds: wanted.size,
    },
    inboxSource: "collaboration-inbox",
    generatedAt: new Date().toISOString(),
  };
}
