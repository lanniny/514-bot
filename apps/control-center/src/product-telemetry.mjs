/**
 * P-21 产品行为埋点层（v48 S0）——回答"14 个视图里哪几个从来没被打开过"。
 *
 * 立项背景见 proposals/v48-product-completion-blueprint.md §8.3 与 D-2026-09-04-001：
 * 此前全仓 grep `analytics|telemetry` 零命中，导致任何产品优先级判断都只能拍脑袋。
 *
 * ── 五条硬约束（LO 2026-09-04 授权时的前提，不可在后续迭代中悄悄放宽）────────────
 *   1. 纯本地：只写本地 JSONL，无任何出站请求。本模块不 import 任何网络能力。
 *   2. 可关闭并清空：setEnabled(false) 立即停止写入；clear() 物理删除落盘文件。
 *   3. 走事件哈希链：复用 EventStore，天然获得 prev/hash 追加式防篡改与 verifyChain()。
 *   4. 默认脱敏：EventStore.emit() 内部已过 sanitizeForPersistence()。
 *   5. 不进 Run 事件流：独立文件，见下方"为什么不复用主 EventStore"。
 *
 * ── 为什么不复用主 EventStore（设计判断，勿逆转）────────────────────────────────
 *   UI 行为的产生频率比 Run 事件高一个量级（每次视图切换/能力调用都记一条）。
 *   混入主流会造成三个后果：①观测面被噪音淹没，Run 时间线不再可读；②主
 *   events.jsonl 当前已 24MB/38551 行，混流会加速触顶；③一键清空埋点将被迫
 *   连带删除 Run 证据——那是审计资产，绝不能被产品度量的生命周期绑架。
 *   因此这里持有独立 EventStore 实例（独立 path、独立配额、独立清空）。
 *
 * ── 为什么用字段白名单而不是只靠脱敏（隐私判断，勿逆转）──────────────────────
 *   sanitizeForPersistence 是黑名单思路：尽力擦掉"认得出的"秘密。埋点数据会长期
 *   累积、且价值在于聚合统计而非细节，所以这里采用更强的白名单：只有 FIELD_WHITELIST
 *   声明的字段能落盘，其余静默丢弃。自由文本、文件路径、prompt 内容在结构上就进不来，
 *   不依赖"脱敏器认不认得出"。脱敏仍在下游生效，是第二道防线而非唯一防线。
 */

import { rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { EventStore } from "./event-store.mjs";
import {
  REGISTERED_VIEWS,
  REGISTERED_CAPABILITIES,
  unusedRegistered,
} from "../public/modules/product-telemetry-catalog.js";

export { REGISTERED_VIEWS, REGISTERED_CAPABILITIES, unusedRegistered };

/** 埋点事件类型分类学，对应 v48 §8.2 的四层指标。未在此列的 type 一律拒绝。 */
export const TELEMETRY_TYPES = Object.freeze({
  // 激活层：新用户能否跑通第一个 Run
  "activation.step": "首次运行就绪四步中的一步状态变化",
  "activation.first_run": "首个可执行 Run 达成",
  // 参与层：能力实际被用到什么程度（P-20 死能力回收的数据源）
  "usage.view": "视图被打开",
  "usage.capability": "某项能力被调用",
  "usage.session": "一段使用会话结束",
  // 信任层：北极星「可信托付率」的原料
  "trust.delegated": "发起一个 Run（托付基线）",
  "trust.intervention": "中途干预（steer / interrupt / 接管）",
  "trust.approval": "审批决策",
  // 摩擦层：P-22 体验问题自动捕获
  "friction.repeat": "短时间内重复同一操作",
  "friction.abandon": "流程中途放弃",
  "friction.error": "用户可见的错误",
});

/**
 * 字段白名单。值为校验器，返回 undefined 表示丢弃该字段。
 * 新增字段前请自问：这个字段会不会携带用户内容？会就不要加。
 */
const FIELD_WHITELIST = Object.freeze({
  /** 视图 id，取值域应为 nav-config 的 NAV_ITEMS 键 */
  view: (v) => slug(v, 48),
  /** 能力 id，如 "run.create" / "approval.grant" */
  capability: (v) => slug(v, 64),
  /** 动作类型，如 "open" / "submit" / "cancel" */
  action: (v) => slug(v, 32),
  /** 结果，受控枚举 */
  outcome: (v) => (["success", "failure", "abandoned", "blocked"].includes(String(v)) ? String(v) : undefined),
  /** 表面，受控枚举 */
  surface: (v) => (["desktop", "tablet", "mobile", "server"].includes(String(v)) ? String(v) : undefined),
  /** 已就绪步骤 id */
  step: (v) => slug(v, 48),
  /** 干预种类，受控枚举 */
  intervention: (v) => (["steer", "interrupt", "takeover", "rollback"].includes(String(v)) ? String(v) : undefined),
  /** 时长毫秒，上限 24h 防脏数据 */
  durationMs: (v) => clampInt(v, 0, 86_400_000),
  /** 计数 */
  count: (v) => clampInt(v, 0, 1_000_000),
  /** 错误分类码（非错误文本！）如 "network" / "permission" */
  errorKind: (v) => slug(v, 40),
  /** 成员/席位 id —— 是标识符不是内容 */
  member: (v) => slug(v, 64),
});

/** 只允许标识符形态：字母数字与 . _ - :，其余字符剥离。天然挡住路径、URL、自然语言。 */
function slug(value, max) {
  const clean = String(value ?? "").replace(/[^A-Za-z0-9._:-]/g, "").slice(0, max);
  return clean || undefined;
}

function clampInt(value, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

/** 白名单过滤：未声明字段静默丢弃，不报错——埋点绝不能因为脏参数打断主流程。 */
export function filterFields(fields = {}) {
  const out = {};
  if (!fields || typeof fields !== "object") return out;
  for (const [key, validate] of Object.entries(FIELD_WHITELIST)) {
    if (!(key in fields)) continue;
    const value = validate(fields[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const DEFAULT_RATE_LIMIT = 240; // 每分钟上限，防高频 UI 事件（滚动/hover 误接）打爆磁盘
const RATE_WINDOW_MS = 60_000;

export class ProductTelemetry {
  /**
   * @param {object}  options
   * @param {string}  options.path      落盘 JSONL 路径（独立于主 events.jsonl）
   * @param {boolean} options.enabled   总开关默认值；**磁盘上的持久化值优先**（见 #loadSettings）
   * @param {number}  options.rateLimit 每分钟事件上限
   */
  constructor({ path, enabled = true, rateLimit = DEFAULT_RATE_LIMIT, knownViews, knownCapabilities } = {}) {
    if (!path) throw new Error("ProductTelemetry requires a path");
    this.path = path;
    this.knownViews = Array.isArray(knownViews) ? [...knownViews] : [...REGISTERED_VIEWS];
    this.knownCapabilities = Array.isArray(knownCapabilities) ? [...knownCapabilities] : [...REGISTERED_CAPABILITIES];
    // F-3 修复：opt-out 必须跨重启存活。只放内存里等于"可临时暂停到下次重启"，
    // 而 LO 授权时说的是"可关闭"——那是两回事。
    this.settingsPath = `${path.replace(/\.jsonl$/, "")}.settings.json`;
    this.enabled = enabled !== false;
    this.rateLimit = Math.max(1, Math.floor(Number(rateLimit) || DEFAULT_RATE_LIMIT));
    this.store = null;
    this.initPromise = null;
    this.clearing = false;
    this.windowStart = 0;
    this.windowCount = 0;
    this.dropped = 0;
  }

  async #loadSettings() {
    try {
      const raw = JSON.parse(await readFile(this.settingsPath, "utf8"));
      if (typeof raw?.enabled === "boolean") this.enabled = raw.enabled;
    } catch {
      // 缺文件/损坏都用构造默认值——但绝不因此把"用户关过"变成"重新开启"，
      // 因为缺文件的语义是"从未设置过"，不是"设置为开"。
    }
  }

  async #saveSettings() {
    try {
      await mkdir(dirname(this.settingsPath), { recursive: true });
      await writeFile(this.settingsPath, `${JSON.stringify({ enabled: this.enabled })}\n`, "utf8");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 返回 this 以对齐代码库统一的 `await new X({...}).init()` 链式构造模式。
   *
   * F-1 修复：缓存 in-flight promise。此前 `this.store` 在 `await store.init()`
   * **之前**就被赋值，并发调用者看到非空即提前返回，拿到半初始化 store——
   * 而 EventStore#initFromDisk 会把 sequence 归零并覆盖 chainTip，导致已 emit 的
   * 事件序号回卷、落盘行 prev 指向不存在的哈希（实证 verifyChain().ok=false）。
   */
  async init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      await this.#loadSettings();
      // 埋点不需要 per-run 索引（没有 runId 维度的回读需求），配额压到最小以省内存。
      const store = new EventStore(this.path, { recentLimit: 256, perRunLimit: 1, maxRunIndexes: 1 });
      await store.init();
      this.store = store; // 关键：只有 init 完成后才对外可见
      return this;
    })().catch((error) => {
      this.initPromise = null; // 失败不缓存，允许重试
      throw error;
    });
    return this.initPromise;
  }

  /** 开关变更立即落盘。返回值是内存态；持久化失败经 persisted 字段如实上报，不假装成功。 */
  async setEnabled(next) {
    this.enabled = next !== false;
    const persisted = await this.#saveSettings();
    return { enabled: this.enabled, persisted };
  }

  /** 令牌桶（滑动窗口简化版）。超限只计数不抛错——埋点失败绝不能影响用户操作。 */
  #withinRate(now) {
    if (now - this.windowStart >= RATE_WINDOW_MS) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    if (this.windowCount >= this.rateLimit) return false;
    this.windowCount += 1;
    return true;
  }

  /**
   * 记录一条埋点。**永不抛错**——任何失败都退化为静默丢弃并计数，
   * 因为度量层的可靠性优先级低于它所度量的主流程。
   * @returns {Promise<boolean>} 是否真的落盘
   */
  async record(type, fields = {}) {
    if (!this.enabled) return false;
    // F-2 修复：clear() 期间的写入闸门。此前 rm() 的异步窗口里进来的 record 会
    // 惰性 init 读到尚未删除的旧文件，把 chainTip 设为旧链尾，rm 之后写入的首行
    // prev 指向已消失的哈希 —— 文件复活且链永久 prev-mismatch（实证 29 行断 2 处）。
    if (this.clearing) {
      this.dropped += 1;
      return false;
    }
    // S-1 修复：type 校验放进 try。此前 Object.hasOwn 在 try 之外，敌意
    // `{ toString(){ throw } }` 能穿透"永不抛错"契约（HTTP 层不可达，内部调用点可达）。
    try {
      const key = String(type);
      if (!Object.hasOwn(TELEMETRY_TYPES, key)) {
        this.dropped += 1;
        return false;
      }
      if (!this.#withinRate(Date.now())) {
        this.dropped += 1;
        return false;
      }
      if (!this.store) await this.init();
      // init 期间可能已进入 clear，再检一次
      if (this.clearing || !this.store) {
        this.dropped += 1;
        return false;
      }
      await this.store.emit(key, filterFields(fields), { sensitivity: "internal" });
      return true;
    } catch {
      this.dropped += 1;
      return false;
    }
  }

  /**
   * 产品健康看板（P-23）的数据源：按类型/视图/能力聚合。
   * 只做聚合不返回原始事件——消费方不需要逐条，也不该被鼓励逐条读。
   *
   * 用 iterate() 做**全量**扫描而非 list()：list() 被 DEFAULT_RECENT_LIMIT=2000 截断，
   * 而 P-20「哪些视图从未被打开」必须看全历史，截断会把"很久没用"误报成"从未使用"。
   * maxScan 是防失控上限，触顶时 truncated=true 显式标注，绝不静默给出偏斜统计。
   */
  async summary({ maxScan = 200_000 } = {}) {
    if (!this.store) await this.init();
    // F-4 修复：用 null 原型对象当 map。此前 `{}` 字面量 + `byView[key] = (byView[key]||0)+1`
    // 在 key="constructor"/"toString" 时读到原型上的函数，拼成函数源码字符串写回，
    // 让 API 响应里本该是 number 的位置变成字符串（实证经公开 POST 端点即可触发）。
    // slug() 的字符集放行这些名字——它们全由合法标识符字符组成。
    const byType = Object.create(null);
    const byView = Object.create(null);
    const byCapability = Object.create(null);
    const outcomes = { success: 0, failure: 0, abandoned: 0, blocked: 0 };
    let interventions = 0;
    let delegations = 0;
    let total = 0;
    let truncated = false;
    let firstAt = null;
    let lastAt = null;

    for await (const event of this.store.iterate()) {
      if (total >= maxScan) { truncated = true; break; }
      const type = String(event?.type || "");
      if (!Object.hasOwn(TELEMETRY_TYPES, type)) continue;
      total += 1;
      if (!firstAt) firstAt = event.timestamp ?? null;
      lastAt = event.timestamp ?? lastAt;
      byType[type] = (byType[type] || 0) + 1;
      const data = event.data || {};
      if (data.view) byView[data.view] = (byView[data.view] || 0) + 1;
      if (data.capability) byCapability[data.capability] = (byCapability[data.capability] || 0) + 1;
      if (data.outcome && Object.hasOwn(outcomes, data.outcome)) outcomes[data.outcome] += 1;
      if (type === "trust.intervention") interventions += 1;
      if (type === "trust.delegated") delegations += 1;
    }

    const views = unusedRegistered(Object.keys(byView), this.knownViews);
    const capabilities = unusedRegistered(Object.keys(byCapability), this.knownCapabilities);

    return {
      schema: "514cc.product-telemetry.summary/v1",
      enabled: this.enabled,
      total,
      truncated,
      dropped: this.dropped,
      firstAt,
      lastAt,
      byType,
      byView,
      byCapability,
      outcomes,
      // 北极星原料：可信托付率 = 未被干预的托付 / 总托付。delegations=0 时为 null 而非 1，
      // 避免"没有数据"被误读成"完美表现"。
      trustedDelegationRate: delegations > 0
        ? Number(((delegations - Math.min(interventions, delegations)) / delegations).toFixed(4))
        : null,
      delegations,
      interventions,
      // 死能力回收（P-20）的判据：注册全集 − 已观察。unknown 观察值不进分母。
      observedViews: Object.keys(byView).sort(),
      knownViews: views.known,
      usedViews: views.used,
      unusedViews: views.unused,
      knownCapabilities: capabilities.known,
      usedCapabilities: capabilities.used,
      unusedCapabilities: capabilities.unused,
    };
  }

  /**
   * 一键清空：关闭 store 并物理删除文件。LO 授权前提之一，必须真删而非标记删除。
   * 全程持 clearing 闸门（F-2）：rm 的异步窗口内不允许任何 record 惰性重建文件。
   */
  async clear() {
    this.clearing = true;
    try {
      if (this.store) {
        await this.store.close?.();
      }
      this.store = null;
      this.initPromise = null;
      await rm(this.path, { force: true });
      this.windowStart = 0;
      this.windowCount = 0;
      this.dropped = 0;
      return { cleared: true, path: this.path, stillCollecting: this.enabled };
    } finally {
      this.clearing = false;
    }
  }

  async close() {
    if (!this.store) return;
    await this.store.close?.();
    this.store = null;
    this.initPromise = null;
  }
}
