import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionAggregator } from "../src/sessions.mjs";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "./server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

// v3.7 codeg 对标扩源：Kimi（session_index.jsonl 索引 + state.json 元数据 + wire.jsonl turn.prompt 摘要）
// 与 Pi（jsonl 首行 {type:"session",cwd} meta，与 codex rollout 同构）按 cwd 归并进项目树。
// 格式来源：2026-07-20 本机 kimi 0.27.0 / pi v3 实测（proposals/v37-codeg-parity-design.md §2.2）。
test("projects tree merges kimi and pi sessions by cwd", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-kimipi-"));
  const repoRoot = resolve(root, "repo");
  const dataRoot = resolve(root, "data");
  const homeRoot = resolve(root, "home");
  const sharedCwd = "I:\\test\\kimipi-proj";
  const piOnlyCwd = "I:\\test\\pi-only";

  await mkdir(resolve(repoRoot, "config/control-center"), { recursive: true });
  await writeFile(resolve(repoRoot, "config/app.json"), '{"enabled":true}\n');
  await writeFile(resolve(repoRoot, "config/control-center/models.json"), JSON.stringify({
    version: 1,
    profiles: testModelProfiles(),
  }));
  await writeFile(resolve(repoRoot, "config/control-center/routing.json"), JSON.stringify({
    version: 1, primaryCoordinator: "claude-fable", technicalExecutor: "claude-fable", rules: [],
  }));
  await writeFile(resolve(repoRoot, "config/control-center/permissions.json"), JSON.stringify({
    version: 1, defaultMode: "plan",
    modes: { plan: { write: false, approvalRequired: false }, build: { write: "workspace", approvalRequired: true } },
    limits: { maxRounds: 6, maxBudgetUsdPerTurn: 2, turnTimeoutMs: 10_000 }, approval: { ttlMs: 60_000 },
  }));
  await writeFile(resolve(repoRoot, "config/control-center/sources.json"), JSON.stringify({ version: 1, explicit: [], discover: [], runtime: [] }));

  // claude 项目（与 kimi/pi 同 cwd → 三源合并进一个项目）
  await mkdir(resolve(homeRoot, ".claude/projects/I--test-kimipi-proj"), { recursive: true });
  await writeFile(
    resolve(homeRoot, ".claude/projects/I--test-kimipi-proj/aaaa1111-2222-3333-4444-555566667777.jsonl"),
    `${JSON.stringify({ cwd: sharedCwd, message: { role: "user", content: "claude 侧问题" }, timestamp: "2026-07-18T10:00:00.000Z" })}\n`,
  );

  // kimi：session_index.jsonl + sessionDir(state.json + agents/main/wire.jsonl)
  const kimiSessionId = "session_58493c99-12b8-4831-ab4c-fd2d4e556c14";
  const kimiSessionDir = resolve(homeRoot, ".kimi-code/sessions/wd_test_abc123", kimiSessionId);
  await mkdir(resolve(kimiSessionDir, "agents/main"), { recursive: true });
  await writeFile(resolve(kimiSessionDir, "state.json"), JSON.stringify({
    createdAt: "2026-07-18T22:09:45.834Z",
    updatedAt: "2026-07-19T08:00:00.000Z",
    title: "修复登录页", isCustomTitle: true,
    workDir: sharedCwd.replaceAll("\\", "/"),
  }));
  await writeFile(resolve(kimiSessionDir, "agents/main/wire.jsonl"), [
    JSON.stringify({ type: "metadata", protocol_version: "1.4" }),
    JSON.stringify({ type: "config.update", systemPrompt: "You are Kimi Code CLI..." }),
    JSON.stringify({ type: "turn.prompt", input: [{ type: "text", text: "帮我修登录页的样式问题" }], origin: { kind: "user" } }),
  ].join("\n") + "\n");
  await writeFile(resolve(homeRoot, ".kimi-code/session_index.jsonl"), `${JSON.stringify({
    sessionId: kimiSessionId,
    sessionDir: kimiSessionDir.replaceAll("\\", "/"),
    workDir: sharedCwd.replaceAll("\\", "/"),
  })}\n`);
  // 索引篡改防护样本：指向 sessions 根之外的目录必须被限根跳过。
  // evil 目录带完整 wire.jsonl——让 realpath 成功、由限根检查打回（不是靠文件缺失侥幸 404）
  const evilDir = resolve(homeRoot, "evil-outside");
  await mkdir(resolve(evilDir, "agents/main"), { recursive: true });
  await writeFile(resolve(evilDir, "state.json"), JSON.stringify({ workDir: "I:/evil", updatedAt: "2026-07-19T00:00:00Z" }));
  await writeFile(resolve(evilDir, "agents/main/wire.jsonl"), `${JSON.stringify({ type: "turn.prompt", input: [{ type: "text", text: "\u6839\u5916\u79d8\u5bc6" }], origin: { kind: "user" } })}\n`);
  await writeFile(resolve(homeRoot, ".kimi-code/session_index.jsonl"), [
    JSON.stringify({ sessionId: kimiSessionId, sessionDir: kimiSessionDir.replaceAll("\\", "/"), workDir: sharedCwd.replaceAll("\\", "/") }),
    JSON.stringify({ sessionId: "session_evil", sessionDir: evilDir.replaceAll("\\", "/"), workDir: "I:/evil" }),
  ].join("\n") + "\n");

  // pi：<cwd-slug>/<ts>_<uuid>.jsonl，首行 session meta + message 行
  const piDir = resolve(homeRoot, ".pi/agent/sessions/--I--test-pi-only--");
  await mkdir(piDir, { recursive: true });
  await writeFile(resolve(piDir, "2026-06-18T13-30-40-328Z_019edaed-3948-7b24-a860-1ae819acbd68.jsonl"), [
    JSON.stringify({ type: "session", version: 3, id: "019edaed-3948-7b24-a860-1ae819acbd68", timestamp: "2026-06-18T13:30:40.328Z", cwd: piOnlyCwd }),
    JSON.stringify({ type: "model_change", id: "d02520b6", provider: "micu", modelId: "gpt-5.5" }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "继续完善 pi 代理" }] } }),
  ].join("\n") + "\n");

  const token = "kimipi-token-0123456789abcd";
  const child = spawnTestServer({
    env: {
      CONTROL_CENTER_TOKEN: token,
      CONTROL_CENTER_REPO_ROOT: repoRoot,
      CONTROL_CENTER_DATA_DIR: dataRoot,
      CONTROL_CENTER_PORT: "0",
      USERPROFILE: homeRoot,
      HOME: homeRoot,
    },
  });
  t.after(async () => {
    await stopTestServer(child, { token });
    await rm(root, { recursive: true, force: true });
  });

  const baseUrl = new URL(await waitForUrl(child));
  const auth = { authorization: `Bearer ${token}` };

  const tree = await (await fetch(new URL("/api/sessions/projects?summaries=1", baseUrl), { headers: auth })).json();
  assert.equal(tree.available, true);

  // 1) 共享 cwd 项目：claude + kimi 双源合并
  const merged = tree.projects.find((project) => project.path && project.path.replaceAll("/", "\\").toLowerCase() === sharedCwd.toLowerCase());
  assert.ok(merged, `expected project at ${sharedCwd}, got ${JSON.stringify(tree.projects.map((p) => p.path))}`);
  const kimiSession = merged.sessions.find((session) => session.cli === "kimi");
  assert.ok(kimiSession, "kimi 会话未合并进共享项目");
  assert.equal(kimiSession.id, kimiSessionId);
  assert.equal(kimiSession.label, "修复登录页"); // 自定义标题透出
  assert.ok(kimiSession.summary?.includes("帮我修登录页"), `摘要应来自 turn.prompt：${kimiSession.summary}`);

  // 2) 索引篡改防护：sessions 根之外的条目不得出现
  const allIds = tree.projects.flatMap((project) => project.sessions.map((session) => session.id));
  assert.ok(!allIds.includes("session_evil"), "限根失效：索引指向根外目录的会话被列出了");

  // 3) pi-only cwd 合成新项目
  const piProject = tree.projects.find((project) => project.id.startsWith("pi-"));
  assert.ok(piProject, "pi 合成项目缺失");
  assert.equal(piProject.path.replaceAll("/", "\\").toLowerCase(), piOnlyCwd.toLowerCase());
  const piSession = piProject.sessions[0];
  assert.equal(piSession.cli, "pi");
  assert.equal(piSession.label, "06-18 13:30");
  assert.ok(piSession.summary?.includes("继续完善 pi 代理"), `pi 摘要：${piSession.summary}`);

  // 4) 两源只读预览（qa 状态机回归：树里能点开的行必须有预览路径）
  const kimiPreview = await (
    await fetch(new URL(`/api/sessions/preview?source=kimi&id=${encodeURIComponent(kimiSessionId)}`, baseUrl), { headers: auth })
  ).json();
  assert.equal(kimiPreview.source, "kimi");
  assert.ok(kimiPreview.messages.some((message) => message.role === "user" && message.text.includes("帮我修登录页")), JSON.stringify(kimiPreview.messages));

  const piPreview = await (
    await fetch(new URL(`/api/sessions/preview?source=pi&id=${encodeURIComponent("2026-06-18T13-30-40-328Z_019edaed-3948-7b24-a860-1ae819acbd68")}`, baseUrl), { headers: auth })
  ).json();
  assert.equal(piPreview.source, "pi");
  assert.equal(piPreview.messages.length, 1);
  assert.ok(piPreview.messages[0].text.includes("继续完善 pi 代理"));

  // 5) 不存在的 id → 404（含索引指向根外的 evil 条目）
  const missing = await fetch(new URL("/api/sessions/preview?source=kimi&id=session_evil", baseUrl), { headers: auth });
  assert.equal(missing.status, 422); // evil 条目 realpath 在根外 → VALIDATION_FAILED fail-closed
});

