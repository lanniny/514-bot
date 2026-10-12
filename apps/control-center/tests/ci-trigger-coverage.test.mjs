import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(appRoot, "..", "..");
const workflowPath = resolve(repoRoot, ".github", "workflows", "control-center-ci.yml");

/**
 * CI 触发面必须覆盖 `npm run validate` 的**完整读取面**。
 *
 * 为什么需要这条契约（2026-10-09 补，烛 R3/R4 发现）：
 * 校验器**存在** ≠ 校验**会发生**。CI 的 `on.*.paths` 是白名单——不在其中的改动
 * 根本不触发 job，校验器再完备也照不到。2026-08-30 F-073「删除 web-intel skill
 * 目录」的提交正因此完全不触发 CI，`.claude-plugin/plugin.json` 的死引用静默漂移 40 天。
 *
 * 判据不是手工维护一张"必须存在的路径清单"（那张表自己会腐烂），而是**从源码派生**。
 * 覆盖三个来源（烛 R4 指出只扫 validator.mjs 会漏）：
 *   1. `validator.mjs` —— repository-truth 的各校验项
 *   2. `validate-control-configs.mjs` —— `npm run validate` 的入口编排层
 *   3. `validator.mjs` 里以**被校验文件所在目录**为根的 schema 读取（第三根）
 */

/** 从一段源码里抽 `resolve(rootExpr, "a", "b")` / `join(rootExpr, ...)` 的字面量路径。 */
function extractLiteralPaths(source, rootExprPattern) {
  const found = new Set();
  const callPattern = new RegExp(
    `\\b(?:resolve|join)\\(\\s*(?:${rootExprPattern})\\s*,\\s*((?:"[^"]*"|'[^']*')\\s*(?:,\\s*(?:"[^"]*"|'[^']*')\\s*)*)\\)`,
    "g",
  );
  for (const match of source.matchAll(callPattern)) {
    const segments = [...match[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
    if (segments.length) found.add(segments.join("/"));
  }
  return found;
}

/** validator.mjs 里以 repoRoot 为根的路径（含 EXPECTED_* / CODEX_HOOK_CONFIG 常量值）。 */
export async function extractValidatorRepoPaths() {
  const source = await readFile(resolve(appRoot, "src", "validator.mjs"), "utf8");
  const found = extractLiteralPaths(source, "repoRoot");
  // `resolve(repoRoot, SOME_CONSTANT)`：把这些常量的字面量值纳入。
  // 不收 MODULE_SOURCE_ID——它是 source **标识符**不是路径（收进来会让口径失真）。
  for (const match of source.matchAll(/^const (EXPECTED_\w+|CODEX_HOOK_CONFIG)\s*=\s*"([^"]+)";$/gm)) {
    found.add(match[2]);
  }
  // 第三根：`resolve(dirname(source.path), "schemas", "module.schema.json")`。
  // source.path 是**被校验文件的绝对路径**，对 module.yaml 而言其 dirname 即 repoRoot；
  // 故这些字面量段在当前调用点等价于仓库相对路径（若将来 source 来自子目录，此处需改）。
  for (const literal of extractLiteralPaths(source, "dirname\\(\\s*source\\.path\\s*\\)")) {
    found.add(literal);
  }
  return [...found].sort();
}

/** validate-control-configs.mjs（npm run validate 的入口编排层）读取的仓库路径。 */
export async function extractValidateEntryPaths() {
  const source = await readFile(resolve(appRoot, "scripts", "validate-control-configs.mjs"), "utf8");
  const found = extractLiteralPaths(source, "repoRoot");
  // sources 表里的 `["id", "path", "kind"]` 三元组（validateContent 逐个读）
  for (const match of source.matchAll(/\[\s*"[^"]+"\s*,\s*"([^"]+)"\s*,\s*"(?:json|yaml|toml)"\s*\]/g)) {
    found.add(match[1]);
  }
  return [...found].sort();
}

/** GitHub Actions 的 paths 通配（仅 `*` 与 `**`，外加 `?`）→ 正则。 */
export function ciGlobToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** 目标是否被 paths 白名单覆盖；目录目标可由其下的 `dir/**` 覆盖。 */
export function isCoveredBy(target, patterns) {
  return patterns.some((pattern) =>
    ciGlobToRegExp(pattern).test(target)
    || ciGlobToRegExp(`${pattern.replace(/\/\*\*$/, "")}/**`).test(`${target}/x`));
}

async function pathExists(target) {
  try {
    await stat(resolve(repoRoot, target));
    return true;
  } catch {
    return false;
  }
}

test("CI trigger paths cover every repository path npm run validate reads", async () => {
  const workflow = parseYaml(await readFile(workflowPath, "utf8"));
  // YAML 1.1 把裸 `on` 解析成布尔 true；两种键都试。
  const triggers = workflow.on ?? workflow[true] ?? workflow[String(true)];
  assert.ok(triggers, "workflow must declare an `on` trigger block");
  const pullRequestPaths = triggers.pull_request?.paths;
  const pushPaths = triggers.push?.paths;
  assert.ok(Array.isArray(pullRequestPaths) && pullRequestPaths.length, "pull_request.paths must be a non-empty array");
  assert.ok(Array.isArray(pushPaths) && pushPaths.length, "push.paths must be a non-empty array");
  assert.deepEqual(pullRequestPaths, pushPaths, "pull_request and push trigger paths must stay identical");

  // 取反模式（`!path`）会让"覆盖"判断反向，而本测试的 `.some()` 语义读不出来 →
  // 出现即 fail-closed，避免测试说 covered 而 GitHub 实际排除（烛 R4 建议 3）。
  const negated = pullRequestPaths.filter((pattern) => pattern.startsWith("!"));
  assert.deepEqual(negated, [], `negated CI paths are not modelled by this contract, add support first: ${negated.join(", ")}`);

  const validatorPaths = await extractValidatorRepoPaths();
  const entryPaths = await extractValidateEntryPaths();

  // 防"提取器恒返回空集/大量漏项"的假保护：这几个路径是校验链铁定会读的，
  // 提取不出来说明正则失效——测试会恒绿，比没有测试更贵（烛 R4 建议 4）。
  for (const must of [
    "module.yaml",
    ".claude-plugin/plugin.json",
    "rules.md",
    "config/control-center/models.json",
    "skills",
    ".agents/skills",
    "schemas/module.schema.json",
  ]) {
    assert.ok(validatorPaths.includes(must), `extractor failed to surface a known validator input: ${must}`);
  }
  for (const must of ["schemas/module.schema.json", "schemas/control-center/contracts.schema.json"]) {
    assert.ok(entryPaths.includes(must), `entry extractor failed to surface a known input: ${must}`);
  }
  // 计数下界：防"只抓 resolve 不抓 join"这类**部分**失效（哨兵只挡得住恒空）。
  assert.ok(
    validatorPaths.length >= 12,
    `validator path extractor returned only ${validatorPaths.length} entries — likely partially broken`,
  );

  const uncovered = [];
  for (const candidate of [...new Set([...validatorPaths, ...entryPaths])]) {
    if (!await pathExists(candidate)) continue; // 不存在的路径由校验器自己报错
    if (!isCoveredBy(candidate, pullRequestPaths)) uncovered.push(candidate);
  }
  assert.deepEqual(
    uncovered,
    [],
    `CI would not run for changes to these validate inputs:\n${uncovered.join("\n")}`,
  );
});
