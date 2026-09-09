import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { repackPptx } from "../scripts/repack-pptxgenjs.mjs";

const require = createRequire(import.meta.url);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const integrity = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

async function archive(entries) {
  const pack = tar.pack();
  const chunks = [];
  pack.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolveDone, reject) => { pack.on("end", resolveDone); pack.on("error", reject); });
  for (const [name, text] of entries) pack.entry({ name, mtime: new Date(0) }, text);
  pack.finalize();
  await done;
  return gzipSync(Buffer.concat(chunks));
}

test("PPT compatibility archive is integrity-bound, deterministic and changes only its manifest", async () => {
  const data = await archive([
    ["package/package.json", JSON.stringify({ name: "pptxgenjs", version: "4.0.1", dependencies: { "image-size": "^1.2.1", jszip: "^3.10.1" } })],
    ["package/dist/pptxgen.cjs.js", "published library bytes"],
  ]);
  const first = await repackPptx(data, integrity(data));
  const second = await repackPptx(data, integrity(data));
  assert.deepEqual(first.bytes, second.bytes);
  assert.deepEqual(first.provenance.changedFiles, ["package/package.json"]);
  assert.equal(first.provenance.preservedFiles[0].sha256, digest("published library bytes"));
  await assert.rejects(repackPptx(data, integrity(Buffer.from("wrong input"))), /integrity mismatch/);
  const escape = await archive([["package/../outside", "must not escape"]]);
  await assert.rejects(repackPptx(escape, integrity(escape)), /unexpected upstream archive entry/);
});

test("installed patched package retains every published artifact and the upstream license", async () => {
  const root = resolve(dirname(require.resolve("pptxgenjs")), "..");
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.equal(manifest.version, "4.0.1-514cc.1");
  assert.equal(manifest.dependencies["image-size"], undefined);
  const provenance = JSON.parse(await readFile(new URL("../vendor/pptxgenjs-4.0.1-514cc.1.provenance.json", import.meta.url)));
  for (const file of provenance.preservedFiles) {
    assert.equal(digest(await readFile(resolve(root, file.path.slice("package/".length)))), file.sha256, file.path);
  }
  assert.ok(provenance.preservedFiles.some((file) => /license/i.test(file.path)));
});

test("presentations retain text, notes and image support without loading image-size", async () => {
  const script = `
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(id, ...rest) {
      if (id === 'image-size' || id.startsWith('image-size/')) throw new Error('unused image parser must not load');
      return load.call(this, id, ...rest);
    };
    const PptxGenJS = require('pptxgenjs');
    const pptx = new PptxGenJS();
    const slide = pptx.addSlide();
    slide.addText('Preserved presentation output', { x: 1, y: 1, w: 6, h: 1 });
    slide.addNotes('Preserved notes');
    slide.addImage({ data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7b8AAAAASUVORK5CYII=', x: 1, y: 2, w: 1, h: 1 });
    pptx.write({ outputType: 'nodebuffer' }).then(bytes => process.stdout.write(String(bytes.length)));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", script], { cwd: resolve(import.meta.dirname, ".."), timeout: 15_000, windowsHide: true });
  assert.ok(Number(stdout) > 1000);
});
