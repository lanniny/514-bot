/**
 * 事件严重度分级契约（v49 · 2026-09-04）。
 *
 * ── 为什么需要这个模块 ──
 * 原实现在 `workbench-topology.js` 用一条词表正则猜事件语义：
 *   `/fail|error|denied|dropped|blocked/i.test(type) → red`
 * 它抓得到 `*_failed` / `*_blocked`，但**漏掉 9 类词根共 14 个事件类型**：
 *   rejected / degraded / exhausted / revoked / cancelled / timeout / deferred /
 *   skipped / unproductive
 * 后果具体且可证伪：`run.directive_rejected`（LO 的指令被拒）与 `run.sources_added`
 * （加了个数据源）在时间线上**同色同形**。对"可问责的协作台"来说，失败语义不分级
 * 等于把问题埋掉——LO 扫一眼时间线不可能发现指令被拒了。
 *
 * ── 治法：从"前端猜词"改成"显式声明表" ──
 * 词表方案的根本病是**两套东西各自演化**：后端把语义编码进事件名，前端用词表反解。
 * 加一个新事件类型时，没有任何机械force让人回来更新词表——腐烂是必然的，不是疏忽。
 * 所以这里改为：
 *   1. 严重度是**逐类型显式声明**（EVENT_SEVERITY 表），不做模式匹配猜测
 *   2. 未声明的类型走 `classifyUnknownEventType()` 保守推断，**并标记 inferred:true**
 *      让"漏登记"这件事本身可被测试和审计发现，而不是静默给个默认值
 *   3. `assertSeverityCoverage()` 供测试调用——喂入后端真实事件类型清单，
 *      任何未声明的类型都会被列出来。这是防腐的机械扳机（对标 dsh 的
 *      "model-visible means logged, and a runtime invariant asserts it"）。
 *
 * ── 不变量（机械可判定，测试逐条断言）──
 *   INV1 severityOf() 对任意输入（含 null/undefined/数字/对象/原型键）都返回合法档位，绝不抛
 *   INV2 每个声明为 attention/critical 的类型，toneOf() 必不返回 "neutral"/"rose"
 *   INV3 原词表能抓到的（*_failed / *_blocked），新表必须仍判 critical —— 不回退
 *   INV4 14 个漏网类型必须全部升到 attention 或 critical —— 这是本模块存在的理由
 *   INV5 未声明类型返回 inferred:true，且不冒充已声明（可审计）
 *   INV6 原型链键（constructor / __proto__ / toString）不被误当已声明类型
 *
 * 纯 ESM，零 DOM 依赖，可在 node --test 直接断言。
 */

/** 严重度档位（有序，数值越大越紧急）。tone 由档位派生，不再由类型名派生。 */
export const SEVERITY = Object.freeze({
  info: 0,        // 正常进展，无需注意
  notice: 1,      // 值得知道的状态变化（授权变更、加源）
  attention: 2,   // 降级/被拒/耗尽 —— 任务还活着但没按预期走
  critical: 3,    // 失败/需人介入 —— 不处理就停在这儿
});

export const SEVERITY_ORDER = Object.freeze(["info", "notice", "attention", "critical"]);

/** 档位 → 视觉色调。单一映射点，改配色只改这里。 */
const SEVERITY_TONE = Object.freeze({
  info: "neutral",
  notice: "blue",
  attention: "amber",
  critical: "red",
});

/**
 * 逐类型显式声明。未列出的类型走保守推断并标 inferred。
 * 分档依据（写出来是为了下次加事件时有判据，不靠感觉）：
 *   critical  = 任务失败 / 需人工介入才能继续 / 审计链断裂
 *   attention = 降级但仍在跑 / 请求被拒 / 预算或步数耗尽 / 权限被收回
 *   notice    = 状态发生了 LO 可能想知道的变化
 *   info      = 正常生命周期节点
 */
