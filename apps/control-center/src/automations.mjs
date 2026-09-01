// v3.7 Automations（codeg 对标核心缺口，proposals/v37-codeg-parity-design.md §2.1）：
// 把一次 composer 全配置（prompt/团队/起始/权限/模型/effort/cwd）存为命名自动化，
// 手动触发或按间隔计划 headless 跑——产生的 run 与手动 run 走同一治理链（审批/预算/轮次/事件全继承）。
// schedule 语法：`manual`（仅手动）| `idle`（闲时——控制面空闲时排队自动执行）| `every:<n>m|h|d`（简化间隔制——不为 v1 自研 cron 边界（月末/DST），
// 间隔制覆盖"每天体检"类主场景，语法可后扩）。
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findSecretCandidates } from "./redaction.mjs";
import { extractLegacyRunSources, normalizeRunSources } from "./run-sources.mjs";

const SCHEDULE_PATTERN = /^every:(\d{1,4})([mhd])$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "complete", "completed"]);
// 闲时语义（v4.x 接电）：空闲 = 控制面无活跃 run 且最近一条 run 活动已超过静默窗。
// 每 tick 至多放量一条闲时任务（最久未跑者先跑），单条冷却 idleCooldownMs——
// 空闲无法证实（orchestrator 无 list）时 fail-closed 不跑，绝不把"不知道"当成"空闲"。
const IDLE_QUIET_DEFAULT_MS = 10 * 60_000;
const IDLE_COOLDOWN_DEFAULT_MS = 4 * 3_600_000;
// v4.0 codeg 对标：run 历史修剪阈值（30 天）——超期条目自动裁剪，防止 automations.json 无限膨胀
const RUN_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const RUN_HISTORY_HARD_CAP = 100; // 即使未超期也不超过 100 条
const MAX_REQUESTED_AGENTS = 4;

function normalizeRequestedAgentIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw Object.assign(new Error("automation requestedAgentIds must be an array"), { code: "VALIDATION_FAILED" });
  }
  const ids = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  if (ids.length > MAX_REQUESTED_AGENTS) {
    throw Object.assign(new Error(`automation requestedAgentIds supports at most ${MAX_REQUESTED_AGENTS} targets`), { code: "VALIDATION_FAILED" });
  }
  return ids;
}

// 内置体检自动化（v3.7 拓展：Automation×社会编排——体系健康的常驻脉搏）。
// 默认 manual：定时与否是 LO 的钱包决策，播种不擅自定时；改 every:1d 即每日体检。
export const PULSE_CHECK_PROMPT = `对 514cc 体系做一次健康体检。以下是控制面实时聚合的体检数据（无需再用工具抓取，直接基于数据判断）：

{{PULSE}}

判断要点：
- routeGate.redUnsummoned > 0 ＝ 有 RED 信号未召唤（宪法铁律1 违反，最高优先级异常）
- routeGate.redUnsummoned === null ＝ 当前没有足够证据判定未召唤数；必须结合 routeGate.summoned.unknown 报告「待对账/未知」，严禁把 null 当作 0 或健康
- routeGate.summoned.unknown > 0 ＝ 对应路由记录尚未完成召唤对账，不等于已召唤，也不等于已确认未召唤
- delta.recent 长期无新条目 ＝ 发火/复盘停摆
- runtime.failedLast24h / recoveryRequired / waitingAnswer 积压 ＝ 执行面故障或等人
- runtime.unhealthyComponents 非空 ＝ 组件不可用（dormant/disabled 是正常态，不算异常）
- runtime.automations 有 lastError ＝ 调度故障

输出：一段话体检结论（正常/异常 + 依据数字）。
[[msg:lo]] 使用铁律（违反即体检失败）：
- 整个体检**至多用一次** [[msg:lo]]，且仅当异常需要 LO 拍板时；一切正常直接收敛，不写 [[msg:lo]]。
- 对话快照里已有你发过的 ask 或 LO 的 answer ＝ 你已经问过了——**绝不再次 [[msg:lo]]**，无论 LO 回答了什么，直接输出最终结论收敛（体检数据是触发时的快照，重复提问不会产生新数据）。
- 结论、总结、确认收到都不是提问，不许用 [[msg:lo]] 包装。`;

