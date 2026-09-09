/**
 * P-21 前端埋点采集器（v48 S0-3）。
 *
 * 设计三原则：
 *   1. **永不阻塞**：全部 fire-and-forget，调用方不需要也不应该 await。任何网络
 *      失败静默吞掉——度量层的可用性优先级低于它所度量的主流程。
 *   2. **调用面即白名单**：不暴露"传任意对象"的入口。每个 track* 方法只接受
 *      具名的受限参数，敏感数据在调用侧就无处可传，不指望服务端兜底
 *      （服务端 FIELD_WHITELIST 是第二道防线，不是唯一防线）。
 *   3. **去抖**：同一 (type, key) 在 DEDUPE_MS 内只上报一次。setView 在一次导航中
 *      可能被多次调用（深链回填、状态同步），逐次上报会让"视图访问数"失真。
 *
 * 服务端契约见 src/product-telemetry.mjs 的 TELEMETRY_TYPES。
 */

import { PRODUCT_ACTION_IDS } from "./product-telemetry-catalog.js";

export { PRODUCT_ACTION_IDS };

const DEDUPE_MS = 3000;

export function createTelemetryClient({ request, apiReady = Promise.resolve(), enabled = true } = {}) {
  if (typeof request !== "function") throw new Error("createTelemetryClient requires request()");

  let active = enabled !== false;
  const lastSeen = new Map();
  let inflight = 0;
  const MAX_INFLIGHT = 4; // 背压：埋点请求不得挤占主业务的连接额度

  function shouldSend(dedupeKey, now) {
    if (!dedupeKey) return true;
    const previous = lastSeen.get(dedupeKey);
    if (previous !== undefined && now - previous < DEDUPE_MS) return false;
    lastSeen.set(dedupeKey, now);
    // 有界：避免长会话里 Map 无限增长
    if (lastSeen.size > 256) {
      for (const [key, at] of lastSeen) {
        if (now - at >= DEDUPE_MS) lastSeen.delete(key);
      }
    }
    return true;
  }

  /** 内部唯一出口。fire-and-forget：不返回 promise 给调用方，杜绝误 await。 */
  function send(type, fields, dedupeKey) {
    if (!active) return;
    if (inflight >= MAX_INFLIGHT) return;
    if (!shouldSend(dedupeKey, Date.now())) return;
    inflight += 1;
    apiReady
      .then(() => request("/api/telemetry/record", {
        method: "POST",
        body: JSON.stringify({ type, fields }),
      }))
      .catch(() => {}) // 静默：埋点失败绝不冒泡到用户
      .finally(() => { inflight -= 1; });
  }

  function surfaceOf() {
    if (typeof window === "undefined") return undefined;
    const width = window.innerWidth || 0;
    if (width && width < 640) return "mobile";
    if (width && width < 1024) return "tablet";
    return "desktop";
  }

  return {
    /** 视图被打开。view 应为 nav-config 的 NAV_ITEMS 键。 */
    trackView(view) {
      if (!view) return;
      send("usage.view", { view: String(view), surface: surfaceOf() }, `view:${view}`);
    },

    /**
     * 某项能力被调用。
     * @param {string} capability 能力 id，如 "run.create"
     * @param {"success"|"failure"|"abandoned"|"blocked"} [outcome]
     * @param {number} [durationMs]
     */
    trackCapability(capability, outcome, durationMs) {
      if (!capability) return;
      const fields = { capability: String(capability) };
      if (outcome) fields.outcome = String(outcome);
      if (Number.isFinite(durationMs)) fields.durationMs = Math.floor(durationMs);
      // 能力调用不去抖：每次调用都是独立的产品事实
      send("usage.capability", fields);
    },

    /**
     * C5 关键动作。只接受标识符字段——outcome / action / count，
     * 没有自由文本入口，prompt 与消息体在调用面就传不进来。
     */
    trackAction(capability, { outcome, action, count, durationMs } = {}) {
      if (!capability) return;
      const fields = { capability: String(capability) };
      if (outcome) fields.outcome = String(outcome);
      if (action) fields.action = String(action);
      if (Number.isFinite(count)) fields.count = Math.floor(count);
      if (Number.isFinite(durationMs)) fields.durationMs = Math.floor(durationMs);
      send("usage.capability", fields);
    },

    /** 发起一个 Run —— 北极星「可信托付率」的分母。member 是席位 id，不是内容。 */
    trackDelegation(member) {
      send("trust.delegated", member ? { member: String(member) } : {});
    },

    /** 中途干预 —— 北极星的分子来源。 */
    trackIntervention(kind) {
      const allowed = ["steer", "interrupt", "takeover", "rollback"];
      if (!allowed.includes(String(kind))) return;
      send("trust.intervention", { intervention: String(kind) });
    },

    /** 审批决策。 */
    trackApproval(outcome) {
      send("trust.approval", outcome ? { outcome: String(outcome) } : {});
    },

    /**
     * 摩擦信号（P-22）。errorKind 必须是**分类码**不是错误文本——
     * 传 error.message 会把用户内容和路径带进埋点。
     */
    trackFriction(kind, { errorKind, view } = {}) {
      const type = { repeat: "friction.repeat", abandon: "friction.abandon", error: "friction.error" }[String(kind)];
      if (!type) return;
      const fields = {};
      if (errorKind) fields.errorKind = String(errorKind);
      if (view) fields.view = String(view);
      send(type, fields);
    },

    /** 首次运行就绪的一步。 */
    trackActivationStep(step, outcome) {
      if (!step) return;
      const fields = { step: String(step) };
      if (outcome) fields.outcome = String(outcome);
      send("activation.step", fields, `step:${step}:${outcome ?? ""}`);
    },

    setEnabled(next) {
      active = next !== false;
      if (!active) lastSeen.clear();
      return active;
    },

    isEnabled() {
      return active;
    },
  };
}
