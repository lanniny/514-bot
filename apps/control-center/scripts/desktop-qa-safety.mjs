import { lstat, readFile } from "node:fs/promises";
import { connect } from "node:net";
import { resolve } from "node:path";

export async function assertPortableQaInputs(bundle) {
  for (const name of ["514cc-bundle.json", "514 Bot.exe", "runtime/node.exe", "resources/control-center/server.mjs"]) {
    const info = await lstat(resolve(bundle, name));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`invalid portable QA input: ${name}`);
  }
  const manifest = JSON.parse(await readFile(resolve(bundle, "514cc-bundle.json"), "utf8"));
  if (manifest.schema !== "514cc.portable/v1") throw new Error("unsupported portable QA manifest");
}

export function isTcpPortClosed(port, timeoutMs = 500) {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (closed) => { if (!settled) { settled = true; socket.destroy(); done(closed); } };
    socket.once("connect", () => finish(false));
    socket.once("error", (error) => finish(error.code === "ECONNREFUSED"));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}
