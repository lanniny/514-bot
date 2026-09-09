import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, open, opendir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { renameWithRetry } from "../atomic-rename.mjs";
import { missingSkillDigest, readProofFile, skillDigest, skillTreeProof } from "./skill-recovery-proof.mjs";

const schema = "514cc.skill-publication/v2";
export const skillPublicationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const keyOf = (path) => process.platform === "win32" ? path.toLowerCase() : path;
const failure = (code) => Object.assign(new Error(code), { code, httpStatus: 503 });
async function info(path) {
  try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function physicalTarget(path) {
  let parent = dirname(resolve(path));
  const suffix = [basename(path)];
  for (;;) {
    try { return join(await realpath(parent), ...suffix); } catch (error) {
      if (error.code !== "ENOENT" || dirname(parent) === parent) throw error;
      suffix.unshift(basename(parent));
      parent = dirname(parent);
    }
  }
}
export { physicalTarget as resolveSkillTarget };
export async function writeSkillJournal(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
    await renameWithRetry(temp, path);
  } finally { await rm(temp, { force: true }).catch(() => {}); }
}

export async function hasPendingSkillPublication(root) {
  const result = await listSkillPublications(root);
  return result.items.length > 0 || result.unavailable;
}

export async function listSkillPublications(root) {
  let entries;
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return { items: [], unavailable: true };
    entries = await opendir(root);
  } catch (error) { if (error.code === "ENOENT") return { items: [], unavailable: false }; throw error; }
  const items = [];
  // Bound pending results, not the number of completed publications retained for audit.
  for await (const entry of entries) {
    if (items.length >= 100) break;
    if (!entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -5);
    if (!skillPublicationIdPattern.test(id)) { items.push({ id: null, reason: "SKILL_JOURNAL_INVALID" }); continue; }
    try {
      const { journal } = await readSkillJournal(root, id);
      if (["514cc.skill-publication/v1", schema].includes(journal.schema) && ["committed", "rolled-back"].includes(journal.phase)) continue;
      items.push({ id, reason: journal.schema === schema ? "SKILL_RECOVERY_CHECK_REQUIRED" : "SKILL_RECOVERY_LEGACY", phase: "pending" });
    } catch { items.push({ id, reason: "SKILL_JOURNAL_INVALID" }); }
  }
  return { items, unavailable: false };
}

export async function readSkillJournal(root, id) {
  if (!skillPublicationIdPattern.test(id)) throw failure("SKILL_JOURNAL_INVALID");
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw failure("SKILL_JOURNAL_INVALID");
  const bytes = await readProofFile(join(root, `${id}.json`), 2 * 1024 * 1024);
  const journal = JSON.parse(bytes.toString("utf8"));
  if (!journal || journal.id !== id) throw failure("SKILL_JOURNAL_INVALID");
  return { journal, digest: skillDigest(bytes) };
}

export class SkillPublication {
  constructor({ journalRoot, backupRoot, stateProof = null }) {
    this.id = randomUUID();
    this.journalRoot = journalRoot;
    this.path = join(journalRoot, `${this.id}.json`);
    this.backupRoot = join(backupRoot, this.id);
    this.records = [];
    this.stateProof = stateProof;
  }

  async save(phase) {
    await writeSkillJournal(this.path, { schema, id: this.id, phase, updatedAt: new Date().toISOString(), stateProof: this.stateProof, records: this.records });
  }

  async publish(changes, commit) {
    const targets = new Map();
    for (const change of changes) {
      const target = await physicalTarget(change.target);
      const key = keyOf(target);
      const previous = targets.get(key);
      if (previous) {
        if (previous.source !== change.source) throw failure("SKILL_TARGET_CONFLICT");
        continue;
      }
      for (const other of targets.keys()) if (key.startsWith(other + sep) || other.startsWith(key + sep)) throw failure("SKILL_TARGET_CONFLICT");
      targets.set(key, { ...change, target });
    }
    this.records = [...targets.values()].map(({ target, source }, index) => ({
      target, source, staged: join(dirname(target), `.${basename(target)}.${this.id}.stage`),
      previous: join(dirname(target), `.${basename(target)}.${this.id}.previous`),
      archive: join(this.backupRoot, String(index)), stageCreated: false, moved: false, published: false,
    }));
    await mkdir(this.journalRoot, { recursive: true, mode: 0o700 });
    if (await hasPendingSkillPublication(this.journalRoot)) throw failure("SKILL_TRANSACTION_RECOVERY_REQUIRED");
    await this.save("pending");
    let committed = false;
    try {
      // Prepare every copy before removing any currently active directory.
      for (const record of this.records) {
        record.beforeDigest = await skillTreeProof(record.target).catch(() => null);
        if (record.source === null) continue;
        await mkdir(dirname(record.target), { recursive: true });
        await mkdir(record.staged, { mode: 0o700 });
        record.stageCreated = true;
        for (const name of await readdir(record.source)) {
          await cp(join(record.source, name), join(record.staged, name), { recursive: true, force: false, errorOnExist: true });
        }
      }
      for (const record of this.records) record.afterDigest = record.source === null ? missingSkillDigest : await skillTreeProof(record.staged).catch(() => null);
      await this.save("pending");
      for (const record of this.records) {
        if (await info(record.target)) {
          await renameWithRetry(record.target, record.previous, { beforeAttempt: async () => {
            if (await info(record.previous)) throw failure("SKILL_TARGET_CHANGED");
          } });
          record.moved = true;
          await mkdir(dirname(record.archive), { recursive: true });
          await cp(record.previous, record.archive, { recursive: true, force: false, errorOnExist: true });
        }
        if (record.source !== null) {
          await renameWithRetry(record.staged, record.target, { beforeAttempt: async () => {
            if (await info(record.target)) throw failure("SKILL_TARGET_CHANGED");
          } });
          record.published = true;
          const metadata = await lstat(record.target);
          record.identity = { dev: metadata.dev, ino: metadata.ino };
        }
        await this.save("pending");
      }
      await commit();
      committed = true;
      await this.save("committed");
    } catch (error) {
      if (committed) return { id: this.id, committed: true, recoveryRequired: true };
      try {
        for (const record of [...this.records].reverse()) {
          if (record.published) {
            const current = await info(record.target);
            if (!current || (record.identity && (current.dev !== record.identity.dev || current.ino !== record.identity.ino))) throw failure("SKILL_TARGET_CHANGED");
            await renameWithRetry(record.target, record.staged);
            record.published = false;
          }
          if (record.moved) {
            if (await info(record.target)) throw failure("SKILL_TARGET_CHANGED");
            await renameWithRetry(record.previous, record.target);
            record.moved = false;
          }
        }
        await this.cleanStages();
        await this.save("rolled-back");
      } catch (rollbackError) {
        throw Object.assign(failure("SKILL_TRANSACTION_RECOVERY_REQUIRED"), { cause: error, rollbackCode: rollbackError.code || "ROLLBACK_FAILED", publicationId: this.id });
      }
      throw error;
    }
    let cleanupPending = false;
    for (const record of this.records) {
      if (record.moved) await rm(record.previous, { recursive: true, force: true }).catch(() => { cleanupPending = true; });
    }
    return { id: this.id, committed: true, cleanupPending };
  }

  async cleanStages() {
    for (const record of this.records) if (record.stageCreated && await info(record.staged)) {
      // Preserve a rejected candidate too; rollback must not erase concurrent edits.
      await mkdir(this.backupRoot, { recursive: true });
      await cp(record.staged, `${record.archive}.rejected`, { recursive: true, force: false, errorOnExist: true });
      await rm(record.staged, { recursive: true, force: true });
    }
  }
}