export async function seedBuiltinAutomations(store) {
  store.assertWritable("seed built-in automations");
  const existing = store.list().find((item) => item.builtin === "pulse-check");
  if (!existing) {
    await store.create({
      name: "体系体检",
      prompt: PULSE_CHECK_PROMPT,
      schedule: "manual",
      builtin: "pulse-check",
      permissionMode: "plan",
    });
    return;
  }
  // 内置项 prompt 归体系管：随版本升级（LO 改过名称/计划/起始不动，只对齐 prompt 文本）
  if (existing.prompt !== PULSE_CHECK_PROMPT) {
    await store.update(existing.id, { prompt: PULSE_CHECK_PROMPT });
  }
}

export function scheduleIntervalMs(schedule) {
  if (schedule === "manual" || schedule === "idle") return null; // idle 不走间隔制，由空闲排水驱动
  const match = SCHEDULE_PATTERN.exec(String(schedule ?? ""));
  if (!match) return null;
  const amount = Number(match[1]);
  if (!amount) return null;
  return amount * UNIT_MS[match[2]];
}

// W3.4 定时派工：`at:HH:mm`（每日）| `at:HH:mm@<周几列表>`（1=周一…7=周日）。
// 与间隔制互斥；水位线语义 = lastRunAt 之前的槽位视为已消费，重启/漏跑不双发、
// 错过的槽位在下个 tick 至多补跑一次。本地时区语义（DST 侧漏由水位线兜底，不重复触发）。
const AT_SCHEDULE_PATTERN = /^at:(\d{2}):(\d{2})(?:@([1-7](?:,[1-7])*))?$/;

export function parseAtSchedule(schedule) {
  const match = AT_SCHEDULE_PATTERN.exec(String(schedule ?? "").trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute, dows: match[3] ? match[3].split(",").map(Number) : null };
}

function slotMsForDay(base, hour, minute, dayOffset) {
  const slot = new Date(base);
  slot.setHours(hour, minute, 0, 0);
  slot.setDate(slot.getDate() + dayOffset);
  return slot.getTime();
}

/** 最近的"待消费"触发槽位：watermark < slot <= now；漏跑多天合并取最新槽位；无则 null。 */
export function dueAtFireMs(schedule, watermarkMs, nowMs) {
  const parsed = parseAtSchedule(schedule);
  if (!parsed) return null;
  const watermark = Number.isFinite(watermarkMs) ? watermarkMs : 0;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  let latest = null;
  for (let dayOffset = -8; dayOffset <= 1; dayOffset += 1) {
    const slot = slotMsForDay(now, parsed.hour, parsed.minute, dayOffset);
    if (slot <= watermark || slot > now) continue;
    if (parsed.dows) {
      const dow = ((slot === 0 ? 7 : new Date(slot).getDay()) || 7); // 1=周一…7=周日
      if (!parsed.dows.includes(dow)) continue;
    }
    if (latest === null || slot > latest) latest = slot;
  }
  return latest;
}

/** 下一个将到来的触发槽位（UI 预览用）：slot > afterMs。 */
export function nextAtFireMs(schedule, afterMs = Date.now()) {
  const parsed = parseAtSchedule(schedule);
  if (!parsed) return null;
  const after = Number.isFinite(afterMs) ? afterMs : Date.now();
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const slot = slotMsForDay(after, parsed.hour, parsed.minute, dayOffset);
    if (slot <= after) continue;
    if (parsed.dows) {
      const dow = ((slot === 0 ? 7 : new Date(slot).getDay()) || 7);
      if (!parsed.dows.includes(dow)) continue;
    }
    return slot;
  }
  return null;
}

