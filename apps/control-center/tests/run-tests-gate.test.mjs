import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const execFileAsync = promisify(execFile);
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const runner = fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url));

test("run-tests clean-exit gate reports one successful terminal verdict", { timeout: 60_000 }, async () => {
  const { stdout } = await execFileAsync(process.execPath, [runner, "--timeout=30", "tests/projects.test.mjs"], {
    cwd: appRoot,
    env: process.env,
    windowsHide: true,
  });
  assert.match(stdout, /clean-exit:launch=ok/);
  assert.match(stdout, /clean-exit:scope=direct-child/);
  assert.match(stdout, /clean-exit:process-tree=unverified/);
  assert.match(stdout, /clean-exit:resource=ok/);
  assert.match(stdout, /clean-exit:exit=ok/);
  assert.match(stdout, /clean-exit:childexit=ok/);
  assert.doesNotMatch(stdout, /clean-exit:[^\n]+=fail/);
  assert.equal((stdout.match(/clean-exit:resource=/g) || []).length, 1);
});

test("successful nested runners and unselected cleanup preserve pre-existing and concurrent fixtures", { timeout: 60_000 }, async (t) => {
  const prior = await mkdtemp(join(appRoot, ".test-owned-by-other-"));
  const late = await mkdtemp(join(appRoot, ".test-concurrent-owner-"));
  const fixture = await mkdtemp(join(tmpdir(), "514cc-runner-regression-"));
  t.after(async () => { await Promise.all([prior, late, fixture].map((path) => rm(path, { recursive: true, force: true }))); });
  await writeFile(join(prior, "sentinel"), "retain prior data");
  await writeFile(join(late, "sentinel"), "retain concurrent data");
  const testPath = join(fixture, "noop.test.mjs");
  await writeFile(testPath, 'import test from "node:test"; test("no-op", () => {});\n');
  await execFileAsync(process.execPath, [runner, "--timeout=30", testPath], { cwd: appRoot, windowsHide: true });
  assert.equal(await readFile(join(prior, "sentinel"), "utf8"), "retain prior data");
  assert.equal(await readFile(join(late, "sentinel"), "utf8"), "retain concurrent data");
  await assert.rejects(execFileAsync(process.execPath, [runner, "--clean-only"], { cwd: appRoot, windowsHide: true }), { code: 2 });
  assert.equal(await readFile(join(prior, "sentinel"), "utf8"), "retain prior data");
  const { stdout } = await execFileAsync(process.execPath, [runner, "--clean-only", `--clean-path=${basename(prior)}`], { cwd: appRoot, windowsHide: true });
  assert.match(stdout, /clean-exit:swept=1/);
  assert.equal(await readFile(join(late, "sentinel"), "utf8"), "retain concurrent data");
  await assert.rejects(execFileAsync(process.execPath, [runner, "--clean-only", "--clean-path=../outside"], { cwd: appRoot, windowsHide: true }));
});

test("run-tests timeout remains failed after the child closes and records reaping", { timeout: 60_000 }, async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [runner, "--timeout=0.01", "tests/projects.test.mjs"], {
      cwd: appRoot,
      env: process.env,
      windowsHide: true,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /clean-exit:launch=ok/);
      assert.match(error.stdout, /clean-exit:resource=fail/);
      assert.match(error.stdout, /clean-exit:reap=ok/);
      assert.doesNotMatch(error.stdout, /clean-exit:resource=ok/);
      assert.equal((error.stdout.match(/clean-exit:resource=/g) || []).length, 1);
      return true;
    },
  );
});
