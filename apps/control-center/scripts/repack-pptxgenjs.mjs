import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGunzip, createGzip } from "node:zlib";
import tar from "tar-stream";
import { readPublicArtifact } from "./public-artifact.mjs";

export const UPSTREAM_VERSION = "4.0.1";
export const PATCH_VERSION = "4.0.1-514cc.1";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function repackPptx(bytes, integrity) {
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity || "")) throw new Error("upstream SHA-512 integrity is required");
  const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (actual !== integrity) throw new Error("upstream integrity mismatch");
  const entries = [];
  const names = new Set();
  const extractor = tar.extract();
  let total = 0;
  extractor.on("entry", (header, stream, next) => {
    const chunks = [];
    stream.on("data", (chunk) => {
      total += chunk.length;
      if (total > 32 * 1024 * 1024) extractor.destroy(new Error("upstream archive exceeds its byte budget"));
      else chunks.push(chunk);
    });
    stream.on("end", () => {
      if (!header.name.startsWith("package/") || posix.normalize(header.name) !== header.name || names.has(header.name)
          || header.name.includes("\\") || !["file", "directory"].includes(header.type) || entries.length >= 1000) {
        extractor.destroy(new Error("unexpected upstream archive entry"));
        return;
      }
      names.add(header.name);
      entries.push({ header, data: Buffer.concat(chunks) });
      next();
    });
    stream.on("error", (error) => extractor.destroy(error));
  });
  await pipeline(Readable.from(bytes), createGunzip(), extractor);
  const entry = entries.find(({ header }) => header.name === "package/package.json");
  if (!entry) throw new Error("upstream manifest missing");
  const manifest = JSON.parse(entry.data.toString("utf8"));
  if (manifest.name !== "pptxgenjs" || manifest.version !== UPSTREAM_VERSION || manifest.dependencies?.["image-size"] !== "^1.2.1") {
    throw new Error("upstream dependency contract changed; re-review required");
  }
  const preservedFiles = entries.filter((item) => item !== entry && item.header.type === "file")
    .map(({ header, data }) => ({ path: header.name, sha256: sha256(data) }));
  manifest.version = PATCH_VERSION;
  delete manifest.dependencies["image-size"];
  entry.data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const packer = tar.pack();
  const chunks = [];
  const compressed = packer.pipe(createGzip({ level: 9 }));
  compressed.on("data", (chunk) => chunks.push(chunk));
  const finished = new Promise((resolveDone, reject) => {
    compressed.once("end", resolveDone);
    compressed.once("error", reject);
    packer.once("error", reject);
  });
  for (const { header, data } of entries) {
    await new Promise((resolveEntry, reject) => packer.entry({ ...header, size: data.length }, data, (error) => error ? reject(error) : resolveEntry()));
  }
  packer.finalize();
  await finished;
  const patched = Buffer.concat(chunks);
  return { bytes: patched, provenance: {
    schema: "514cc.vendorPatch/v1", name: "pptxgenjs", upstreamVersion: UPSTREAM_VERSION,
    patchedVersion: PATCH_VERSION, upstreamIntegrity: integrity, upstreamSha256: sha256(bytes),
    patchedSha256: sha256(patched), changedFiles: ["package/package.json"], preservedFiles,
    reason: "Remove an unused image-size dependency; published library code and license are unchanged.",
  } };
}

export async function main() {
  const registry = `https://registry.npmjs.org/pptxgenjs/${UPSTREAM_VERSION}`;
  const metadata = JSON.parse((await readPublicArtifact(registry, { maxBytes: 1024 * 1024 })).toString("utf8"));
  const expectedUrl = `https://registry.npmjs.org/pptxgenjs/-/pptxgenjs-${UPSTREAM_VERSION}.tgz`;
  if (metadata.dist?.tarball !== expectedUrl) throw new Error("unexpected upstream tarball URL");
  const result = await repackPptx(await readPublicArtifact(expectedUrl), metadata.dist.integrity);
  const folder = fileURLToPath(new URL("../vendor/", import.meta.url));
  await mkdir(folder, { recursive: true });
  const output = resolve(folder, `pptxgenjs-${PATCH_VERSION}.tgz`);
  await writeFile(output, result.bytes);
  await writeFile(resolve(dirname(output), `pptxgenjs-${PATCH_VERSION}.provenance.json`), `${JSON.stringify(result.provenance, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, preservedFiles: result.provenance.preservedFiles.length, sha256: result.provenance.patchedSha256 })}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