export const EVENT_SEVERITY = Object.freeze({
  // ── critical：停在这儿了，不处理不会自己好 ──
  "run.failed": "critical",
  "agent.turn_failed": "critical",
  "run.recovery_required": "critical",
  "run.context_compaction_failed": "critical",
  "run.context_publication_failed": "critical",
  "adapter.replay_blocked": "critical",
  "adapter.parse_error": "critical",
  "protocol.unsupported_envelope": "critical",
  "server.error": "critical",
  "config.rolled_back": "critical",              // 配置写入失败已回滚 —— 用户的改动没生效
  "automation.trigger_failed": "critical",
  "automation.tick_failed": "critical",
  "automation.reconcile_error": "critical",
  "automation.store_degraded": "critical",       // 定时任务存储降级 = 编排面不可信

  // ── attention：还活着，但没按预期走 ──
  "run.directive_rejected": "attention",         // LO 的指令被拒 —— 原实现漏网
  "run.write_degraded": "attention",
  "run.cancel_degraded": "attention",
  "run.budget_exhausted": "attention",
  "run.interaction_steps_exhausted": "attention",
  "run.interrupt_timeout": "attention",
  "run.authorization_revoked": "attention",
  "capability.lease_revoked": "attention",
  "agent.turn_unproductive": "attention",        // 空转轮 —— 原实现判 blue
  "run.answer_deferred": "attention",
  "run.worktree_skipped": "attention",
  "adapter.fallback": "attention",               // 降级到备用 adapter，算法有变
  "adapter.close_degraded": "attention",
  "adapter.approval_unresolved": "attention",    // 审批悬空 = 安全面有洞
  "adapter.server_request_unsupported": "attention",
  "approval.capacity_rejected": "attention",     // 审批队列打满，请求被丢
  "approval.expired": "attention",               // 超时按拒绝处理（broker:143）
  // v50 许可通道。三条都是 attention 而非 info：它们各自意味着一次
  // "本该问操作者、结果没问成"——被静默当作 info 就等于把拒绝藏起来了。
  "approval.channel_unavailable": "attention",   // 通道建不起来，本轮退回"无宿主即拒"
  "approval.endpoint_rejected": "attention",     // 归属不符 / 超限 / 帧损坏，端点侧直接拒
  "approval.endpoint_error": "attention",        // 决策链路抛错，fail-closed 拒绝
  "provider.failover": "attention",
  "provider.proxy_takeover": "attention",
  "provider.backup_restore": "attention",
  "remote.source_restore": "attention",
  "ccswitch.proxy_persistence_warning": "attention",
  "security.secret_sweep": "attention",          // 密钥巡检产出即需人看

  // ── notice：状态变了，LO 可能想知道 ──
  "run.cancelled": "notice",                     // 主动取消是正常操作，不是故障
  "run.interrupted": "notice",
  "run.control_changed": "notice",
  "run.sources_added": "notice",
  "run.recovery_acknowledged": "notice",
  "run.round_refunded": "notice",
  "run.auto_recovery": "notice",
  "run.finished_cleared": "notice",
  "capability.lease_issued": "notice",
  "capability.changed": "notice",
  "run.waiting_approval": "notice",
  "run.waiting_input": "notice",
  "run.approved": "notice",
  "run.steer_queued": "notice",
  "approval.requested": "notice",
  "approval.pending": "notice",
  "approval.resolved": "notice",
  "config.changed": "notice",
  "config.recovered": "notice",
  "control.runtime_reloaded": "notice",
  "provider.switch": "notice",
  "provider.remote_switch": "notice",
  "remote.source_write": "notice",
  "capabilities.skill_created": "notice",
  "capabilities.agent_skill_toggled": "notice",
  "capabilities.mcp_enabled": "notice",
  "capabilities.mcp_disabled": "notice",
  "automation.created": "notice",
  "automation.updated": "notice",
  "automation.removed": "notice",
  "automation.cancelled": "notice",
  "automation.reconcile_backstop": "notice",     // 兜底对账动过手 —— 值得知道但非故障
  "ccswitch.proxy_started": "notice",
  "ccswitch.proxy_stopped": "notice",

  // ── info：正常生命周期 ──
  "run.created": "info",
  "run.completed": "info",
  "run.worktree_created": "info",
  "run.context_compaction_started": "info",
  "run.context_compaction_completed": "info",
  "agent.turn_started": "info",
  "agent.turn_completed": "info",
  "agent.turn_checkpoint": "info",
  "automation.triggered": "info",
  "bus.appended": "info",
  "bus.routed": "info",
  "user.message": "info",
  "assistant.message": "info",
  "tool.event": "info",
  "prompt.transport": "info",
  "grok.thinking": "info",
  "grok.completed": "info",
});

