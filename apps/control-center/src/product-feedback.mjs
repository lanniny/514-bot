/**
 * P-24 产品反馈闭环（v48 S0-5）。
 *
 * 与 P-21 埋点的**语义分界**（重要，勿混为一谈）：
 *   - 埋点是**被动采集**用户行为 → 零自由文本，字段白名单，聚合才有价值。
 *   - 反馈是**用户主动写下**的问题 → 必须允许自由文本，否则说不清问题在哪。
 *   两者存储分离：埋点走 append-only 哈希链（不可改），反馈需要标记处理状态（可改），
 *   强行合并会让其中一个的语义被另一个绑架。
 *
 * 隐私：自由文本虽是用户主动提供，仍过 sanitizeForPersistence —— 用户可能在描述
 * 问题时误贴 token 或路径。用户的信任不该由用户自己的手滑来兑现。
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { sanitizeForPersistence } from "./redaction.mjs";

export const FEEDBACK_SCHEMA = "514cc.product-feedback/v1";
/** 受控问题分类。自由文本描述细节，分类保证可统计。 */
export const FEEDBACK_KINDS = Object.freeze(["confusing", "broken", "slow", "missing", "other"]);
export const FEEDBACK_STATUSES = Object.freeze(["open", "triaged", "done", "wontfix"]);

const MAX_NOTE_LENGTH = 2000;
const MAX_ENTRIES = 500;
/** 未处理完的状态——裁剪时必须保住。triaged = 已分诊但没做完，删它等于丢掉已投入的工作。 */
const UNRESOLVED_STATUSES = Object.freeze(["open", "triaged"]);

function slug(value, max = 48) {
  return String(value ?? "").replace(/[^A-Za-z0-9._:-]/g, "").slice(0, max) || null;
}

export class ProductFeedbackStore {
  constructor({ path } = {}) {
    if (!path) throw new Error("ProductFeedbackStore requires a path");
    this.path = path;
    this.entries = [];
    this.loaded = false;
    this.corrupted = null;
    // 烛 R2 F-1/F-3 修复：所有写入串行化。此前 submit 与 setStatus 各自改完内存
    // 数组就异步覆写同一文件，并发时后完成者会用自己的旧快照盖掉先完成者的结果。
    this.writeChain = Promise.resolve();
  }

  async init() {
    if (this.loaded) return this;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw);
      this.entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    } catch (error) {
      // 烛 R2 F-4 修复：必须区分"文件不存在"与"文件损坏"。
      // 此前两者都静默降级为空数组，而下一次 submit 会把空数组覆写回去——
      // 用户的历史反馈就此永久消失。损坏文件必须先侧移保留再降级。
      if (error?.code !== "ENOENT") {
        const backup = `${this.path}.corrupt-${Date.now()}`;
        try {
          await rename(this.path, backup);
          this.corrupted = { backup, reason: String(error?.message ?? error) };
        } catch (backupError) {
          // 连备份都做不到：宁可让 init 抛错，也不能带着"下一次写入即销毁用户数据"的状态继续
          throw Object.assign(new Error("feedback store is corrupt and could not be backed up"), {
            code: "FEEDBACK_STORE_CORRUPT",
            cause: backupError,
          });
        }
      }
      this.entries = [];
    }
    this.loaded = true;
    return this;
  }

  /**
   * 串行化的原子写。两个关键点：
   *   1. payload 必须在链内生成——否则串行了仍然写的是进入时的旧快照
   *   2. 临时文件名带 UUID——固定 `.tmp` 在并发下会互相踩
   */
  #persist() {
    const run = this.writeChain.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const payload = `${JSON.stringify({ schema: FEEDBACK_SCHEMA, entries: this.entries }, null, 2)}\n`;
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, payload, "utf8");
      await rename(temporary, this.path);
    });
    this.writeChain = run;
    return run;
  }

  /**
   * 提交一条反馈。
   * @param {object} input
   * @param {string} input.kind  FEEDBACK_KINDS 之一，非法值归为 "other" 而非拒收——
   *                             不能因为分类没选对就丢掉用户的声音。
   * @param {string} [input.note] 自由文本，过脱敏并截断
   * @param {string} [input.view] 视图 id
   */
  async submit(input = {}) {
    if (!this.loaded) await this.init();
    const kind = FEEDBACK_KINDS.includes(String(input.kind)) ? String(input.kind) : "other";
    const rawNote = String(input.note ?? "").trim().slice(0, MAX_NOTE_LENGTH);
    const entry = sanitizeForPersistence({
      id: randomUUID(),
      schema: FEEDBACK_SCHEMA,
      createdAt: new Date().toISOString(),
      kind,
      note: rawNote,
      view: slug(input.view),
      status: "open",
    });
    this.entries.unshift(entry);
    // 烛 R2 F-2 修复：有界裁剪必须保住**所有未处理完**的反馈，不只是 open。
    // 此前 triaged（已分诊但没做完）会在满 500 时被删——那等于丢掉已投入的分诊工作。
    // 只有真正结案的（done / wontfix）才是可回收的空间。
    if (this.entries.length > MAX_ENTRIES) {
      const unresolved = this.entries.filter((item) => UNRESOLVED_STATUSES.includes(item.status));
      const resolved = this.entries.filter((item) => !UNRESOLVED_STATUSES.includes(item.status));
      // 未处理的全留（即便超上限——丢用户没被回应的声音比超配额更糟）；
      // 剩余空间按新到旧给已结案的。
      const room = Math.max(0, MAX_ENTRIES - unresolved.length);
      this.entries = [...unresolved, ...resolved.slice(0, room)];
    }
    await this.#persist();
    return entry;
  }

  /** 标记处理状态。反馈必须能被"处理掉"，否则它只是个收集箱不是闭环。 */
  async setStatus(id, status) {
    if (!this.loaded) await this.init();
    if (!FEEDBACK_STATUSES.includes(String(status))) {
      throw Object.assign(new Error(`unsupported feedback status: ${status}`), { code: "VALIDATION_FAILED" });
    }
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) throw Object.assign(new Error("feedback not found"), { code: "NOT_FOUND" });
    entry.status = String(status);
    entry.updatedAt = new Date().toISOString();
    await this.#persist();
    return entry;
  }

  async list({ status = null, limit = 100 } = {}) {
    if (!this.loaded) await this.init();
    const filtered = status ? this.entries.filter((item) => item.status === status) : this.entries;
    const byKind = {};
    const byStatus = {};
    for (const item of this.entries) {
      byKind[item.kind] = (byKind[item.kind] || 0) + 1;
      byStatus[item.status] = (byStatus[item.status] || 0) + 1;
    }
    return {
      schema: FEEDBACK_SCHEMA,
      total: this.entries.length,
      open: byStatus.open ?? 0,
      // 损坏降级不能只在后端悄悄发生——用户有权知道自己的历史反馈出过问题、备份在哪
      corrupted: this.corrupted,
      byKind,
      byStatus,
      entries: filtered.slice(0, Math.max(1, Math.min(500, limit))),
    };
  }
}
