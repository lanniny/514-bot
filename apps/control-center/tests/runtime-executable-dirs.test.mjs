import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { envLookup, runtimeExecutableDirs, withRuntimeExecutablePath } from "../src/runtime-executable-dirs.mjs";
import { resolveCommand } from "../src/process-runner.mjs";
import { resolveSpawnCommand } from "../src/pty.mjs";

test("runtime PATH synthesis prepends existing grok dirs so stale PATH still resolves grok", () => {
  const home = mkdtempSync(join(tmpdir(), "cc-runtime-path-"));
  try {
    const grokDir = join(home, ".grok", "bin");
    mkdirSync(grokDir, { recursive: true });
    writeFileSync(join(grokDir, "grok.exe"), "");
    const env = { USERPROFILE: home, HOME: home, PATH: join(tmpdir(), "no-such-cli-path") };
    const dirs = runtimeExecutableDirs(env);
    assert.deepEqual(dirs, [grokDir]);
    const synthesized = withRuntimeExecutablePath(env);
    assert.ok(String(synthesized.PATH).toLowerCase().includes(".grok"));
    if (process.platform === "win32") {
      const resolved = resolveCommand("grok", env);
      assert.match(resolved.resolvedPath, /\.grok[\\/]bin[\\/]grok\.exe$/i);
      const spawn = resolveSpawnCommand("grok", { platform: "win32", env: synthesized });
      assert.match(spawn.command, /grok\.exe$/i);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("PATH clone keeps Windows ComSpec so .cmd shims still wrap via cmd.exe", () => {
  const home = mkdtempSync(join(tmpdir(), "cc-runtime-comspec-"));
  try {
    const grokDir = join(home, ".grok", "bin");
    const shimDir = join(home, "shim-path");
    mkdirSync(grokDir, { recursive: true });
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, "shimcli.cmd"), "");
    const env = {
      USERPROFILE: home,
      HOME: home,
      PATH: shimDir,
      ComSpec: "X:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    };
    const synthesized = withRuntimeExecutablePath(env);
    assert.equal(envLookup(synthesized, "COMSPEC"), "X:\\Windows\\System32\\cmd.exe");
    assert.notEqual(synthesized, env, "existing grok dir must clone env instead of mutating PATH in place");
    const spawn = resolveSpawnCommand("shimcli", { platform: "win32", env: synthesized });
    assert.equal(spawn.command, "X:\\Windows\\System32\\cmd.exe");
    assert.deepEqual(spawn.prefixArgs, ["/d", "/c", "shimcli"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