/**
 * 未声明类型的保守推断。**故意保留词表**——但只作为未登记类型的兜底，
 * 且结果一律标 inferred:true 让漏登记可被发现。词根按后端实际命名习惯取，
 * 比原实现的 5 词扩到覆盖 9 类漏网词根。
 */
const INFER_CRITICAL = /(?:^|[._])(?:failed|failure|error|denied|blocked|corrupt|broken)(?:$|[._])/i;
const INFER_ATTENTION = /(?:^|[._])(?:rejected|degraded|exhausted|revoked|timeout|deferred|skipped|unproductive|dropped|stale|fallback)(?:$|[._])/i;
const INFER_NOTICE = /(?:^|[._])(?:cancelled|canceled|interrupted|changed|added|removed|issued|queued|waiting|acknowledged|refunded)(?:$|[._])/i;

export function classifyUnknownEventType(type) {
  const value = typeof type === "string" ? type : "";
  if (INFER_CRITICAL.test(value)) return "critical";
  if (INFER_ATTENTION.test(value)) return "attention";
  if (INFER_NOTICE.test(value)) return "notice";
  return "info";
}

/**
 * INV1：任意输入都返回 { severity, tone, inferred }，绝不抛。
 * INV6：只认自有属性，原型链键（__proto__ / constructor / toString）不算已声明。
 */
export function severityOf(type) {
  const value = typeof type === "string" ? type : "";
  const declared = Object.prototype.hasOwnProperty.call(EVENT_SEVERITY, value)
    ? EVENT_SEVERITY[value]
    : null;
  if (declared && SEVERITY_ORDER.includes(declared)) {
    return { severity: declared, tone: SEVERITY_TONE[declared], inferred: false };
  }
  const inferredSeverity = classifyUnknownEventType(value);
  return { severity: inferredSeverity, tone: SEVERITY_TONE[inferredSeverity], inferred: true };
}

export function toneOf(type) {
  return severityOf(type).tone;
}

export function isAtLeast(type, floor) {
  const floorRank = SEVERITY[floor];
  if (!Number.isInteger(floorRank)) return false;
  return SEVERITY[severityOf(type).severity] >= floorRank;
}

/**
 * 防腐扳机：喂入后端真实事件类型清单，返回未显式声明的部分。
 * 测试用它断言"后端加了新事件类型但没来这里登记"——这是本模块不重新腐烂的唯一保障。
 * 返回 inferred 结果一并给出，方便判断兜底推断是否恰好正确（正确也仍需登记）。
 */
export function assertSeverityCoverage(backendTypes = []) {
  const list = Array.isArray(backendTypes) ? backendTypes : [];
  const undeclared = list
    .filter((type) => typeof type === "string" && type)
    .filter((type) => !Object.prototype.hasOwnProperty.call(EVENT_SEVERITY, type))
    .map((type) => ({ type, inferredSeverity: classifyUnknownEventType(type) }));
  return {
    total: list.length,
    declared: list.length - undeclared.length,
    undeclared,
    covered: undeclared.length === 0,
  };
}
