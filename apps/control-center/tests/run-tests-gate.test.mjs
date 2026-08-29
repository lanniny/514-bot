import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

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
  assert.match(stdout, /clean-exit:resource=ok/);
  assert.match(stdout, /clean-exit:exit=ok/);
  assert.match(stdout, /clean-exit:childexit=ok/);
  assert.doesNotMatch(stdout, /clean-exit:[^\n]+=fail/);
  assert.equal((stdout.match(/clean-exit:resource=/g) || []).length, 1);
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
