import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { readPublicArtifact } from "./public-artifact.mjs";

// Verified against the official Node 22 LTS release index on 2026-09-06.
export const PORTABLE_NODE_VERSION = "v22.23.2";

export async function installOfficialNode(target, { version = PORTABLE_NODE_VERSION, arch = process.arch } = {}) {
  if (!/^v\d+\.\d+\.\d+$/.test(version) || !["x64", "arm64"].includes(arch)) throw new Error("unsupported official Node runtime target");
  const name = `node-${version}-win-${arch}`;
  const archiveName = `${name}.zip`;
  const base = `https://nodejs.org/dist/${version}`;
  const checksums = (await readPublicArtifact(`${base}/SHASUMS256.txt`, { maxBytes: 1024 * 1024 })).toString("utf8");
  const record = checksums.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).find((parts) => parts[1] === archiveName);
  if (!record || !/^[a-f0-9]{64}$/.test(record[0])) throw new Error("official Node checksum missing");
  const bytes = await readPublicArtifact(`${base}/${archiveName}`, { maxBytes: 64 * 1024 * 1024, timeoutMs: 120_000 });
  if (createHash("sha256").update(bytes).digest("hex") !== record[0]) throw new Error("official Node checksum mismatch");
  const zip = await new Promise((resolveZip, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolveZip(value)));
  const required = new Map([[`${name}/node.exe`, "node.exe"], [`${name}/LICENSE`, "LICENSE"]]);
  try {
    await new Promise((done, reject) => {
      zip.on("error", reject);
      zip.on("end", () => required.size ? reject(new Error("official Node runtime files missing")) : done());
      zip.on("entry", (entry) => {
        const name = required.get(entry.fileName);
        if (!name) { zip.readEntry(); return; }
        if (entry.uncompressedSize > 128 * 1024 * 1024) { reject(new Error("official Node entry exceeds its byte budget")); return; }
        zip.openReadStream(entry, async (error, stream) => {
          if (error) { reject(error); return; }
          try {
            await pipeline(stream, createWriteStream(resolve(target, name), { flags: "wx" }));
            required.delete(entry.fileName);
            zip.readEntry();
          } catch (failure) { reject(failure); }
        });
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
  return { source: `${base}/${archiveName}`, sha256: record[0], version, arch };
}
