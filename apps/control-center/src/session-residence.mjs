/**
 * session-residence.mjs — 514cc 会话驻留与关机恢复引擎 (A5 / 桌面助手特色)。
 *
 * 桌面助手与云端常驻服务不同，本机会经历休眠、关机、控制中心重启与异常退出：
 *   1. 会话常驻状态 (Session Residence)：记住当前前台活跃会话与心跳时间；
 *   2. 关机恢复 (Shutdown & Crash Recovery)：服务端启动时比对最后心跳与干净关机标记；
 *      若检测到异常中断的 Run 或处于进行中/中断的 A4 检查点，生成结构化恢复提示 (recoveryHints)；
 *   3. 提示交互：支持前端一键关闭 (dismiss) 或断点恢复 (resume)。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renameWithRetry } from "./atomic-rename.mjs";

export const SESSION_RESIDENCE_SCHEMA = "514cc.session-residence/v1";
export const SESSION_RESIDENCE_FILE = "session-residence.json";

export const RESIDENCE_MODES = Object.freeze(["resident", "idle", "detached"]);

function cleanId(value, label = "id") {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(s)) return null;
  return s;
}

export class SessionResidenceStore {
  #queue = Promise.resolve();
  #closed = false;

  constructor({ dataRoot }) {
    if (!dataRoot) throw new Error("dataRoot is required");
    this.dataRoot = dataRoot;
    this.path = join(dataRoot, SESSION_RESIDENCE_FILE);
    this.state = {
      schema: SESSION_RESIDENCE_SCHEMA,
      activeConversationId: null,
      residenceMode: "detached",
      lastHeartbeat: null,
      lastCleanShutdown: null,
      recoveryHints: [],
      updatedAt: new Date().toISOString(),
    };
  }

  #serialize(operation) {
    const next = this.#queue.then(operation, operation);
    this.#queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async init({ runs = null, conversations = null, checkpointStore = null } = {}) {
    await mkdir(this.dataRoot, { recursive: true });
    let isNew = false;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.schema === SESSION_RESIDENCE_SCHEMA) {
        this.state = {
          schema: SESSION_RESIDENCE_SCHEMA,
          activeConversationId: cleanId(parsed.activeConversationId),
          residenceMode: RESIDENCE_MODES.includes(parsed.residenceMode) ? parsed.residenceMode : "detached",
          lastHeartbeat: parsed.lastHeartbeat || null,
          lastCleanShutdown: parsed.lastCleanShutdown || null,
          recoveryHints: Array.isArray(parsed.recoveryHints) ? parsed.recoveryHints : [],
          updatedAt: parsed.updatedAt || new Date().toISOString(),
        };
      }
    } catch (err) {
      if (err?.code === "ENOENT") {
        isNew = true;
      } else {
        throw err;
      }
    }

    // 执行异常中断与恢复提示检测
    if (!isNew && this.state.lastHeartbeat) {
      const heartbeatMs = Date.parse(this.state.lastHeartbeat);
      const cleanShutdownMs = this.state.lastCleanShutdown ? Date.parse(this.state.lastCleanShutdown) : 0;

      // 若最后心跳明显晚于最后一次干净关机（或者从未干净关机），说明是非预期中断或崩溃
      const isUncleanExit = !cleanShutdownMs || heartbeatMs > cleanShutdownMs + 1000;
      if (isUncleanExit) {
        await this.#detectInterruptedTasks({ runs, conversations, checkpointStore });
      }
    }

    await this.#persist();
  }

  async #persist() {
    this.state.updatedAt = new Date().toISOString();
    const body = JSON.stringify(this.state, null, 2);
    const tempPath = `${this.path}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(tempPath, body, "utf8");
    await renameWithRetry(tempPath, this.path);
  }

  async #detectInterruptedTasks({ runs = null, conversations = null, checkpointStore = null } = {}) {
    const existingHintRunIds = new Set(
      this.state.recoveryHints
        .filter((h) => h.status === "pending" && h.runId)
        .map((h) => h.runId)
    );

    // 1. 扫描未完成的 Runs
    if (runs && typeof runs.entries === "function") {
      for (const [id, run] of runs.entries()) {
        if (!run) continue;
        const status = String(run.status || "").toLowerCase();
        if (status === "running" || status === "in_progress") {
          if (!existingHintRunIds.has(id)) {
            this.state.recoveryHints.push({
              id: `hint-${randomUUID()}`,
              type: "interrupted_run",
              title: "检测到未完成的任务",
              description: `任务 "${run.title || run.prompt?.slice(0, 40) || id}" 在系统退出时处于执行中状态`,
              conversationId: run.conversationId || null,
              runId: id,
              interruptedPhase: null,
              status: "pending",
              createdAt: new Date().toISOString(),
              actions: ["resume", "dismiss"],
            });
            existingHintRunIds.add(id);
          }
        }
      }
    }

    // 2. 扫描检查点存储中的未闭环检查点
    if (checkpointStore && typeof checkpointStore.list === "function") {
      try {
        const allCheckpoints = await checkpointStore.list();
        for (const cp of allCheckpoints) {
          if (cp.status === "in_progress" || cp.status === "interrupted") {
            const runId = cp.runId;
            if (runId && !existingHintRunIds.has(runId)) {
              this.state.recoveryHints.push({
                id: `hint-${randomUUID()}`,
                type: "unsettled_checkpoint",
                title: "研究检查点中断提示",
                description: `研究阶段 [${cp.label || cp.phase}] 未完成验收即发生关机或系统退出`,
                conversationId: cp.conversationId || null,
                runId: cp.runId || null,
                interruptedPhase: cp.phase,
                status: "pending",
                createdAt: new Date().toISOString(),
                actions: ["resume", "dismiss"],
              });
              existingHintRunIds.add(runId);
            }
          }
        }
      } catch {
        // checkpoint 扫描失败时不阻断整体启动
      }
    }
  }

  async recordHeartbeat({ conversationId = null, residenceMode = "resident" } = {}) {
    return this.#serialize(async () => {
      if (this.#closed) return;
      this.state.activeConversationId = cleanId(conversationId) || this.state.activeConversationId;
      if (RESIDENCE_MODES.includes(residenceMode)) {
        this.state.residenceMode = residenceMode;
      }
      this.state.lastHeartbeat = new Date().toISOString();
      await this.#persist();
      return this.getResidenceState();
    });
  }

  async recordCleanShutdown() {
    return this.#serialize(async () => {
      this.state.lastCleanShutdown = new Date().toISOString();
      this.state.residenceMode = "detached";
      await this.#persist();
    });
  }

  getResidenceState() {
    return {
      schema: this.state.schema,
      activeConversationId: this.state.activeConversationId,
      residenceMode: this.state.residenceMode,
      lastHeartbeat: this.state.lastHeartbeat,
      lastCleanShutdown: this.state.lastCleanShutdown,
      recoveryHints: this.state.recoveryHints.filter((h) => h.status === "pending"),
      updatedAt: this.state.updatedAt,
    };
  }

  async dismissRecoveryHint(hintId) {
    return this.#serialize(async () => {
      const hint = this.state.recoveryHints.find((h) => h.id === hintId);
      if (!hint) {
        throw Object.assign(new Error(`recovery hint not found: ${hintId}`), {
          code: "HINT_NOT_FOUND",
          httpStatus: 404,
        });
      }
      hint.status = "dismissed";
      hint.updatedAt = new Date().toISOString();
      await this.#persist();
      return { success: true, hintId };
    });
  }

  /**
   * 认领一条恢复提示，并把用户带回它所属的会话。
   *
   * 命名纠偏（2026-09-18）：本方法此前叫 `resumeRunHint`，HTTP 路由叫
   * `resume-run`，handoff 里写作「断点恢复」——但它**不恢复任何执行**：
   * 只把提示置为已认领 + 把 activeConversationId 切回原会话，剩下的由用户
   * 在前端自己决定要不要重发。
   *
   * 不自动续跑是**有意为之**：崩溃点的 run 已经进入终态或提交态不明，
   * 按 D-2026-08-18 的回放纪律（submitting/ambiguous 禁止自动重放），
   * 自动重发等于替用户决定"再花一次钱、再改一次工作区"。保留行为、改掉名字。
   *
   * 路由名 `POST /api/assistant/residence/resume-run` 暂留兼容，语义以本注释为准。
   */
  async claimRecoveryHint(hintId) {
    return this.#serialize(async () => {
      const hint = this.state.recoveryHints.find((h) => h.id === hintId);
      if (!hint) {
        throw Object.assign(new Error(`recovery hint not found: ${hintId}`), {
          code: "HINT_NOT_FOUND",
          httpStatus: 404,
        });
      }
      hint.status = "resumed";
      hint.updatedAt = new Date().toISOString();
      if (hint.conversationId) {
        this.state.activeConversationId = hint.conversationId;
        this.state.residenceMode = "resident";
      }
      await this.#persist();
      return { success: true, hint, runResumed: false };
    });
  }

  close() {
    this.#closed = true;
  }
}
