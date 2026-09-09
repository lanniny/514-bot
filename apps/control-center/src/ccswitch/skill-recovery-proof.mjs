import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";

export const skillDigest = (value) => createHash("sha256").update(value).digest("hex");
export const missingSkillDigest = skillDigest("514cc:absent");
const failed = (code) => Object.assign(new Error(code), { code, httpStatus: 409 });
const unchanged = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
// Some Windows Node versions report dev=0 for path stats but a volume ID for handle stats.
const sameOpenedFile = (pathStat, handleStat) => unchanged(
  process.platform === "win32" && pathStat.dev === 0n ? { ...pathStat, dev: handleStat.dev } : pathStat,
  handleStat,
);

// Never follow a leaf link or read an unbounded file to build recovery evidence.
export async function readProofFile(path, maxBytes) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw failed("SKILL_PROOF_UNSAFE_FILE");
  if (before.size > BigInt(maxBytes)) throw failed("SKILL_PROOF_LIMIT");
  const file = await open(path, "r");
  try {
    const opened = await file.stat({ bigint: true });
    if (!sameOpenedFile(before, opened)) throw failed("SKILL_PROOF_CHANGED");
    const size = Number(before.size);
    const buffer = Buffer.alloc(size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== size || !unchanged(opened, await file.stat({ bigint: true })) || !unchanged(before, await lstat(path, { bigint: true }))) throw failed("SKILL_PROOF_CHANGED");
    return buffer.subarray(0, length);
  } finally { await file.close(); }
}

export async function skillStateProof(path) {
  try {
    const bytes = await readProofFile(path, 16 * 1024 * 1024);
    return { digest: skillDigest(bytes), bytes };
  } catch (error) {
    if (error.code === "ENOENT") return { digest: missingSkillDigest, bytes: null };
    throw error;
  }
}

export async function skillTreeProof(root, budget = { entries: 0, bytes: 0 }) {
  const manifest = [];
  async function visit(path, name, depth) {
    if (++budget.entries > 4096 || depth > 32) throw failed("SKILL_PROOF_LIMIT");
    const before = await lstat(path, { bigint: true });
    if (before.isSymbolicLink()) throw failed("SKILL_PROOF_UNSAFE_FILE");
    if (before.isDirectory()) {
      manifest.push([name, "directory"]);
      const children = (await readdir(path)).sort();
      if (children.length + budget.entries > 4096) throw failed("SKILL_PROOF_LIMIT");
      for (const child of children) await visit(join(path, child), name ? `${name}/${child}` : child, depth + 1);
    } else if (before.isFile()) {
      budget.bytes += Number(before.size);
      if (budget.bytes > 32 * 1024 * 1024) throw failed("SKILL_PROOF_LIMIT");
      manifest.push([name, "file", skillDigest(await readProofFile(path, 32 * 1024 * 1024 - budget.bytes + Number(before.size)))]);
    } else throw failed("SKILL_PROOF_UNSAFE_FILE");
    if (!unchanged(before, await lstat(path, { bigint: true }))) throw failed("SKILL_PROOF_CHANGED");
  }
  try { await lstat(root); } catch (error) {
    if (error.code === "ENOENT") return missingSkillDigest;
    throw error;
  }
  await visit(root, "", 0);
  return skillDigest(JSON.stringify(manifest));
}
