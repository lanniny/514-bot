/**
 * collab-status.js — 协作状态唯一词典（纯数据，零 import）。
 *
 * 为什么存在：同一状态此前散落在四处各有一套文案，互相矛盾
 *   - public/modules/bot-workspace-chrome.js  运行 chip（紧凑列表用语）
 *   - public/modules/collaboration-process.js 过程面板（含图标）
 *   - public/utils.js                        runStatusText（使用面最广）
 *   - src/collaboration-inbox.mjs            服务端 inbox 归类（不改，见下）
 * **本模块是状态「语义」的唯一真源**（key → tone / label / compact）。任何新的状态展示
 * 都应消费这里，不再本地硬编码**状态到语义的映射**。
 *
 * ⚠️ 边界（2026-09-11 更正，原文写的是"本模块是前端唯一出口"——**那句话不成立**）：
 *   1. **表述层是独立的一层**。`app.js` 的 `botRunPresentation` 仍自带一套**叙述式**用语
 *      （"成员正在工作""等待你继续""已送入运行队列"…），服务运行队列行与头部状态的长句场景。
 *      它与本模块的**标签式**用语语域不同（叙述 vs 标签），是**有意的分层，不是遗漏**。
 *      **代价必须写明**：右栏内因此**同时存在两套用语**，改状态文案时两处都要看。
 *      独立审计（`codex-to-claude__bot-rail-audit__20260911.md` F3）把 `botRunPresentation`
 *      记作"第 5 套词典"——按上面这条边界，它是**表述层而非真源**；是否收编属未决项（见该 handoff）。
 *   2. ~~渲染器 `collab-status-chip.js` 已备好、有完整测试，但当前生产代码零消费者~~
 *      → **已于 2026-09-11 删除**（连同 `forge/collab.css`）。原因是复核发现它**不是"没接线"
 *      而是"不需要"**：既有的 `botRunStatusChip`（数据投影）+ 各处本地 markup 已经够用，
 *      该渲染器自始至终零消费者。留着一份**测试全绿却没人调用**的渲染器，比删掉它危险得多——
 *      它会让下一个人以为状态 chip 已经统一到词典了。**记录在此，避免有人再去造第二个。**
 *      → 本模块有消费者的部分：`botRunStatusChip` / `botRunSemantic`（bot-workspace-chrome.js）。
 *
 * 设计约束（改动前必读）
 * 1. 「两套 tone」是有意的，不是冗余：
 *      tone     —— 过程/运行语义色（queued|running|complete|attention|inactive|unknown），
 *                  collaboration-process.js 的 counts.* 按它分桶，键值冻结。
 *      chipTone —— 运行 chip 视觉色（waiting|running|attention|error|warning|complete|muted），
 *                  bot-workspace-chrome 的 BOT_RUN_STATUS_GROUPS 按它分组，键值冻结。
 *      两者服务不同视觉体系，合并会打破 tests/bot-workspace-chrome.test.mjs 与
 *      tests/collaboration-process.test.mjs 的既有断言。统一留待后续波次并有意更新测试。
 * 2. label 与 compact 是两级用语，不是重复：
 *      label   —— 规范用语，用于内容区（过程面板、会话流、工具提示）。
 *      compact —— 紧凑用语，用于密集列表（chrome 的运行 chip）。紧凑值刻意与其历史文案一致，
 *                  保证统一词典不改变既有观感。tests/bot-workspace-chrome.test.mjs:74/97-99 锁定。
 * 3. waiting-user 与 waiting-peer 必须分开：前者要人动手，后者等同伴接手。
 *      二者此前同归 attention，用户无法区分该谁行动——这是协作场景最核心的一条语义。
 * 4. 服务端 src/collaboration-inbox.mjs 自带 ACTIVE_RUN_STATES / ATTENTION_RUN_STATES，
 *      与前端语义存在已知冲突（recovery_required 前端算活跃、inbox 算需处理）。
 *      该文件被 src/team-attention.mjs 依赖，本波次不改服务端；前端按 semantic 字段如实标注。
 *
 * 图标名必须是 public/lucide-sprite.svg 内已存在的 symbol
 * （tests/lucide-sprite-contract.test.mjs 会机械校验 #lucide-* 引用）。
 */

/** 状态归属的三层语义层。 */
export const COLLAB_LAYERS = Object.freeze({
  session: "session", // L1 会话层：这个协作单元活着吗
  run: "run", // L2 运行层：这轮跑到哪、卡在谁身上
  member: "member", // L3 成员层：这个人此刻在干什么
});

/**
 * 「在等谁」语义。null 表示该状态不表达阻塞归属。
 * tone 用 chipTone 词汇，供等待类 chip 复用运行 chip 的视觉体系。
 */
export const COLLAB_SEMANTICS = Object.freeze({
  "waiting-user": Object.freeze({ label: "等你", icon: "bell", tone: "attention" }),
  "waiting-peer": Object.freeze({ label: "等同伴", icon: "waypoints", tone: "attention" }),
});

export const COLLAB_STATUS_FALLBACK = Object.freeze({
  label: "状态未知",
  compact: "状态未知",
  tone: "unknown",
  chipTone: "muted",
  icon: "circle-dot",
  semantic: null,
  layer: null,
});

const entry = (label, compact, tone, chipTone, icon, semantic, layer) =>
  Object.freeze({ label, compact, tone, chipTone, icon, semantic, layer });

