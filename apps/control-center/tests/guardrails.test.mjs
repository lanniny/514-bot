import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGuardrailsService,
  expandHome,
  globToRegExp,
  parseDenyPaths,
} from "../src/guardrails.mjs";

const DENY_PATHS = `# 注释行
~/.ssh/**
~/.codex/auth.json
**/*.pem
**/.env
C:\\Windows\\**
/var/lib/**`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "guardrails-"));
  await mkdir(join(root, "guardrails"), { recursive: true });
  await writeFile(join(root, "guardrails", "deny-paths.txt"), DENY_PATHS, "utf8");
  return root;
}

test("parseDenyPaths skips comments and classifies prefix vs glob", () => {
  const rules = parseDenyPaths(DENY_PATHS);
  assert.deepEqual(rules.map((rule) => rule.kind), ["glob", "prefix", "glob", "glob", "glob", "glob"]);
  assert.equal(rules[0].pattern.replace(/\\/g, "/").endsWith("/.ssh/**"), true);
  assert.equal(rules[1].pattern.replace(/\\/g, "/").endsWith("/.codex/auth.json"), true);
});

test("expandHome expands ~ prefix only", () => {
  const home = "C:/Users/qa";
  assert.equal(expandHome("~/.ssh/**", home), "C:/Users/qa/.ssh/**");
  assert.equal(expandHome("~/", home), "C:/Users/qa/");
  assert.equal(expandHome("C:/Windows/**", home), "C:/Windows/**");
});

test("globToRegExp matches deep globs, single star, and zero-directory **/", () => {
  assert.equal(globToRegExp("**/*.pem").test("I:/repo/certs/server.pem"), true);
  assert.equal(globToRegExp("**/*.pem").test("I:/repo/server.key"), false);
  assert.equal(globToRegExp("**/.env").test("I:/repo/.env"), true);
  assert.equal(globToRegExp("/var/lib/**").test("/var/lib/mysql"), true);
  assert.equal(globToRegExp("/var/lib/**").test("/var/lib"), true);
  assert.equal(globToRegExp("C:/Windows/**").test("C:/Windows/System32/config"), true);
  // 单个 * 不跨目录
  assert.equal(globToRegExp("/opt/*/*.key").test("/opt/a/b/c.key"), false);
  assert.equal(globToRegExp("/opt/*/*.key").test("/opt/a/b.key"), true);
});

test("service denies matching paths with rule evidence and allows clean paths", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createGuardrailsService({ repoRoot: root, home: "C:/Users/qa" });

  const denied = await service.testPath("C:/Users/qa/.ssh/id_ed25519");
  assert.equal(denied.denied, true);
  assert.ok(denied.matchedRules.some((rule) => rule.pattern.endsWith("/.ssh/**")));
  assert.equal(denied.evaluatedRules, 6);

  const jsonDenied = await service.testPath("I:/514claude/514cc/guardrails/fake.pem");
  assert.equal(jsonDenied.denied, true);

  const envDenied = await service.testPath("I:/repo/app/.env");
  assert.equal(envDenied.denied, true);

  const allowed = await service.testPath("I:/514claude/514cc/apps/control-center/server.mjs");
  assert.equal(allowed.denied, false);
  assert.deepEqual(allowed.matchedRules, []);
});

test("service throws VALIDATION_FAILED for empty path and GUARDRAILS_UNAVAILABLE for missing file", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createGuardrailsService({ repoRoot: root });
  await assert.rejects(() => service.testPath("  "), { code: "VALIDATION_FAILED" });
  await assert.rejects(() => service.testPath("a".repeat(2000)), { code: "VALIDATION_FAILED" });

  const empty = await mkdtemp(join(tmpdir(), "guardrails-empty-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const broken = createGuardrailsService({ repoRoot: empty });
  // deny-paths 缺失 = 如实降级"不可判定"，不再 500（QA 隔离仓等最小化环境）
  const degradedRules = await broken.rules();
  assert.equal(degradedRules.available, false);
  const degradedTest = await broken.testPath("I:/any/path");
  assert.equal(degradedTest.available, false);
  assert.equal(degradedTest.denied, null);
});
