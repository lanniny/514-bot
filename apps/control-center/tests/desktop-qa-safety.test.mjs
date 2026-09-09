import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { assertPortableQaInputs, isTcpPortClosed } from "../scripts/desktop-qa-safety.mjs";

test("native QA rejects unbundled input before a runtime-info process may initialize directories", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "514cc-qa-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, "514 Bot.exe"), "unbundled fixture");
  await assert.rejects(assertPortableQaInputs(root), { code: "ENOENT" });
  for (const name of ["runtime/node.exe", "resources/control-center/server.mjs"]) {
    await mkdir(dirname(resolve(root, name)), { recursive: true });
    await writeFile(resolve(root, name), "fixture");
  }
  await writeFile(resolve(root, "514cc-bundle.json"), JSON.stringify({ schema: "unknown" }));
  await assert.rejects(assertPortableQaInputs(root), /unsupported portable QA/);
  await writeFile(resolve(root, "514cc-bundle.json"), JSON.stringify({ schema: "514cc.portable/v1" }));
  await assertPortableQaInputs(root);
});

test("endpoint exit evidence rejects a listening socket even when it never serves HTTP", async (t) => {
  const sockets = new Set();
  const server = createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  t.after(() => { for (const socket of sockets) socket.destroy(); if (server.listening) server.close(); });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  assert.equal(await isTcpPortClosed(port), false);
  for (const socket of sockets) socket.destroy();
  await new Promise((done) => server.close(done));
  assert.equal(await isTcpPortClosed(port), true);
});