/** 状态 → 唯一语义。键统一小写、连字符转下划线。 */
export const COLLAB_STATUS = Object.freeze({
  // ── L2 运行层 ────────────────────────────────────────────────
  queued: entry("待执行", "排队中", "queued", "waiting", "circle-pause", null, "run"),
  pending: entry("待执行", "排队中", "queued", "waiting", "circle-pause", null, "run"),
  planning: entry("规划中", "规划中", "running", "running", "loader-circle", null, "run"),
  executing: entry("执行中", "进行中", "running", "running", "loader-circle", null, "run"),
  running: entry("执行中", "进行中", "running", "running", "loader-circle", null, "run"),
  active: entry("执行中", "进行中", "running", "running", "loader-circle", null, "run"),
  integrating: entry("综合中", "进行中", "running", "running", "loader-circle", null, "run"),
  verifying: entry("验证中", "验证中", "running", "running", "loader-circle", null, "run"),

  // 等待类：先分清等谁，再谈忙闲
  waiting_agent: entry("等待 Agent", "等待中", "queued", "waiting", "circle-pause", "waiting-peer", "run"),
  waiting: entry("等待中", "等待中", "queued", "waiting", "circle-pause", null, "run"),
  // chipTone 刻意沿用 chrome 的 "waiting"（而非 attention）：收紧视觉分组属独立议题，
  // 不在统一词典这一波里改变既有分组归属。
  waiting_user: entry("等待你处理", "等待中", "attention", "waiting", "bell", "waiting-user", "run"),
  waiting_input: entry("等待你处理", "等待中", "attention", "waiting", "bell", "waiting-user", "run"),
  waiting_approval: entry("等待审批", "待审批", "attention", "attention", "shield", "waiting-user", "run"),
  waiting_for_approval: entry("等待审批", "待审批", "attention", "attention", "shield", "waiting-user", "run"),
  approval_required: entry("等待审批", "待审批", "attention", "attention", "shield", "waiting-user", "run"),

  // 异常与恢复
  recovery_required: entry("需人工恢复", "需恢复", "attention", "error", "circle-alert", "waiting-user", "run"),
  interrupted: entry("已中断，可继续", "已中断", "attention", "warning", "circle-stop", null, "run"),
  blocked: entry("已阻塞", "已阻塞", "attention", "attention", "circle-alert", "waiting-user", "run"),
  timed_out: entry("执行超时", "执行超时", "attention", "attention", "circle-alert", null, "run"),
  rejected: entry("已拒绝", "已拒绝", "attention", "attention", "circle-alert", null, "run"),
  ambiguous: entry("提交状态待核对", "提交状态待核对", "attention", "attention", "circle-alert", null, "run"),
  unsettled: entry("执行状态待核对", "执行状态待核对", "attention", "attention", "circle-alert", null, "run"),
  lost: entry("执行失联", "执行失联", "attention", "attention", "circle-alert", "waiting-user", "run"),

  // 收束
  complete: entry("已完成", "已完成", "complete", "complete", "circle-check", null, "run"),
  completed: entry("已完成", "已完成", "complete", "complete", "circle-check", null, "run"),
  succeeded: entry("已完成", "已完成", "complete", "complete", "circle-check", null, "run"),
  failed: entry("执行失败", "失败", "attention", "error", "circle-alert", null, "run"),
  cancelled: entry("已取消", "已取消", "inactive", "muted", "circle-stop", null, "run"),
  canceled: entry("已取消", "已取消", "inactive", "muted", "circle-stop", null, "run"),
  skipped: entry("未执行", "未执行", "inactive", "muted", "minus", null, "run"),
  superseded: entry("已被后续执行替代", "已被替代", "inactive", "muted", "minus", null, "run"),

  // ── L3 成员层：交接（不是 run 状态，是成员间交接的展示态）────────
  handoff_open: entry("待确认接手", "待确认", "attention", "attention", "waypoints", "waiting-peer", "member"),
  handoff_acked: entry("已接手", "已接手", "complete", "complete", "circle-check", null, "member"),

  // ── L1 会话层 ────────────────────────────────────────────────
  session_active: entry("运行中", "运行中", "running", "running", "loader-circle", null, "session"),
  session_idle: entry("空闲", "空闲", "inactive", "muted", "circle-dot", null, "session"),
  session_attention: entry("需处理", "需处理", "attention", "attention", "circle-alert", "waiting-user", "session"),
});

/** pendingAsk 是运行时标志位而非状态：它把「等 Agent」变成「等你回答」。 */
const PENDING_ASK_ENTRY = entry("等你回答", "等你回答", "attention", "attention", "bell", "waiting-user", "run");

export function normalizeCollabStatus(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_");
}

/**
 * 查状态语义。
 * @param {string} status
 * @param {{pendingAsk?: boolean}} [options] pendingAsk=true 时 waiting_agent 升级为「等你回答」
 * @returns {{label:string,compact:string,tone:string,chipTone:string,icon:string,semantic:string|null,layer:string|null}}
 */
export function collabStatusOf(status, { pendingAsk = false } = {}) {
  const key = normalizeCollabStatus(status);
  if (pendingAsk && key === "waiting_agent") return PENDING_ASK_ENTRY;
  return COLLAB_STATUS[key] || COLLAB_STATUS_FALLBACK;
}

/** 规范用语（内容区用）。 */
export function collabStatusLabel(status, options) {
  return collabStatusOf(status, options).label;
}

/** 紧凑用语（密集列表用）。 */
export function collabStatusCompact(status, options) {
  return collabStatusOf(status, options).compact;
}

/** 「在等谁」语义对象；无归属时返回 null。 */
export function collabSemanticOf(status, options) {
  const semantic = collabStatusOf(status, options).semantic;
  return semantic ? COLLAB_SEMANTICS[semantic] || null : null;
}

/** 该状态是否阻塞在人类动作上。 */
export function collabNeedsUser(status, options) {
  return collabStatusOf(status, options).semantic === "waiting-user";
}

/** 全部键（供一致性测试枚举）。 */
export function collabStatusKeys() {
  return Object.keys(COLLAB_STATUS);
}
