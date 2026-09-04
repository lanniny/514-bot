/**
 * API 契约门禁（v49 · 2026-09-04）。
 *
 * 治的问题：`server.mjs` 123 条手写 if-链路由 与 `public/api.js` 92 条手写常量表
 * **零机械关联**。前端调一个不存在的端点 → 运行时静默 404（常被 toast 吞成"操作失败"）；
 * 后端加一条端点没人接 → 死能力躺着。首次对账实测出 8 条零 UI 入口的后端能力，
 * 其中 A/B 影子对照（createShadowPair + 对比矩阵 + Markdown 报告）从头写完却没有入口。
 *
 * 三条门禁：
 *   1. orphan-call = 0        前端调、后端无 —— 运行时必 404，零容忍
 *   2. dead-endpoint 必须登记  后端有、前端不调 → 要么接 UI，要么在 KNOWN_UI_LESS 写下理由
 *   3. 白名单不许留过期项      已经接了 UI 的条目必须从名单里删掉
 *
 * 元验收（按 `tautological-test-baselines` 的教训，**真注入不只写注释**）：
 * 末尾用合成 fixture 构造 orphan / dead / stale 三种违规，确认检测器都能抓到。
 * 期望值不从被测模块派生。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KNOWN_UI_LESS,
  auditApiContract,
  extractBackendRoutes,
  extractFrontendCalls,
  matchBackend,
  normalizePath,
} from "../src/api-contract.mjs";

const realAudit = () => auditApiContract({
  serverPath: "server.mjs",
  publicDir: "public",
  repoRoot: process.cwd(),
});

test("门禁 1：没有 orphan-call（前端调、后端无 → 运行时必 404）", () => {
  const { orphans } = realAudit();
  assert.deepEqual(
    orphans.map((item) => `${item.path}  ← ${item.sites[0]}`),
    [],
    "前端调用了后端不存在的端点；要么补后端路由，要么改前端路径",
  );
});

test("门禁 2：没有未登记的死能力（后端有、前端不调）", () => {
  const { dead } = realAudit();
  assert.deepEqual(
    dead.map((item) => `${item.methods.join("/")} ${item.path}`),
    [],
    "后端端点无 UI 入口且未登记；要么接 UI，要么在 src/api-contract.mjs 的 KNOWN_UI_LESS 写下理由",
  );
});

test("门禁 3：KNOWN_UI_LESS 不留过期项（已接 UI 的必须删掉）", () => {
  const { staleWhitelist } = realAudit();
  assert.deepEqual(staleWhitelist, [], "这些端点已经有 UI 入口，应从 KNOWN_UI_LESS 移除");
});

test("KNOWN_UI_LESS 每条都写了理由，且只应变短", () => {
  const entries = Object.entries(KNOWN_UI_LESS);
  for (const [path, reason] of entries) {
    assert.match(path, /^\/api\//, `${path} 不是 API 路径`);
    assert.equal(typeof reason, "string");
    assert.ok(reason.length >= 8, `${path} 的理由太短，写不清就说明该接 UI 而不是登记`);
  }
  // 上界断言：名单是死能力账本不是豁免券。要加新条目请先确认真的不该接 UI，
  // 并把这个数字一起改 —— 让"名单变长"成为一次显式决定。
  assert.ok(entries.length <= 6, `KNOWN_UI_LESS 涨到 ${entries.length} 条了，死能力在累积`);
});

test("规模合理性：抽取器没有退化成扫不到东西", () => {
  const { counts } = realAudit();
  assert.ok(counts.backendExact >= 100, `后端路由只抽到 ${counts.backendExact} 条，疑似抽取口径退化`);
  assert.ok(counts.frontendCalls >= 250, `前端调用只抽到 ${counts.frontendCalls} 条，疑似抽取口径退化`);
});

test("normalizePath 归一化参数段与模板插值", () => {
  assert.equal(normalizePath("/api/runs/${id}"), "/api/runs/:p");
  assert.equal(normalizePath("/api/runs/:id"), "/api/runs/:p");
  assert.equal(normalizePath("/api/runs/:runId/diff"), "/api/runs/:p/diff");
  assert.equal(normalizePath("/api/runs/"), "/api/runs");
  assert.equal(normalizePath(""), "/");
  assert.equal(normalizePath(null), "/");
  assert.equal(normalizePath(undefined), "/");
});

test("matchBackend 覆盖精确/前缀/参数三种命中", () => {
  const backend = {
    exact: new Map([
      ["/api/runs", { methods: new Set(["GET"]), testOnly: false }],
      ["/api/runs/:p", { methods: new Set(["GET"]), testOnly: false }],
    ]),
    prefixes: [{ prefix: "/api/files", methods: new Set(["GET"]) }],
  };
  assert.equal(matchBackend("/api/runs", backend), "exact");
  assert.equal(matchBackend("/api/runs/:p", backend), "exact");
  assert.equal(matchBackend("/api/runs/abc123", backend), "param");
  assert.equal(matchBackend("/api/files/a/b/c", backend), "prefix");
  assert.equal(matchBackend("/api/nope", backend), null);
});

// ═══ 元验收：真注入违规，确认检测器抓得到（不只写注释）═══

function withFixture(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "api-contract-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const full = join(dir, name);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content, "utf8");
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("元验收：注入 orphan-call 能被抓到", () => {
  const found = withFixture({
    "server.mjs": 'if (request.method === "GET" && pathname === "/api/exists") {}',
    "public/api.js": "const API = { exists: \"/api/exists\" };",
    "public/app.js": 'request("/api/does-not-exist");',
  }, (dir) => auditApiContract({
    serverPath: join(dir, "server.mjs"),
    publicDir: join(dir, "public"),
    repoRoot: dir,
  }));
  assert.equal(found.orphans.length, 1, "未抓到注入的 orphan");
  assert.equal(found.orphans[0].path, "/api/does-not-exist");
  assert.match(found.orphans[0].sites[0], /app\.js:1$/);
});

test("元验收：注入 dead-endpoint 能被抓到", () => {
  const found = withFixture({
    "server.mjs": [
      'if (request.method === "GET" && pathname === "/api/used") {}',
      'if (request.method === "POST" && pathname === "/api/orphaned-capability") {}',
    ].join("\n"),
    "public/api.js": "const API = { used: \"/api/used\" };",
    "public/app.js": 'request("/api/used");',
  }, (dir) => auditApiContract({
    serverPath: join(dir, "server.mjs"),
    publicDir: join(dir, "public"),
    repoRoot: dir,
  }));
  assert.equal(found.dead.length, 1, "未抓到注入的死能力");
  assert.equal(found.dead[0].path, "/api/orphaned-capability");
  assert.deepEqual(found.dead[0].methods, ["POST"]);
});

test("元验收：test-only 路由不算死能力（含派生门控变量）", () => {
  const found = withFixture({
    "server.mjs": [
      'if (request.method === "POST" && pathname === "/api/test/shutdown" && process.env.CONTROL_CENTER_TEST_MODE === "1") {}',
      'if (request.method === "POST" && pathname === "/api/test/gate/release" && testBusTailGateEnabled) {}',
    ].join("\n"),
    "public/api.js": "const API = {};",
    "public/app.js": "// no calls",
  }, (dir) => auditApiContract({
    serverPath: join(dir, "server.mjs"),
    publicDir: join(dir, "public"),
    repoRoot: dir,
  }));
  assert.deepEqual(found.dead, [], "test-only 路由被误判成死能力");
});

test("元验收：`${API.xxx}/suffix` 模板拼接能被抽到（首版盲区）", () => {
  const calls = withFixture({
    "public/api.js": 'const API = {\n  runs: "/api/runs",\n};',
    "public/panel.js": "request(`${API.runs}/compare?a=1&b=2`);",
  }, (dir) => extractFrontendCalls(join(dir, "public"), { repoRoot: dir }));
  assert.ok(calls.has("/api/runs/compare"), `未抽到模板拼接路径，实际抽到：${[...calls.keys()].join(" ")}`);
});

test("元验收：api.js 缺失时退化为只抓字面量而非抛错", () => {
  const calls = withFixture({
    "public/panel.js": 'request("/api/plain");',
  }, (dir) => extractFrontendCalls(join(dir, "public"), { repoRoot: dir }));
  assert.ok(calls.has("/api/plain"));
});

test("extractBackendRoutes 合并同路径多方法声明", () => {
  const backend = withFixture({
    "server.mjs": [
      'if (request.method === "GET" && pathname === "/api/thing") {}',
      'if (request.method === "PUT" && pathname === "/api/thing") {}',
    ].join("\n"),
  }, (dir) => extractBackendRoutes(join(dir, "server.mjs")));
  assert.deepEqual([...backend.exact.get("/api/thing").methods].sort(), ["GET", "PUT"]);
});

test("同路径一行 test-gated 一行不是 → 整体不算 test-only", () => {
  const backend = withFixture({
    "server.mjs": [
      'if (request.method === "GET" && pathname === "/api/dual" && process.env.CONTROL_CENTER_TEST_MODE === "1") {}',
      'if (request.method === "POST" && pathname === "/api/dual") {}',
    ].join("\n"),
  }, (dir) => extractBackendRoutes(join(dir, "server.mjs")));
  assert.equal(backend.exact.get("/api/dual").testOnly, false);
});
