import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObservabilityService } from "../src/observability.mjs";
import { SessionAggregator } from "../src/sessions.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cc-obs-"));
  const aiShared = join(root, ".ai-shared");
  await mkdir(join(aiShared, "handoff"), { recursive: true });
  return { root, aiShared };
}

test("routeGate parses TSV rows and drops the truncated first line on tail reads", async () => {
  const { root, aiShared } = await fixture();
  try {
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const lines = [
      "GARBAGE-TRUNCATED-HALF-ROW-no-tabs",
      `${now}\tRED\treview,security\t?\t评审安全改动`,
      `${now}\tgray\t-\t?\t普通问答`,
    ];
    await writeFile(join(aiShared, "route-gate.log"), lines.join("\n") + "\n", "utf8");
    const svc = new ObservabilityService({ aiSharedRoot: aiShared, repoRoot: root });
    const result = await svc.routeGate();
    assert.equal(result.available, true);
    assert.equal(result.red, 1);
    assert.equal(result.gray, 1);
    assert.equal(result.byReason.review, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("routeGate normalizes summoned to yes/no/unknown and keeps legacy three-column rows", async () => {
  const { root, aiShared } = await fixture();
  try {
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const legacyPrompt = "旧格式提示\t内含 TAB\t仍须完整保留";
    const lines = [
      `${now}\tRED\t${legacyPrompt}`,
      `${now}\tRED\treview\tTRUE\t已召唤`,
      `${now}\tRED\tsecurity\t0\t未召唤`,
      `${now}\tRED\tarchitecture\t?\t待对账`,
    ];
    await writeFile(join(aiShared, "route-gate.log"), lines.join("\n") + "\n", "utf8");
    const svc = new ObservabilityService({ aiSharedRoot: aiShared, repoRoot: root });
    const result = await svc.routeGate();

    assert.deepEqual(result.summoned, { yes: 1, no: 1, unknown: 2 });
    const legacy = result.recent.find((row) => row.prompt === legacyPrompt);
    assert.deepEqual(
      { reason: legacy?.reason, summoned: legacy?.summoned },
      { reason: "-", summoned: "unknown" },
      "旧三列日志的提示不得被错当 reason，缺失召唤证据必须标 unknown",
    );
    assert.equal(result.recent.find((row) => row.prompt === "已召唤")?.summoned, "yes");
    assert.equal(result.recent.find((row) => row.prompt === "未召唤")?.summoned, "no");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pulse counts summoned states across the full window and never reports unknown as zero", async () => {
  const { root, aiShared } = await fixture();
  try {
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const rows = [
      `${now}\tRED\treview\tno\t窗口内较早的未召唤`,
      ...Array.from({ length: 5 }, (_, index) => `${now}\tRED\treview\tyes\t较新的已召唤 ${index}`),
    ];
    await writeFile(join(aiShared, "route-gate.log"), rows.join("\n") + "\n", "utf8");
    const svc = new ObservabilityService({ aiSharedRoot: aiShared, repoRoot: root });
    const pulse = await svc.pulse();
    assert.equal(pulse.routeGate.red, 6);
    assert.equal(pulse.routeGate.redUnsummoned, 1, "不能只检查 recent=5 而漏掉窗口内较早的 no");
    assert.deepEqual(pulse.routeGate.summoned, { yes: 5, no: 1, unknown: 0 });

    await writeFile(join(aiShared, "route-gate.log"), `${now}\tRED\treview\t?\t尚未对账\n`, "utf8");
    const unresolved = await svc.pulse();
    assert.equal(unresolved.routeGate.redUnsummoned, null, "unknown 不能伪装成已确认的 0 次未召唤");
    assert.deepEqual(unresolved.routeGate.summoned, { yes: 0, no: 0, unknown: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deltaLedger double-scans decisions.md and handoff with score buckets", async () => {
  const { root, aiShared } = await fixture();
  try {
    await writeFile(join(aiShared, "decisions.md"), "prose\n__DELTA__: 烛 | 2 | 推翻主驾\nmore\n", "utf8");
    await writeFile(join(aiShared, "handoff", "codex-to-claude__x__1.md"), "body\n__DELTA__: 织 | 0 | 白发\n", "utf8");
    const svc = new ObservabilityService({ aiSharedRoot: aiShared, repoRoot: root });
    const ledger = await svc.deltaLedger();
    assert.equal(ledger.total, 2);
    assert.equal(ledger.byScore[2], 1);
    assert.equal(ledger.byScore[0], 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strict settlement observability reads fail closed when governance sources are missing", async () => {
  const { root, aiShared } = await fixture();
  try {
    const svc = new ObservabilityService({ aiSharedRoot: aiShared, repoRoot: root });
    await assert.rejects(() => svc.deltaLedger({ strict: true }), { code: "OBSERVABILITY_DECISIONS_UNAVAILABLE" });
    await rm(join(aiShared, "handoff"), { recursive: true, force: true });
    await assert.rejects(() => svc.handoffs({ strict: true }), { code: "OBSERVABILITY_HANDOFF_ROOT_UNAVAILABLE" });
    // 普通观测面板仍保留历史宽松语义，不把缺失源变成全局崩溃。
    assert.deepEqual((await svc.deltaLedger()).deltas, []);
    assert.deepEqual(await svc.handoffs(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("handoffContent rejects traversal and non-md names", async () => {
  const { root, aiShared } = await fixture();
  try {
    await writeFile(join(aiShared, "handoff", "ok.md"), "hello", "utf8");
    const svc = new ObservabilityService({ aiSharedRoot: aiShared, repoRoot: root });
    assert.equal((await svc.handoffContent("ok.md")).content, "hello");
    await assert.rejects(() => svc.handoffContent("../secret.md"), { code: "VALIDATION_FAILED" });
    await assert.rejects(() => svc.handoffContent("ok.txt"), { code: "VALIDATION_FAILED" });
    await assert.rejects(() => svc.handoffContent("missing.md"), { code: "SOURCE_NOT_FOUND" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("summaries are omitted by default and only appear with opt-in", async () => {
  const { root, aiShared } = await fixture();
  const home = join(root, "home");
  try {
    const projectDir = join(home, ".claude", "projects", "demo");
    await mkdir(projectDir, { recursive: true });
    const event = { message: { role: "user", content: "普通任务描述" } };
    await writeFile(join(projectDir, "s.jsonl"), JSON.stringify(event) + "\n", "utf8");
    const agg = new SessionAggregator({ aiSharedRoot: aiShared, home });
    const off = (await agg.list()).sources.find((item) => item.source === "claude");
    assert.equal(off.sessions[0].summary, null, "summary must be null without opt-in");
    const on = (await agg.list({ includeSummaries: true })).sources.find((item) => item.source === "claude");
    assert.equal(on.sessions[0].summary, "普通任务描述");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opt-in summaries redact both high-entropy and assignment-style secrets", async () => {
  const { root, aiShared } = await fixture();
  const home = join(root, "home");
  try {
    const projectDir = join(home, ".claude", "projects", "demo");
    await mkdir(projectDir, { recursive: true });
    const highEntropy = "sk-proj-ABCDEFGHIJKLMNOP1234567890"; // gitleaks:allow 测试夹具：顺序字母+数字的合成串，非真实凭据
    const assignment = "MyCompanySecret1234";
    const event = { message: { role: "user", content: `key ${highEntropy} 且 password=${assignment} 还有 token: abcdefghijklmnop` } };
    await writeFile(join(projectDir, "s.jsonl"), JSON.stringify(event) + "\n", "utf8");
    const agg = new SessionAggregator({ aiSharedRoot: aiShared, home });
    const claude = (await agg.list({ includeSummaries: true })).sources.find((item) => item.source === "claude");
    const summary = claude.sessions[0]?.summary ?? "";
    assert.ok(!summary.includes(highEntropy), "high-entropy secret must be redacted");
    assert.ok(!summary.includes(assignment), "assignment-style secret must be redacted");
    assert.ok(!summary.includes("abcdefghijklmnop"), "assignment token value must be redacted");
    assert.ok(summary.includes("[REDACTED]"), "redaction marker present");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("handoffContent rejects a symlink that escapes the handoff root", async (t) => {
  const { root, aiShared } = await fixture();
  try {
    const outside = join(root, "outside-secret.md");
    await writeFile(outside, "SENSITIVE OUTSIDE CONTENT", "utf8");
    let symlinkWorks = true;
    try {
      await symlink(outside, join(aiShared, "handoff", "escape.md"));
    } catch {
      symlinkWorks = false;
    }
    if (!symlinkWorks) return t.skip("symlink 无权限（Windows 非 Developer Mode）——显式跳过而非假通过"); // 烛 R7
    const svc = new ObservabilityService({ aiSharedRoot: aiShared, repoRoot: root });
    await assert.rejects(() => svc.handoffContent("escape.md"), { code: "VALIDATION_FAILED" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tailText drops the truncated first line on large files (start>0 branch)", async () => {
  const { root, aiShared } = await fixture();
  try {
    // 首行超过 256KB 尾读窗口 → start>0，首行必被截断，routeGate 应只见完整的 RED 行
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const hugeFirst = "X".repeat(300 * 1024);
    const content = `${hugeFirst}\n${now}\tRED\treview\t?\t真实评审\n`;
    await writeFile(join(aiShared, "route-gate.log"), content, "utf8");
    const svc = new ObservabilityService({ aiSharedRoot: aiShared, repoRoot: root });
    const result = await svc.routeGate();
    assert.equal(result.red, 1, "the complete RED row survives");
    assert.equal(result.total, 1, "the truncated huge first line is discarded, not miscounted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function projectFixture(home, dirName, files) {
  const projectDir = join(home, ".claude", "projects", dirName);
  await mkdir(projectDir, { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    await writeFile(join(projectDir, name), lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  }
  return projectDir;
}

test("projects groups sessions per project, restores cwd label and sorts by recency", async () => {
  const { root, aiShared } = await fixture();
  const home = join(root, "home");
  try {
    await projectFixture(home, "I--demo-alpha", {
      "s1.jsonl": [{ type: "user", cwd: "I:\\demo\\alpha", message: { role: "user", content: "旧项目任务" } }],
    });
    await projectFixture(home, "I--demo-beta", {
      "s2.jsonl": [{ type: "user", cwd: "I:\\demo\\beta", message: { role: "user", content: "新项目任务" } }],
    });
    // beta 更新（写入顺序已保证 beta 的 mtime >= alpha；再显式触碰确保排序确定）
    const { utimes } = await import("node:fs/promises");
    const now = Date.now();
    await utimes(join(home, ".claude", "projects", "I--demo-alpha", "s1.jsonl"), new Date(now - 60_000), new Date(now - 60_000));
    await utimes(join(home, ".claude", "projects", "I--demo-beta", "s2.jsonl"), new Date(now), new Date(now));
    const agg = new SessionAggregator({ aiSharedRoot: aiShared, home });
    const result = await agg.projects({ includeSummaries: true });
    assert.equal(result.available, true);
    assert.equal(result.projects.length, 2);
    assert.equal(result.projects[0].label, "beta", "newest project first, label from cwd basename");
    assert.equal(result.projects[0].path, "I:\\demo\\beta");
    assert.equal(result.projects[1].label, "alpha");
    assert.equal(result.projects[0].sessions[0].summary, "新项目任务");
    const noSummaries = await agg.projects();
    assert.equal(noSummaries.projects[0].sessions[0].summary, null, "summaries stay opt-in");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex activity updates an existing project's recency before private fields are stripped", async () => {
  const { root, aiShared } = await fixture();
  const home = join(root, "home");
  try {
    const alphaFile = join(home, ".claude", "projects", "I--demo-alpha", "alpha.jsonl");
    const betaFile = join(home, ".claude", "projects", "I--demo-beta", "beta.jsonl");
    await projectFixture(home, "I--demo-alpha", {
      "alpha.jsonl": [{ cwd: "I:\\demo\\alpha", message: { role: "user", content: "alpha old" } }],
    });
    await projectFixture(home, "I--demo-beta", {
      "beta.jsonl": [{ cwd: "I:\\demo\\beta", message: { role: "user", content: "beta middle" } }],
    });
    const codexDir = join(home, ".codex", "sessions", "2026", "07", "21");
    const codexFile = join(codexDir, "rollout-2026-07-21T20-00-00-alpha.jsonl");
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      codexFile,
      `${JSON.stringify({ type: "session_meta", payload: { cwd: "I:\\demo\\alpha" } })}\n`,
      "utf8",
    );
    const { utimes } = await import("node:fs/promises");
    const now = Date.now();
    await utimes(alphaFile, new Date(now - 120_000), new Date(now - 120_000));
    await utimes(betaFile, new Date(now - 60_000), new Date(now - 60_000));
    await utimes(codexFile, new Date(now), new Date(now));

    const result = await new SessionAggregator({ aiSharedRoot: aiShared, home }).projects();
    assert.equal(result.projects[0]?.path, "I:\\demo\\alpha", "最新 Codex 活动应把 alpha 项目排到 beta 前面");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("projects falls back to directory name without cwd and honours perProjectLimit", async () => {
  const { root, aiShared } = await fixture();
  const home = join(root, "home");
  try {
    const files = {};
    for (let i = 0; i < 5; i += 1) files[`s${i}.jsonl`] = [{ message: { role: "user", content: `任务 ${i}` } }];
    await projectFixture(home, "no-cwd-project", files);
    const agg = new SessionAggregator({ aiSharedRoot: aiShared, home });
    const result = await agg.projects({ perProjectLimit: 3 });
    assert.equal(result.projects[0].label, "no-cwd-project");
    assert.equal(result.projects[0].path, null);
    assert.equal(result.projects[0].sessionCount, 5, "sessionCount reflects all files");
    assert.equal(result.projects[0].sessions.length, 3, "listed sessions capped by perProjectLimit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("projects coalesces identical scans, isolates cached snapshots, and refresh bypasses stale work", async () => {
  const { root, aiShared } = await fixture();
  const home = join(root, "home");
  let releaseFirst;
  const firstScanGate = new Promise((resolveGate) => { releaseFirst = resolveGate; });
  let scans = 0;
  try {
    const projectDir = await projectFixture(home, "cache-demo", {
      "first.jsonl": [{ cwd: "I:\\demo\\cache", message: { role: "user", content: "first" } }],
    });
    const agg = new SessionAggregator({
      aiSharedRoot: aiShared,
      home,
      projectSnapshotTtlMs: 10_000,
      onProjectScan: async () => {
        scans += 1;
        if (scans === 1) await firstScanGate;
      },
    });

    const firstPending = agg.projects({ perProjectLimit: 10 });
    const secondPending = agg.projects({ perProjectLimit: 10 });
    await new Promise((resolveTick) => setImmediate(resolveTick));
    assert.equal(scans, 1, "identical concurrent calls share one filesystem scan");
    releaseFirst();
    const [first, second] = await Promise.all([firstPending, secondPending]);
    assert.deepEqual(first, second);

    first.projects[0].label = "caller-mutated";
    const cached = await agg.projects({ perProjectLimit: 10 });
    assert.equal(scans, 1, "cache hit avoids a second scan");
    assert.equal(cached.projects[0].label, "cache", "callers receive detached cache clones");

    await writeFile(join(projectDir, "second.jsonl"), `${JSON.stringify({ cwd: "I:\\demo\\cache", message: { role: "user", content: "second" } })}\n`, "utf8");
    const [freshA, freshB] = await Promise.all([
      agg.projects({ perProjectLimit: 10, refresh: true }),
      agg.projects({ perProjectLimit: 10, refresh: true }),
    ]);
    assert.equal(scans, 2, "concurrent forced refreshes share their own fresh scan");
    assert.equal(freshA.projects[0].sessionCount, 2);
    assert.deepEqual(freshA, freshB);

    await agg.projects({ perProjectLimit: 10, includeSummaries: true });
    assert.equal(scans, 3, "summary mode has an independent snapshot key");

    let ttlScans = 0;
    const expiring = new SessionAggregator({
      aiSharedRoot: aiShared,
      home,
      projectSnapshotTtlMs: 5,
      onProjectScan: () => { ttlScans += 1; },
    });
    await expiring.projects();
    await expiring.projects();
    assert.equal(ttlScans, 1);
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 15));
    await expiring.projects();
    assert.equal(ttlScans, 2, "expired snapshots are rescanned rather than retained indefinitely");

    let attempts = 0;
    const retrying = new SessionAggregator({
      aiSharedRoot: aiShared,
      home,
      projectSnapshotTtlMs: 10_000,
      onProjectScan: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("injected scan failure");
      },
    });
    await assert.rejects(() => retrying.projects(), /injected scan failure/);
    assert.equal((await retrying.projects()).projects[0].sessionCount, 2);
    assert.equal(attempts, 2, "failed scans are removed from inflight and never cached");

    let activeScans = 0;
    let maxActiveScans = 0;
    let scanNumber = 0;
    let markFirstComplete;
    let releaseFirstComplete;
    const firstComplete = new Promise((resolveComplete) => { markFirstComplete = resolveComplete; });
    const holdFirstCompletion = new Promise((resolveRelease) => { releaseFirstComplete = resolveRelease; });
    const serialRefresh = new SessionAggregator({
      aiSharedRoot: aiShared,
      home,
      projectSnapshotTtlMs: 10_000,
      onProjectScan: () => {
        scanNumber += 1;
        activeScans += 1;
        maxActiveScans = Math.max(maxActiveScans, activeScans);
      },
      onProjectScanComplete: async () => {
        activeScans -= 1;
        if (scanNumber === 1) {
          markFirstComplete();
          await holdFirstCompletion;
        }
      },
    });
    const normalPending = serialRefresh.projects();
    await firstComplete;
    await writeFile(join(projectDir, "third.jsonl"), `${JSON.stringify({ cwd: "I:\\demo\\cache", message: { role: "user", content: "third" } })}\n`, "utf8");
    const forcedPending = serialRefresh.projects({ refresh: true });
    await new Promise((resolveTick) => setImmediate(resolveTick));
    assert.equal(scanNumber, 1, "forced refresh waits for an in-flight normal scan instead of competing for disk");
    releaseFirstComplete();
    const [normalResult, forcedResult] = await Promise.all([normalPending, forcedPending]);
    assert.equal(normalResult.projects[0].sessionCount, 2);
    assert.equal(forcedResult.projects[0].sessionCount, 3, "forced refresh rescans after the prior snapshot and sees newer disk state");
    assert.equal(scanNumber, 2);
    assert.equal(maxActiveScans, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project scans serialize globally across summary and limit cache keys", async () => {
  const { root, aiShared } = await fixture();
  const home = join(root, "home");
  let releaseFirst;
  let markFirstStarted;
  const firstGate = new Promise((resolveGate) => { releaseFirst = resolveGate; });
  const firstStarted = new Promise((resolveStarted) => { markFirstStarted = resolveStarted; });
  let scans = 0;
  let activeScans = 0;
  let maxActiveScans = 0;
  try {
    const projectDir = await projectFixture(home, "global-serial", {
      "first.jsonl": [{ cwd: "I:\\demo\\global-serial", message: { role: "user", content: "first" } }],
      "second.jsonl": [{ cwd: "I:\\demo\\global-serial", message: { role: "user", content: "second" } }],
    });
    const agg = new SessionAggregator({
      aiSharedRoot: aiShared,
      home,
      projectSnapshotTtlMs: 10_000,
      onProjectScan: async () => {
        scans += 1;
        activeScans += 1;
        maxActiveScans = Math.max(maxActiveScans, activeScans);
        if (scans === 1) {
          markFirstStarted();
          await firstGate;
        }
      },
      onProjectScanComplete: () => { activeScans -= 1; },
    });

    const metadataOnly = agg.projects({ perProjectLimit: 1, includeSummaries: false });
    await firstStarted;
    const withSummaries = agg.projects({ perProjectLimit: 2, includeSummaries: true });
    await new Promise((resolveTick) => setImmediate(resolveTick));
    assert.equal(scans, 1, "different cache keys must not walk the same projects tree concurrently");
    releaseFirst();
    const [metadataResult, summaryResult] = await Promise.all([metadataOnly, withSummaries]);
    assert.equal(scans, 2);
    assert.equal(maxActiveScans, 1);
    assert.equal(metadataResult.projects[0].sessions.length, 1);
    assert.equal(summaryResult.projects[0].sessions.length, 2);
    assert.equal(summaryResult.includeSummaries, true);

    await writeFile(join(projectDir, "third.jsonl"), `${JSON.stringify({ cwd: "I:\\demo\\global-serial", message: { role: "user", content: "third" } })}\n`, "utf8");
    const refreshedMetadata = await agg.projects({ perProjectLimit: 1, includeSummaries: false, refresh: true });
    assert.equal(refreshedMetadata.projects[0].sessionCount, 3);
    const refreshedSummaries = await agg.projects({ perProjectLimit: 2, includeSummaries: true });
    assert.equal(scans, 4, "forced refresh invalidates cached projections for every summary/limit key");
    assert.equal(refreshedSummaries.projects[0].sessionCount, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a refresh epoch prevents other keys from joining pre-refresh inflight scans", async () => {
  const { root, aiShared } = await fixture();
  const home = join(root, "home");
  let markOldComplete;
  let releaseOldComplete;
  const oldComplete = new Promise((resolveComplete) => { markOldComplete = resolveComplete; });
  const oldCompleteGate = new Promise((resolveGate) => { releaseOldComplete = resolveGate; });
  let scans = 0;
  try {
    const projectDir = await projectFixture(home, "refresh-epoch", {
      "first.jsonl": [{ cwd: "I:\\demo\\refresh-epoch", message: { role: "user", content: "first" } }],
    });
    const agg = new SessionAggregator({
      aiSharedRoot: aiShared,
      home,
      projectSnapshotTtlMs: 10_000,
      onProjectScan: () => { scans += 1; },
      onProjectScanComplete: async () => {
        if (scans === 1) {
          markOldComplete();
          await oldCompleteGate;
        }
      },
    });

    const oldSummary = agg.projects({ includeSummaries: true });
    await oldComplete;
    await writeFile(join(projectDir, "second.jsonl"), `${JSON.stringify({ cwd: "I:\\demo\\refresh-epoch", message: { role: "user", content: "second" } })}\n`, "utf8");
    const forcedMetadata = agg.projects({ includeSummaries: false, refresh: true });
    const laterSummary = agg.projects({ includeSummaries: true });
    releaseOldComplete();

    const [oldResult, forcedResult, laterResult] = await Promise.all([oldSummary, forcedMetadata, laterSummary]);
    assert.equal(oldResult.projects[0].sessionCount, 1);
    assert.equal(forcedResult.projects[0].sessionCount, 2);
    assert.equal(laterResult.projects[0].sessionCount, 2, "post-refresh callers cannot join a stale other-key inflight");
    assert.equal(scans, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preview rejects traversal names, reserved device names and missing sessions", async () => {
  const { root, aiShared } = await fixture();
  const home = join(root, "home");
  try {
    await projectFixture(home, "demo", { "ok.jsonl": [{ message: { role: "user", content: "hi" } }] });
    const agg = new SessionAggregator({ aiSharedRoot: aiShared, home });
    await assert.rejects(() => agg.preview({ project: "..", id: "ok" }), { code: "VALIDATION_FAILED" });
    await assert.rejects(() => agg.preview({ project: "demo", id: "../../secret" }), { code: "VALIDATION_FAILED" });
    await assert.rejects(() => agg.preview({ project: "demo", id: "CON" }), { code: "VALIDATION_FAILED" });
    await assert.rejects(() => agg.preview({ project: "NUL", id: "ok" }), { code: "VALIDATION_FAILED" });
    await assert.rejects(() => agg.preview({ project: "demo", id: "trailing." }), { code: "VALIDATION_FAILED" });
    await assert.rejects(() => agg.preview({ project: "demo", id: "missing" }), { code: "SOURCE_NOT_FOUND" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("projects listing excludes symlinked sessions that escape the projects root", async (t) => {
  const { root, aiShared } = await fixture();
  const home = join(root, "home");
  try {
    await projectFixture(home, "demo", { "ok.jsonl": [{ message: { role: "user", content: "正常会话" } }] });
    const outside = join(root, "outside.jsonl");
    await writeFile(outside, JSON.stringify({ cwd: "X:\\secret", message: { role: "user", content: "根外内容" } }) + "\n", "utf8");
    let symlinkWorks = true;
    try {
      await symlink(outside, join(home, ".claude", "projects", "demo", "escape.jsonl"));
    } catch {
      symlinkWorks = false;
    }
    if (!symlinkWorks) return t.skip("symlink 无权限（Windows 非 Developer Mode）——显式跳过而非假通过"); // 烛 R7
    const agg = new SessionAggregator({ aiSharedRoot: aiShared, home });
    const grouped = await agg.projects({ includeSummaries: true });
    const ids = grouped.projects[0].sessions.map((session) => session.id);
    assert.ok(!ids.includes("escape"), "escaping symlink session is not listed");
    assert.ok(!JSON.stringify(grouped).includes("根外内容"), "escaping symlink content never read");
    const flat = (await agg.list({ includeSummaries: true })).sources.find((item) => item.source === "claude");
    assert.ok(!flat.sessions.some((session) => session.id === "escape"), "flat claude list applies the same containment");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preview rejects a session symlink that escapes the projects root", async (t) => {
  const { root, aiShared } = await fixture();
  const home = join(root, "home");
  try {
    await projectFixture(home, "demo", { "ok.jsonl": [{ message: { role: "user", content: "hi" } }] });
    const outside = join(root, "outside.jsonl");
    await writeFile(outside, JSON.stringify({ message: { role: "user", content: "SENSITIVE" } }) + "\n", "utf8");
    let symlinkWorks = true;
    try {
      await symlink(outside, join(home, ".claude", "projects", "demo", "escape.jsonl"));
    } catch {
      symlinkWorks = false;
    }
    if (!symlinkWorks) return t.skip("symlink 无权限（Windows 非 Developer Mode）——显式跳过而非假通过"); // 烛 R7
    const agg = new SessionAggregator({ aiSharedRoot: aiShared, home });
    await assert.rejects(() => agg.preview({ project: "demo", id: "escape" }), { code: "VALIDATION_FAILED" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("summary scan skips an oversized first line and still finds the real user text", async () => {
  const { root, aiShared } = await fixture();
  const home = join(root, "home");
  try {
    const projectDir = join(home, ".claude", "projects", "demo");
    await mkdir(projectDir, { recursive: true });
    // 首行 >2MB 单行大事件（烛 R5 实测本机存在 522KB 单行）——固定窗口读法在这里必然扫空
    const hugeLine = JSON.stringify({ type: "big", blob: "X".repeat(2 * 1024 * 1024 + 100) });
    const realLine = JSON.stringify({ message: { role: "user", content: "真实任务描述" } });
    await writeFile(join(projectDir, "s.jsonl"), `${hugeLine}\n${realLine}\n`, "utf8");
    const agg = new SessionAggregator({ aiSharedRoot: aiShared, home });
    const grouped = await agg.projects({ includeSummaries: true });
    assert.equal(grouped.projects[0].sessions[0].summary, "真实任务描述");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preview returns scrubbed user/assistant text and skips tool rows and sidechains", async () => {
  const { root, aiShared } = await fixture();
  const home = join(root, "home");
  try {
    await projectFixture(home, "demo", {
      "conv.jsonl": [
        { type: "mode", mode: "normal" },
        { message: { role: "user", content: "帮我修 bug，password=TopSecret99" }, timestamp: "2026-07-17T01:00:00Z" },
        { message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] } },
        { message: { role: "user", content: [{ type: "tool_result", content: "sk-proj-SECRETSECRETSECRET123456" }] } },
        { isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "侧链内容不应出现" }] } },
        { message: { role: "assistant", content: [{ type: "text", text: "已修复，token: abcdef123456789012" }] }, timestamp: "2026-07-17T01:01:00Z" },
      ],
    });
    const agg = new SessionAggregator({ aiSharedRoot: aiShared, home });
    const result = await agg.preview({ project: "demo", id: "conv" });
    assert.equal(result.messages.length, 2, "only textual user/assistant rows survive");
    assert.equal(result.messages[0].role, "user");
    assert.ok(!result.messages[0].text.includes("TopSecret99"), "assignment secret scrubbed");
    assert.ok(!result.messages[1].text.includes("abcdef123456789012"), "token value scrubbed");
    assert.ok(!JSON.stringify(result).includes("侧链内容不应出现"), "sidechain rows excluded");
    assert.ok(!JSON.stringify(result).includes("sk-proj-SECRETSECRETSECRET123456"), "tool_result content never leaves the server");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("summaries and preview skip local-command caveat wrappers and meta rows", async () => {
  const { root, aiShared } = await fixture();
  const home = join(root, "home");
  try {
    const caveat =
      "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>\n<command-name>/clear</command-name>";
    await projectFixture(home, "demo", {
      "conv.jsonl": [
        { message: { role: "user", content: caveat } },
        { isMeta: true, message: { role: "user", content: "命令回显不算" } },
        { message: { role: "user", content: `<system-reminder>背景提示</system-reminder>继续完善协作台` } },
      ],
    });
    const agg = new SessionAggregator({ aiSharedRoot: aiShared, home });
    const grouped = await agg.projects({ includeSummaries: true });
    assert.equal(grouped.projects[0].sessions[0].summary, "继续完善协作台", "wrapper-only rows skipped, wrappers stripped");
    const preview = await agg.preview({ project: "demo", id: "conv" });
    assert.equal(preview.messages.length, 1, "caveat-only and meta rows excluded from preview");
    assert.equal(preview.messages[0].text, "继续完善协作台");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preview caps message count and marks truncation", async () => {
  const { root, aiShared } = await fixture();
  const home = join(root, "home");
  try {
    const lines = Array.from({ length: 80 }, (_, i) => ({ message: { role: "user", content: `消息 ${i}` } }));
    await projectFixture(home, "demo", { "long.jsonl": lines });
    const agg = new SessionAggregator({ aiSharedRoot: aiShared, home });
    const result = await agg.preview({ project: "demo", id: "long", maxMessages: 10 });
    assert.equal(result.messages.length, 10);
    assert.equal(result.messages.at(-1).text, "消息 79", "keeps the newest messages");
    assert.equal(result.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex rollout payload.role/content shape yields a summary", async () => {
  const { root, aiShared } = await fixture();
  const home = join(root, "home");
  try {
    const sessionsDir = join(home, ".codex", "sessions", "2026", "07");
    await mkdir(sessionsDir, { recursive: true });
    const event = { payload: { role: "user", content: "帮我评审这段代码" } };
    await writeFile(join(sessionsDir, "rollout-abc.jsonl"), JSON.stringify(event) + "\n", "utf8");
    const agg = new SessionAggregator({ aiSharedRoot: aiShared, home });
    const { sources } = await agg.list({ includeSummaries: true });
    const codex = sources.find((item) => item.source === "codex");
    assert.equal(codex.available, true);
    assert.equal(codex.sessions[0]?.summary, "帮我评审这段代码");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex recursive scan selects the true newest files after enumerating every directory", async () => {
  const { root, aiShared } = await fixture();
  const home = join(root, "home");
  try {
    const oldDir = join(home, ".codex", "sessions", "00-old");
    const newestDir = join(home, ".codex", "sessions", "zz-newest");
    await mkdir(oldDir, { recursive: true });
    await mkdir(newestDir, { recursive: true });
    const { utimes } = await import("node:fs/promises");
    const now = Date.now();
    for (let index = 0; index < 12; index += 1) {
      const path = join(oldDir, `old-${String(index).padStart(2, "0")}.jsonl`);
      await writeFile(path, "{}\n", "utf8");
      await utimes(path, new Date(now - 120_000 - index), new Date(now - 120_000 - index));
    }
    const newest = join(newestDir, "true-newest.jsonl");
    await writeFile(newest, "{}\n", "utf8");
    await utimes(newest, new Date(now), new Date(now));

    const result = await new SessionAggregator({ aiSharedRoot: aiShared, home }).list({ limitPerSource: 2 });
    const codex = result.sources.find((source) => source.source === "codex");
    assert.equal(codex.sessions.length, 2);
    assert.equal(codex.sessions[0]?.id, "true-newest", "目录遍历顺序不得在 mtime 排序前淘汰真正最新文件");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
