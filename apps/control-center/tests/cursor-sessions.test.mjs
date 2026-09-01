import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
import { SessionAggregator } from "../src/sessions.mjs";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "./server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

// 造一个假的 Cursor state.vscdb：ItemTable（composer.composerHeaders 权威列表）+
// cursorDiskKV（composerData:<id> 消息头 + bubbleId:<id>:<bubbleId> 单条消息）。
// 表结构对齐 2026-07-20 本机实测（key TEXT PRIMARY KEY, value BLOB）。
function buildCursorDb(dbPath, { composers, includeHeadersKey = true, headersRaw = null, composerData = {}, bubbles = {} }) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)");
    if (includeHeadersKey) {
      const value = headersRaw ?? JSON.stringify({ allComposers: composers });
      db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("composer.composerHeaders", value);
    }
    for (const [composerId, headers] of Object.entries(composerData)) {
      db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(`composerData:${composerId}`, JSON.stringify({ fullConversationHeadersOnly: headers }));
    }
    for (const [key, bubble] of Object.entries(bubbles)) {
      db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(key, JSON.stringify(bubble));
    }
  } finally {
    db.close();
  }
}

const SHARED_ID = "aaaa1111-2222-4333-8444-555566667777";
const ONLY_ID = "bbbb2222-3333-4444-8555-666677778888";
const ARCHIVED_ID = "cccc3333-4444-4555-8666-777788889999";
const DRAFT_ID = "dddd4444-5555-4666-8777-888899990000";
const B = (n) => `b0000000-0000-4000-8000-00000000000${n}`;