function validateInput(input = {}) {
  const name = String(input.name ?? "").trim().slice(0, 80);
  if (!name) throw Object.assign(new Error("automation name is required"), { code: "VALIDATION_FAILED" });
  const normalizedContent = extractLegacyRunSources(input.prompt, input.sources);
  const prompt = normalizedContent.prompt;
  if (!prompt) throw Object.assign(new Error("automation prompt is required"), { code: "VALIDATION_FAILED" });
  if (Buffer.byteLength(prompt, "utf8") > 64 * 1024) {
    throw Object.assign(new Error("automation prompt exceeds 64 KiB"), { code: "VALIDATION_FAILED" });
  }
  // 与 run 创建同门：自动化会被反复 headless 执行，密钥字面量入库=定时泄漏器
  if (findSecretCandidates(prompt).length) {
    throw Object.assign(new Error("automation prompt contains secret-like material"), { code: "SENSITIVE_PROMPT" });
  }
  const schedule = String(input.schedule ?? "manual").trim();
  if (!["manual", "idle"].includes(schedule) && !SCHEDULE_PATTERN.test(schedule) && !parseAtSchedule(schedule)) {
    throw Object.assign(new Error("schedule must be 'manual', 'idle', 'every:<n>m|h|d' or 'at:HH:mm[@1-7]'"), { code: "VALIDATION_FAILED" });
  }
  return { name, prompt, schedule, sources: normalizedContent.sources };
}

function validatePersistedStore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("automations.json must contain an object");
  }
  if (value.version !== undefined && value.version !== 1) {
    throw new TypeError(`unsupported automations.json version: ${value.version}`);
  }
  if (!Array.isArray(value.automations)) {
    throw new TypeError("automations.json automations must be an array");
  }
  const ids = new Set();
  for (const item of value.automations) {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string" || !item.id.trim()) {
      throw new TypeError("automations.json contains an invalid automation record");
    }
    if (ids.has(item.id)) throw new TypeError(`automations.json contains a duplicate id: ${item.id}`);
    ids.add(item.id);
    normalizeRequestedAgentIds(item.requestedAgentIds);
    normalizeRunSources(item.sources);
  }
}

function storeStatus({ state, source, path, code = null, message = null, causeCode = null }) {
  return {
    state,
    source,
    writable: state === "ready",
    failClosed: state === "degraded",
    path,
    code,
    message,
    causeCode,
  };
}

export class AutomationStore {
  constructor({ dataRoot, orchestrator, eventStore, tickMs = 60_000, pulseProvider = null, idleQuietMs = IDLE_QUIET_DEFAULT_MS, idleCooldownMs = IDLE_COOLDOWN_DEFAULT_MS }) {
    this.file = join(dataRoot, "automations.json");
    this.orchestrator = orchestrator;
    this.eventStore = eventStore;
    this.tickMs = tickMs;
    this.pulseProvider = pulseProvider; // 惰性体检数据源（{{PULSE}} 占位符替换）
    this.idleQuietMs = idleQuietMs;
    this.idleCooldownMs = idleCooldownMs;
    this.items = new Map(); // id → automation
    this.chain = Promise.resolve(); // 写盘串行
    this.triggering = new Set(); // 按 automation id 互斥，不阻塞其他自动化
    this.timer = null;
    this.ticking = false;
    this.tickPromise = null;
    this.storeStatus = storeStatus({ state: "initializing", source: "startup", path: this.file });
  }

