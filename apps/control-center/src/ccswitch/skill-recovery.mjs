import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { listSkillPublications, readSkillJournal, resolveSkillTarget, skillPublicationIdPattern, writeSkillJournal } from "./skill-publication.mjs";
import { skillDigest, skillStateProof, skillTreeProof } from "./skill-recovery-proof.mjs";

const digestPattern = /^[0-9a-f]{64}$/;
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const key = (path) => process.platform === "win32" ? path.toLowerCase() : path;
const fail = (code, httpStatus = 409) => { throw Object.assign(new Error(code), { code, httpStatus }); };

export class SkillRecovery {
  constructor({ journalRoot, backupRoot, statePath, roots, validateState, clock = Date.now }) {
    Object.assign(this, { journalRoot, backupRoot, statePath, roots, validateState, clock });
    this.plans = new Map();
  }

  async summary() {
    const result = await listSkillPublications(this.journalRoot).catch(() => ({ items: [], unavailable: true }));
    return { ...result, checkedAt: new Date(this.clock()).toISOString(), journalRoot: this.journalRoot, backupRoot: this.backupRoot };
  }

  async assess(id) {
    if (typeof id !== "string" || !skillPublicationIdPattern.test(id)) fail("SKILL_JOURNAL_INVALID", 400);
    const { journal, digest } = await readSkillJournal(this.journalRoot, id);
    if (journal.schema !== "514cc.skill-publication/v2") fail("SKILL_RECOVERY_LEGACY");
    if (journal.phase !== "pending") fail("SKILL_RECOVERY_NOT_PENDING");
    if (!digestPattern.test(journal.stateProof?.before ?? "") || !digestPattern.test(journal.stateProof?.after ?? "")) fail("SKILL_RECOVERY_PROOF_MISSING");
    if (!Array.isArray(journal.records) || journal.records.length > 64) fail("SKILL_RECOVERY_PROOF_MISSING");
    const state = await skillStateProof(this.statePath);
    const normalized = this.validateState(state.bytes === null ? null : JSON.parse(state.bytes.toString("utf8")));
    const roots = new Set();
    for (const root of this.roots(normalized)) roots.add(key(dirname(await resolveSkillTarget(join(root, ".recovery-root")))));
    const targets = [];
    const seen = new Set();
    // Journal paths are data, never authority. Only a direct Skill child of a current server-owned root is inspectable.
    for (const record of journal.records) {
      if (!record || typeof record.target !== "string" || !namePattern.test(basename(record.target)) || !roots.has(key(dirname(resolve(record.target))))) fail("SKILL_RECOVERY_PATH_FORBIDDEN");
      if (key(await resolveSkillTarget(record.target)) !== key(resolve(record.target)) || seen.has(key(record.target))) fail("SKILL_RECOVERY_PATH_FORBIDDEN");
      seen.add(key(record.target));
      if (!digestPattern.test(record.beforeDigest ?? "") || !digestPattern.test(record.afterDigest ?? "")) fail("SKILL_RECOVERY_PROOF_MISSING");
      targets.push({ path: record.target, name: basename(record.target), before: record.beforeDigest, after: record.afterDigest });
    }
    let before = state.digest === journal.stateProof.before;
    let after = state.digest === journal.stateProof.after;
    const actual = [];
    const budget = { entries: 0, bytes: 0 };
    for (const target of targets) {
      const current = await skillTreeProof(target.path, budget);
      before &&= current === target.before;
      after &&= current === target.after;
      actual.push({ name: target.name, state: current === target.after ? "after" : current === target.before ? "before" : "changed", digest: current });
    }
    const outcome = after ? "committed" : before ? "rolled-back" : null;
    return { journal, normalized, stateExists: state.bytes !== null, outcome, fingerprint: skillDigest(JSON.stringify({ digest, state: state.digest, roots: [...roots], actual })), targets: actual.map(({ name, state }) => ({ name, state })) };
  }

  async check(id) {
    for (const [token, plan] of this.plans) if (plan.expires <= this.clock() || plan.id === id) this.plans.delete(token);
    try {
      const result = await this.assess(id);
      if (!result.outcome) return { id, status: "blocked", reason: "SKILL_RECOVERY_MIXED_STATE", targets: result.targets };
      if (this.plans.size >= 16) this.plans.delete(this.plans.keys().next().value);
      const planToken = randomUUID();
      const expires = this.clock() + 60_000;
      this.plans.set(planToken, { id, expires, fingerprint: result.fingerprint, outcome: result.outcome });
      return { id, status: "ready", outcome: result.outcome, targets: result.targets, planToken, expiresAt: new Date(expires).toISOString() };
    } catch (error) {
      if (!skillPublicationIdPattern.test(id ?? "")) throw error;
      const reason = /^(SKILL_(?:RECOVERY|JOURNAL|PROOF)_)/.test(error.code ?? "") ? error.code : "SKILL_RECOVERY_UNREADABLE";
      return { id, status: "blocked", reason };
    }
  }

  async confirm(id, input) {
    if (input?.confirmed !== true) fail("CONFIRMATION_REQUIRED", 400);
    const plan = this.plans.get(input.planToken);
    this.plans.delete(input.planToken);
    if (!plan || plan.id !== id || plan.expires <= this.clock()) fail("SKILL_RECOVERY_PLAN_EXPIRED");
    const result = await this.assess(id);
    if (result.fingerprint !== plan.fingerprint || result.outcome !== plan.outcome) fail("SKILL_RECOVERY_CHANGED");
    // Only the record is finalized. Recovery never moves, removes or replaces live files or retained copies.
    await writeSkillJournal(join(this.journalRoot, `${id}.json`), {
      ...result.journal, phase: result.outcome, updatedAt: new Date(this.clock()).toISOString(),
      recovery: { confirmedAt: new Date(this.clock()).toISOString(), mode: "record-only", outcome: result.outcome },
    });
    return result;
  }
}