// v3.7 codeg 对标 P2：Cursor 编辑器历史会话（state.vscdb 只读）按 cwd 归并进项目树。
// 格式来源：2026-07-20 本机 globalStorage 实测（composerHeaders 91 条 / composerData + bubbleId 点查）。
test("projects tree merges cursor sessions by cwd with archived/draft filtered", { timeout: 60_000, skip: !DatabaseSync }, async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-cursor-"));
  const repoRoot = resolve(root, "repo");
  const dataRoot = resolve(root, "data");
  const homeRoot = resolve(root, "home");
  const sharedCwd = "I:\\test\\cursor-proj";
  const cursorOnlyCwd = "I:\\test\\cursor-only";

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

  // claude 项目（与 cursor 共享 cwd → 双源合并进一个项目）
  await mkdir(resolve(homeRoot, ".claude/projects/I--test-cursor-proj"), { recursive: true });
  await writeFile(
    resolve(homeRoot, ".claude/projects/I--test-cursor-proj/eeee5555-6666-4777-8888-999900001111.jsonl"),
    `${JSON.stringify({ cwd: sharedCwd, message: { role: "user", content: "claude 侧问题" }, timestamp: "2026-07-18T10:00:00.000Z" })}\n`,
  );

  // cursor：fake vscdb（fsPath 用小写盘符，验证归一化后与 claude cwd 命中同一项目）
  const storageDir = resolve(homeRoot, "AppData/Roaming/Cursor/User/globalStorage");
  await mkdir(storageDir, { recursive: true });
  buildCursorDb(resolve(storageDir, "state.vscdb"), {
    composers: [
      {
        type: "head", composerId: SHARED_ID, name: "修 cursor 聚合",
        createdAt: 1784516039547, lastUpdatedAt: 1784553560326,
        isArchived: false, isDraft: false,
        workspaceIdentifier: { uri: { fsPath: sharedCwd.toLowerCase() } },
        trackedGitRepos: [{ repoPath: sharedCwd }],
      },
      {
        type: "head", composerId: ONLY_ID, name: "",
        createdAt: 1784600000000, lastUpdatedAt: 1784600100000,
        isArchived: false, isDraft: false,
        workspaceIdentifier: { uri: { fsPath: cursorOnlyCwd } },
      },
      { type: "head", composerId: ARCHIVED_ID, name: "旧会话", createdAt: 1784400000000, lastUpdatedAt: 1784400000000, isArchived: true, isDraft: false, workspaceIdentifier: { uri: { fsPath: cursorOnlyCwd } } },
      { type: "head", composerId: DRAFT_ID, name: "草稿", createdAt: 1784400000000, lastUpdatedAt: 1784400000000, isArchived: false, isDraft: true, workspaceIdentifier: { uri: { fsPath: cursorOnlyCwd } } },
    ],
    composerData: {
      [SHARED_ID]: [
        { bubbleId: B(1), type: 2, createdAt: "2026-07-19T10:00:00.000Z" }, // assistant 空 text（摘要/预览都跳过）
        { bubbleId: B(2), type: 2, createdAt: "2026-07-19T10:01:00.000Z" },
        { bubbleId: B(3), type: 1, createdAt: "2026-07-19T10:02:00.000Z" },
        { bubbleId: B(4), type: 1, createdAt: "2026-07-19T10:03:00.000Z" },
      ],
      [ONLY_ID]: [{ bubbleId: B(9), type: 2, createdAt: "2026-07-20T08:00:00.000Z" }],
    },
    bubbles: {
      [`bubbleId:${SHARED_ID}:${B(1)}`]: { type: 2, text: "", createdAt: "2026-07-19T10:00:00.000Z" },
      [`bubbleId:${SHARED_ID}:${B(2)}`]: { type: 2, text: "好的，我来照一下这里", createdAt: "2026-07-19T10:01:00.000Z" },
      [`bubbleId:${SHARED_ID}:${B(3)}`]: { type: 1, text: "帮我修聚合，password=hunter2secret123", createdAt: "2026-07-19T10:02:00.000Z" },
      [`bubbleId:${SHARED_ID}:${B(4)}`]: { type: 1, text: "再补一条后续", createdAt: "2026-07-19T10:03:00.000Z" },
      [`bubbleId:${ONLY_ID}:${B(9)}`]: { type: 2, text: "cursor-only 助手回复", createdAt: "2026-07-20T08:00:00.000Z" },
    },
  });

  const token = "cursor-token-0123456789abcd";
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

  // 1) 共享 cwd 项目：claude + cursor 双源合并（fsPath 小写盘符也命中同一归一化键）
  const merged = tree.projects.find((project) => project.path && project.path.replaceAll("/", "\\").toLowerCase() === sharedCwd.toLowerCase());
  assert.ok(merged, `expected project at ${sharedCwd}, got ${JSON.stringify(tree.projects.map((p) => p.path))}`);
  const cursorSession = merged.sessions.find((session) => session.cli === "cursor");
  assert.ok(cursorSession, "cursor 会话未合并进共享项目");
  assert.equal(cursorSession.id, SHARED_ID);
  assert.equal(cursorSession.label, "修 cursor 聚合");
  assert.equal(cursorSession.modifiedAt, new Date(1784553560326).toISOString());
  // 摘要 = 第一条 type=1 且 text 非空的 bubble（assistant 空 text 跳过），且过双层脱敏
  assert.ok(cursorSession.summary?.includes("帮我修聚合"), `摘要：${cursorSession.summary}`);
  assert.ok(!cursorSession.summary.includes("hunter2secret123"), "摘要必须脱敏");
  assert.ok(Object.keys(cursorSession).every((key) => !key.startsWith("_")), "内部字段不得出网");

  // 2) archived/draft 过滤：两个 id 都不得出现在任何项目下
  const allIds = tree.projects.flatMap((project) => project.sessions.map((session) => session.id));
  assert.ok(!allIds.includes(ARCHIVED_ID), "archived 会话被列出了");
  assert.ok(!allIds.includes(DRAFT_ID), "draft 会话被列出了");

  // 3) cursor-only cwd 合成新项目；无名会话 label=null、无 type=1 消息时 summary=null
  const cursorProject = tree.projects.find((project) => project.id.startsWith("cursor-"));
  assert.ok(cursorProject, "cursor 合成项目缺失");
  assert.equal(cursorProject.path.replaceAll("/", "\\").toLowerCase(), cursorOnlyCwd.toLowerCase());
  assert.equal(cursorProject.sessions.length, 1);
  assert.equal(cursorProject.sessions[0].cli, "cursor");
  assert.equal(cursorProject.sessions[0].label, null);
  assert.equal(cursorProject.sessions[0].summary, null);

  // 4) 只读预览：assistant 空 text 跳过、user/assistant 角色映射、脱敏、时间正序
  const preview = await (
    await fetch(new URL(`/api/sessions/preview?source=cursor&id=${encodeURIComponent(SHARED_ID)}`, baseUrl), { headers: auth })
  ).json();
  assert.equal(preview.source, "cursor");
  assert.equal(preview.messages.length, 3);
  assert.deepEqual(preview.messages.map((message) => message.role), ["assistant", "user", "user"]);
  assert.ok(preview.messages[0].text.includes("好的，我来照一下这里"));
  assert.ok(preview.messages[1].text.includes("帮我修聚合"));
  assert.ok(!preview.messages[1].text.includes("hunter2secret123"), "预览必须脱敏");
  assert.equal(preview.messages[1].timestamp, "2026-07-19T10:02:00.000Z");

  // 5) archived 会话与未知 id → 404；非法 id → 422
  const archived = await fetch(new URL(`/api/sessions/preview?source=cursor&id=${ARCHIVED_ID}`, baseUrl), { headers: auth });
  assert.equal(archived.status, 404);
  const missing = await fetch(new URL(`/api/sessions/preview?source=cursor&id=99999999-9999-4999-8999-999999999999`, baseUrl), { headers: auth });
  assert.equal(missing.status, 404);
  const invalid = await fetch(new URL(`/api/sessions/preview?source=cursor&id=..%2Fevil`, baseUrl), { headers: auth });
  assert.equal(invalid.status, 422);
});

// 缺权威 key → cursor 源 fail-closed 不合并（整树不受影响）；库损坏同理。
test("cursor source degrades fail-closed when composer key missing or malformed", { skip: !DatabaseSync }, async () => {
  for (const [name, setup] of [
    ["missing-key", { includeHeadersKey: false }],
    ["malformed-json", { headersRaw: "not-json{{{" }],
  ]) {
    const root = await mkdtemp(join(tmpdir(), `cc-cursor-${name}-`));
    try {
      const home = join(root, "home");
      const storageDir = join(home, "AppData", "Roaming", "Cursor", "User", "globalStorage");
      await mkdir(join(home, ".claude", "projects"), { recursive: true });
      await mkdir(storageDir, { recursive: true });
      buildCursorDb(join(storageDir, "state.vscdb"), { composers: [], ...setup });
      const agg = new SessionAggregator({ aiSharedRoot: join(root, ".ai-shared"), home });
      const tree = await agg.projects({ includeSummaries: true });
      assert.equal(tree.available, true, `${name}: 整树必须可用`);
      const cursorSessions = tree.projects.flatMap((project) => project.sessions).filter((session) => session.cli === "cursor");
      assert.equal(cursorSessions.length, 0, `${name}: 读不出权威 key 不得伪造 cursor 会话`);
      await assert.rejects(() => agg.previewCursor({ id: SHARED_ID }), { code: "SOURCE_NOT_FOUND" }, `${name}: 预览同样 fail-closed`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