test("large Kimi index keeps only per-cwd top-k while preserving exact counts and summaries", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(appRoot, ".test-kimi-large-"));
  const homeRoot = resolve(root, "home");
  const sessionsRoot = resolve(homeRoot, ".kimi-code/sessions/wd_large");
  const workDirForward = "C:/Work/Kimi-Large/";
  const workDirBackslash = "c:\\work\\kimi-large";
  const bucketCount = 32;
  const indexCount = 2048;
  const perProjectLimit = 5;

  try {
    const dirs = Array.from({ length: bucketCount }, (_, bucket) => resolve(sessionsRoot, `bucket-${bucket}`));
    for (let offset = 0; offset < dirs.length; offset += 8) {
      await Promise.all(dirs.slice(offset, offset + 8).map(async (sessionDir, relativeIndex) => {
        const bucket = offset + relativeIndex;
        await mkdir(resolve(sessionDir, "agents/main"), { recursive: true });
        await Promise.all([
          writeFile(resolve(sessionDir, "state.json"), JSON.stringify({
            updatedAt: new Date(Date.UTC(2026, 6, 1, 0, bucket)).toISOString(),
            isCustomTitle: true,
            title: `bucket-${bucket}`,
          })),
          writeFile(resolve(sessionDir, "agents/main/wire.jsonl"), `${JSON.stringify({
            type: "turn.prompt",
            input: [{ type: "text", text: `summary bucket ${bucket}` }],
            origin: { kind: "user" },
          })}\n`),
        ]);
      }));
    }

    const indexLines = Array.from({ length: indexCount }, (_, index) => {
      const bucket = index % bucketCount;
      return JSON.stringify({
        sessionId: `session_${String(index).padStart(5, "0")}`,
        sessionDir: dirs[bucket],
        workDir: index % 2 === 0 ? workDirForward : workDirBackslash,
      });
    });
    await mkdir(resolve(homeRoot, ".kimi-code"), { recursive: true });
    await writeFile(resolve(homeRoot, ".kimi-code/session_index.jsonl"), `${indexLines.join("\n")}\n`);

    const result = await new SessionAggregator({
      aiSharedRoot: resolve(root, ".ai-shared"),
      home: homeRoot,
      projectSnapshotTtlMs: 0,
    }).projects({ perProjectLimit, includeSummaries: true });
    const kimiStatus = result.sources.find((source) => source.source === "kimi");
    const project = result.projects.find((candidate) => candidate.sessions.some((session) => session.cli === "kimi"));

    assert.equal(kimiStatus?.available, true);
    assert.equal(kimiStatus?.sessionCount, indexCount, `source count must include entries discarded from top-k memory: ${JSON.stringify(kimiStatus?.diagnostics)}`);
    assert.equal(project?.sessionCount, indexCount, "project count must remain exact after bounded retention");
    assert.equal(project?.sessions.length, perProjectLimit, "only perProjectLimit Kimi sessions may be retained for one cwd");
    assert.deepEqual(
      project.sessions.map((session) => session.id),
      [31, 63, 95, 127, 159].map((index) => `session_${String(index).padStart(5, "0")}`),
      "top-k must be newest-first and stable for equal timestamps",
    );
    assert.ok(project.sessions.every((session) => session.label === "bucket-31"));
    assert.ok(project.sessions.every((session) => session.summary?.includes("summary bucket 31")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