  async init() {
    this.items.clear();
    let text;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.storeStatus = storeStatus({ state: "ready", source: "missing-default", path: this.file });
        return this;
      }
      await this.#markDegraded(
        "AUTOMATION_STORE_UNREADABLE",
        "automation store is unreadable; the original path is preserved and all writes are blocked",
        error?.code ?? null,
      );
      return this;
    }
    try {
      const parsed = JSON.parse(text);
      validatePersistedStore(parsed);
      for (const item of parsed.automations) {
        const normalizedContent = extractLegacyRunSources(item.prompt, item.sources);
        this.items.set(item.id, {
          ...item,
          prompt: normalizedContent.prompt,
          requestedAgentIds: normalizeRequestedAgentIds(item.requestedAgentIds),
          orchestrationMode: item.orchestrationMode === "social" ? "social" : "pipeline",
          sources: normalizedContent.sources,
        });
      }
      this.storeStatus = storeStatus({ state: "ready", source: "disk", path: this.file });
    } catch {
      await this.#markDegraded(
        "AUTOMATION_STORE_CORRUPT",
        "automation store is corrupt; the original file is preserved and all writes are blocked",
      );
    }
    return this;
  }

  status() {
    return {
      ...this.storeStatus,
      schedulerActive: Boolean(this.timer),
      idle: { quietMs: this.idleQuietMs, cooldownMs: this.idleCooldownMs },
    };
  }

  assertWritable(operation = "modify automations") {
    if (this.storeStatus.writable) return;
    throw Object.assign(new Error(`${this.storeStatus.message || "automation store is unavailable"} (${operation})`), {
      code: this.storeStatus.code || "AUTOMATION_STORE_DEGRADED",
      automationStatus: this.status(),
    });
  }

  async #markDegraded(code, message, causeCode = null) {
    this.storeStatus = storeStatus({
      state: "degraded",
      source: "disk",
      path: this.file,
      code,
      message,
      causeCode,
    });
    await this.#emit("automation.store_degraded", {
      code,
      message,
      causeCode,
      path: this.file,
    });
  }

  #commit(operation, mutate) {
    const task = this.chain.then(async () => {
      this.assertWritable(operation);
      const before = structuredClone([...this.items.entries()]);
      const result = await mutate();
      try {
        await this.#writeSnapshot();
        return result;
      } catch (error) {
        this.items = new Map(before);
        await this.#markDegraded(
          "AUTOMATION_STORE_WRITE_FAILED",
          "automation store write failed; the in-memory mutation was rolled back and all further writes are blocked",
          error?.code ?? null,
        );
        throw Object.assign(new Error(`automation store write failed (${operation}): ${error?.message ?? error}`), {
          code: "AUTOMATION_STORE_WRITE_FAILED",
          cause: error,
          automationStatus: this.status(),
        });
      }
    });
    // 后续操作仍从已收敛的队尾开始；调用方拿原 task，不能把本次失败静默吞掉。
    this.chain = task.catch(() => {});
    return task;
  }

  async #writeSnapshot() {
    await mkdir(dirname(this.file), { recursive: true });
    const payload = { version: 1, automations: this.list(), updatedAt: new Date().toISOString() };
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temp, this.file);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }

  list() {
    return [...this.items.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  get(id) {
    const item = this.items.get(id);
    if (!item) throw Object.assign(new Error("automation not found"), { code: "AUTOMATION_NOT_FOUND" });
    return item;
  }

  async create(input = {}) {
    const { name, prompt, schedule, sources } = validateInput(input);
    const automation = {
      id: randomUUID(),
      name,
      prompt,
      schedule,
      builtin: typeof input.builtin === "string" ? input.builtin : null, // 内置项标记（播种幂等判据）
      enabled: input.enabled !== false,
      // composer 快照（缺省与 createRun 对齐；orchestrator.create 会做各自的目录/白名单校验）
      teamId: input.teamId ?? "team-514cc",
      startAgentId: input.startAgentId ?? null,
      requestedAgentIds: normalizeRequestedAgentIds(input.requestedAgentIds),
      orchestrationMode: input.orchestrationMode === "social" ? "social" : "pipeline",
      permissionMode: ["build", "review"].includes(input.permissionMode) ? input.permissionMode : "plan",
      model: input.model || null,
      effort: input.effort || null,
      cwd: input.cwd || null,
      sources,
      maxRounds: Number(input.maxRounds) || undefined,
      // 定时基线 = 创建时刻：首跑发生在第一个周期之后（创建即跑=最小惊讶反例，实测踩到——
      // every:1d 刚保存就立即执行）。想立即跑用「立即执行」按钮
      lastRunAt: new Date().toISOString(),
      lastRunId: null,
      lastError: null,
      runHistory: [], // 最近触发记录（id/at/source/status 快照），供管理 UI 回看
      createdAt: new Date().toISOString(),
    };
    await this.#commit("create automation", () => {
      this.items.set(automation.id, automation);
      return automation;
    });
    await this.#emit("automation.created", { id: automation.id, name, schedule });
    return automation;
  }

  async update(id, patch = {}) {
    const item = await this.#commit("update automation", () => {
      const current = this.get(id);
      if (patch.name !== undefined || patch.prompt !== undefined || patch.schedule !== undefined || patch.sources !== undefined) {
        const merged = validateInput({
          name: patch.name ?? current.name,
          prompt: patch.prompt ?? current.prompt,
          schedule: patch.schedule ?? current.schedule,
          sources: patch.sources ?? current.sources,
        });
        Object.assign(current, merged);
      }
      if (patch.enabled !== undefined) current.enabled = Boolean(patch.enabled);
      for (const field of ["teamId", "startAgentId", "model", "effort", "cwd"]) {
        if (patch[field] !== undefined) current[field] = patch[field] || null;
      }
      if (patch.requestedAgentIds !== undefined) {
        current.requestedAgentIds = normalizeRequestedAgentIds(patch.requestedAgentIds);
      }
      if (patch.orchestrationMode !== undefined) {
        current.orchestrationMode = patch.orchestrationMode === "social" ? "social" : "pipeline";
      }
      if (patch.permissionMode !== undefined) {
        const mode = String(patch.permissionMode ?? "plan").toLowerCase();
        current.permissionMode = ["build", "review"].includes(mode) ? mode : "plan";
      }
      return current;
    });
    await this.#emit("automation.updated", { id, enabled: item.enabled, schedule: item.schedule });
    return item;
  }

  async remove(id) {
    await this.#commit("remove automation", () => {
      this.get(id); // 不存在即抛
      this.items.delete(id);
      return { removed: id };
    });
    await this.#emit("automation.removed", { id });
    return { removed: id };
  }

  /** 立即执行（手动触发或调度器 tick）：产生真实 run，走 orchestrator 全部准入与治理链。 */
  async trigger(id, { source = "manual" } = {}) {
    this.assertWritable("trigger automation");
    const item = this.get(id);
    if (this.triggering.has(id)) {
      throw Object.assign(new Error(`automation trigger is already in progress (${id})`), { code: "AUTOMATION_BUSY" });
    }
    this.triggering.add(id);
    try {
      return await this.#triggerLocked(item, source);
    } finally {
      this.triggering.delete(id);
    }
  }

  async #triggerLocked(initialItem, source) {
    const id = initialItem.id;
    let item = this.get(id);
    // 并发防护：上一 run 未终态不重复触发（定时任务叠跑=预算与写盘双灾难）
    if (item.lastRunId) {
      try {
        const previous = this.orchestrator.get(item.lastRunId);
        if (!TERMINAL.has(previous.status)) {
          throw Object.assign(new Error(`automation is still running (${item.lastRunId})`), { code: "AUTOMATION_BUSY" });
        }
      } catch (error) {
        if (error.code === "AUTOMATION_BUSY") throw error;
        // RUN_NOT_FOUND（已清除）= 可以触发
      }
    }
    // {{PULSE}} 占位符：控制面聚合的体检数据注入 prompt——agent 直接判断，不用工具轮抓取。
    // 数据源失败如实注入"不可用"说明（严禁静默伪造成正常）
    let prompt = item.prompt;
    if (prompt.includes("{{PULSE}}")) {
      let pulseText = "（体检数据源暂不可用——如实说明此情况，不要臆造健康状态）";
      try {
        const pulse = await this.pulseProvider?.();
        if (pulse) pulseText = JSON.stringify(pulse, null, 1);
      } catch {
        // 保持不可用文案
      }
      prompt = prompt.replaceAll("{{PULSE}}", pulseText);
    }
    let pending = item.pendingTrigger;
    if (!pending?.id) {
      pending = { id: randomUUID(), source, startedAt: new Date().toISOString(), lastError: null };
      await this.#commit("prepare automation trigger", () => {
        const current = this.get(id);
        current.pendingTrigger = pending;
        current.lastRunAt = pending.startedAt;
        current.lastError = null;
        return current;
      });
    }
    item = this.get(id);
    const idempotencyKey = `automation:${id}:${pending.id}`;
    let run;
    try {
      const requestedAgentIds = item.requestedAgentIds?.length ? [...item.requestedAgentIds] : undefined;
      run = await this.orchestrator.create({
        prompt,
        execute: true,
        permissionMode: item.permissionMode,
        teamId: item.teamId,
        startAgentId: item.startAgentId || undefined,
        requestedAgentIds,
        orchestrationMode: item.orchestrationMode === "social" || requestedAgentIds ? "social" : "pipeline",
        model: item.model || undefined,
        effort: item.effort || undefined,
        cwd: item.cwd || undefined,
        sources: item.sources?.length ? structuredClone(item.sources) : undefined,
        maxRounds: item.maxRounds,
        collaborationMode: "deep",
        idempotencyKey,
      });
    } catch (error) {
      // create() 可能已持久化 run 后才报错。保留 pendingTrigger 与同一个幂等键，
      // 下一次恢复只会复用原 run，不会重复计费或重复派发。
      await this.#commit("record automation trigger failure", () => {
        const current = this.get(id);
        if (current.pendingTrigger?.id === pending.id) current.pendingTrigger.lastError = String(error?.message ?? error).slice(0, 300);
        current.lastRunAt = new Date().toISOString();
        current.lastError = String(error?.message ?? error).slice(0, 300);
        return current;
      });
      throw error;
    }
    await this.#commit("complete automation trigger", () => {
      const current = this.get(id);
      if (current.pendingTrigger?.id !== pending.id) {
        throw Object.assign(new Error("automation trigger journal changed before completion"), { code: "AUTOMATION_RECOVERY_REQUIRED" });
      }
      const at = new Date().toISOString();
      current.lastRunAt = at;
      current.lastRunId = run.id;
      current.lastError = null;
      const history = Array.isArray(current.runHistory) ? current.runHistory : [];
      history.unshift({
        runId: run.id,
        at,
        source,
        status: String(run.status ?? "queued"),
      });
      current.runHistory = history.slice(0, 24); // 最近 24 次触发，管理 UI 可回看
      delete current.pendingTrigger;
      return current;
    });
    await this.#emit("automation.triggered", { id, runId: run.id, source, name: item.name });
    return run;
  }

  /** 取消自动化当前未终态 run（IN-02B）：走 orchestrator.cancel，不静默吞失败。 */
  async cancel(id) {
    this.assertWritable("cancel automation");
    const item = this.get(id);
    if (!item.lastRunId) {
      throw Object.assign(new Error("automation has no active run to cancel"), { code: "AUTOMATION_NOT_RUNNING" });
    }
    let previous;
    try {
      previous = this.orchestrator.get(item.lastRunId);
    } catch (error) {
      throw Object.assign(new Error("automation last run is no longer available"), {
        code: "AUTOMATION_NOT_RUNNING",
        cause: error,
      });
    }
    if (TERMINAL.has(previous.status)) {
      throw Object.assign(new Error(`automation last run already terminal (${previous.status})`), { code: "AUTOMATION_NOT_RUNNING" });
    }
    const cancelled = await this.orchestrator.cancel(item.lastRunId);
    await this.#commit("record automation cancel", () => {
      const current = this.get(id);
      const history = Array.isArray(current.runHistory) ? current.runHistory : [];
      const entry = history.find((row) => row.runId === item.lastRunId);
      if (entry) entry.status = String(cancelled?.status ?? "cancelled");
      current.lastError = null;
      return current;
    });
    await this.#emit("automation.cancelled", { id, runId: item.lastRunId, name: item.name });
    return cancelled;
  }

  start() {
    if (!this.storeStatus.writable) return false;
    if (this.timer) return true;
    this.timer = setInterval(() => {
      if (this.tickPromise) return;
      // tick 内部的单条触发失败已各自落账（automation.trigger_failed 等），这里兜的是
      // 失败处理路径自身再炸（如 #commit 磁盘错误）冒泡为 unhandled rejection：
      // 落 automation.tick_failed 事件 + stderr，吞掉二次异常，下一次 tick 照常。
      this.tickPromise = this.#tick()
        .catch((error) => {
          console.error("[automations] scheduler tick crashed:", error?.stack || error);
          return this.#emit("automation.tick_failed", { message: String(error?.message ?? error).slice(0, 200) }).catch(() => {});
        })
        .finally(() => { this.tickPromise = null; });
    }, this.tickMs);
    this.timer.unref?.(); // 调度器不该拖住进程退出
    return true;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.tickPromise?.catch(() => {});
    await this.chain.catch(() => {});
  }

  /**
   * 控制面是否空闲（闲时排水门）：无活跃 run 且最近一条 run 活动已超静默窗。
   * orchestrator 不支持列举 = 无法证实空闲，fail-closed 返回 false。
   */
  #controlPlaneIdle(now) {
    if (typeof this.orchestrator.list !== "function") return false;
    let lastActivityMs = 0;
    for (const run of this.orchestrator.list()) {
      if (!TERMINAL.has(run.status)) return false;
      const ms = Date.parse(run.updatedAt ?? run.createdAt ?? "") || 0;
      if (ms > lastActivityMs) lastActivityMs = ms;
    }
    return now - lastActivityMs >= this.idleQuietMs;
  }

  async #tick() {
    if (this.ticking) return; // tick 自身不重入
    this.ticking = true;
    try {
      const now = Date.now();
      // v4.0 codeg 对标：reconcile backstop + run 历史修剪
      // Reconcile backstop：检查上次触发的 run 是否意外卡在非终态（TurnComplete 丢失恢复）
      for (const item of this.items.values()) {
        if (!item.enabled) continue;
        if (!item.lastRunId) continue;
        try {
          const run = this.orchestrator.get(item.lastRunId);
          // 如果 run 卡在非终态超过 30 分钟且无活跃 turnAttempts，标记为可能丢失
          if (!TERMINAL.has(run.status)) {
            const attempts = run.turnAttempts || [];
            const hasActiveAttempt = attempts.some((a) => ["submitting", "submitted"].includes(a.phase));
            const runAge = now - new Date(run.createdAt || 0).getTime();
            if (!hasActiveAttempt && runAge > 30 * 60_000) {
              // 可能是 TurnComplete 事件丢失——记录但不自动取消（让 LO 决定）
              if (!item.reconcileNote) {
                await this.#commit("reconcile backstop note", () => {
                  const current = this.get(item.id);
                  current.reconcileNote = `Run ${item.lastRunId} 可能卡在非终态（${run.status}），无活跃 attempt 超过 30 分钟`;
                  return current;
                });
                await this.#emit("automation.reconcile_backstop", {
                  id: item.id,
                  runId: item.lastRunId,
                  status: run.status,
                  age: runAge,
                });
              }
            }
          }
        } catch (error) {
          if (error.code !== "RUN_NOT_FOUND") {
            // RUN_NOT_FOUND = 已清除，正常；其他错误记录
            await this.#emit("automation.reconcile_error", { id: item.id, message: String(error?.message ?? error).slice(0, 200) });
          }
        }
      }

      // v4.0 codeg 对标：run 历史修剪（30 天 + 硬上限 100 条）
      for (const item of this.items.values()) {
        if (!Array.isArray(item.runHistory) || item.runHistory.length === 0) continue;
        const cutoff = now - RUN_HISTORY_MAX_AGE_MS;
        const pruned = item.runHistory.filter((entry) => {
          const ms = new Date(entry.at || 0).getTime();
          return ms > cutoff;
        }).slice(0, RUN_HISTORY_HARD_CAP);
        if (pruned.length !== item.runHistory.length) {
          await this.#commit("prune run history", () => {
            const current = this.get(item.id);
            current.runHistory = pruned;
            return current;
          });
        }
      }

      // W3.4 定时派工触发（at: 指定时刻）：水位线 = lastRunAt，到期槽位触发；
      // 与间隔制同一失败账（BUSY 跳过 / 其余落账 + 事件 + 前移 lastRunAt 防重试风暴）
      for (const item of this.items.values()) {
        if (!item.enabled) continue;
        const dueSlot = dueAtFireMs(item.schedule, Date.parse(item.lastRunAt ?? "") || 0, now);
        if (dueSlot == null) continue;
        try {
          await this.trigger(item.id, { source: "schedule" });
        } catch (error) {
          if (error.code === "AUTOMATION_BUSY") continue;
          const message = String(error.message ?? error).slice(0, 300);
          if (this.storeStatus.writable) {
            await this.#commit("record at-schedule automation failure", () => {
              const current = this.get(item.id);
              current.lastRunAt = new Date().toISOString();
              current.lastError = message;
              return current;
            });
          }
          await this.#emit("automation.trigger_failed", { id: item.id, name: item.name, message });
        }
      }

      // 常规调度触发
      for (const item of this.items.values()) {
        if (!item.enabled) continue;
        const interval = scheduleIntervalMs(item.schedule);
        if (!interval) continue;
        const lastMs = Date.parse(item.lastRunAt ?? "") || 0;
        if (now - lastMs < interval) continue;
        try {
          await this.trigger(item.id, { source: "schedule" });
        } catch (error) {
          if (error.code === "AUTOMATION_BUSY") continue; // 上一趟还在跑，下个 tick 再看
          // 触发失败落账不崩调度：lastError 可见 + 事件留痕；lastRunAt 前移防止每 tick 重试风暴
          const message = String(error.message ?? error).slice(0, 300);
          if (this.storeStatus.writable) {
            await this.#commit("record scheduled automation failure", () => {
              const current = this.get(item.id);
              current.lastRunAt = new Date().toISOString();
              current.lastError = message;
              return current;
            });
          }
          await this.#emit("automation.trigger_failed", { id: item.id, name: item.name, message });
        }
      }

      // 闲时排水：控制面空闲时，每 tick 至多放量一条闲时任务（最久未跑先跑，冷却未到不跑）。
      // 与间隔制同一失败账：AUTOMATION_BUSY 跳过，其余失败落 lastError + 事件 + 前移 lastRunAt 防重试风暴。
      if (this.#controlPlaneIdle(now)) {
        const next = [...this.items.values()]
          .filter((item) => item.enabled && item.schedule === "idle")
          .filter((item) => now - (Date.parse(item.lastRunAt ?? "") || 0) >= this.idleCooldownMs)
          .sort((a, b) => String(a.lastRunAt ?? "").localeCompare(String(b.lastRunAt ?? "")))[0];
        if (next) {
          try {
            await this.trigger(next.id, { source: "idle" });
          } catch (error) {
            if (error.code !== "AUTOMATION_BUSY") {
              const message = String(error.message ?? error).slice(0, 300);
              if (this.storeStatus.writable) {
                await this.#commit("record idle automation failure", () => {
                  const current = this.get(next.id);
                  current.lastRunAt = new Date().toISOString();
                  current.lastError = message;
                  return current;
                });
              }
              await this.#emit("automation.trigger_failed", { id: next.id, name: next.name, message });
            }
          }
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  async #emit(type, data) {
    try {
      await this.eventStore?.emit(type, data, { agentId: "control-plane", sensitivity: "internal" });
    } catch {
      // 事件面不可用不得改变存储健康判定；调用方仍从 status()/操作错误拿到真实状态。
    }
  }
}
