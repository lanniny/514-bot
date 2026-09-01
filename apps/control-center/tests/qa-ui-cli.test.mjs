import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseQaUiFixtureArgs } from "../scripts/qa-ui-fixture.mjs";

const qaScript = fileURLToPath(new URL("../scripts/qa-ui.mjs", import.meta.url));
const qaFixtureScript = fileURLToPath(new URL("../scripts/qa-ui-fixture.mjs", import.meta.url));

test("qa-ui rejects an unknown suite before launching a browser", () => {
  const result = spawnSync(process.execPath, [qaScript, "http://127.0.0.1:1", "--suite=histroy"], {
    encoding: "utf8",
    windowsHide: true,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown QA suite: histroy/);
});

test("qa-ui fixture owns the default URL lifecycle and parses named options", () => {
  const defaults = parseQaUiFixtureArgs([]);
  assert.equal(defaults.suite, "all");
  assert.match(defaults.outputDir.replaceAll("\\", "/"), /514cc-qa-ui-artifacts-/);
  const configured = parseQaUiFixtureArgs(["--output-dir=.qa-output/focused", "--suite=mission"]);
  assert.equal(configured.suite, "mission");
  assert.match(configured.outputDir.replaceAll("\\", "/"), /\.qa-output\/focused$/);
  assert.throws(() => parseQaUiFixtureArgs(["http://127.0.0.1:51400"]), /unknown QA fixture option/);
});

test("qa-ui fixture rejects an unknown suite before spawning its server", () => {
  const result = spawnSync(process.execPath, [qaFixtureScript, "--suite=histroy"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown QA suite: histroy/);
});
