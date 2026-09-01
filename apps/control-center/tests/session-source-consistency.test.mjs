import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionAggregator } from "../src/sessions.mjs";

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

function cursorStorageDir(home) {
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Cursor", "User", "globalStorage");
  if (process.platform === "win32") return join(home, "AppData", "Roaming", "Cursor", "User", "globalStorage");
  return join(home, ".config", "Cursor", "User", "globalStorage");
}

async function createNonClaudeSources(home) {
  const cwd = "I:\\demo\\non-claude-only";

  const codexDir = join(home, ".codex", "sessions", "2026", "07", "23");
  await mkdir(codexDir, { recursive: true });
  await writeFile(
    join(codexDir, "rollout-2026-07-23T12-00-00-codex-only.jsonl"),
    `${JSON.stringify({ type: "session_meta", payload: { id: "codex-only", cwd } })}\n${JSON.stringify({ payload: { role: "user", content: "Codex 独立项目" } })}\n`,
    "utf8",
  );

  const kimiId = "session_kimi_only";
  const kimiDir = join(home, ".kimi-code", "sessions", "wd_demo", kimiId);
  const kimiWire = join(kimiDir, "agents", "main", "wire.jsonl");
  await mkdir(join(kimiDir, "agents", "main"), { recursive: true });
  await writeFile(join(kimiDir, "state.json"), JSON.stringify({ updatedAt: "2026-07-23T12:01:00.000Z", isCustomTitle: true, title: "Kimi 独立会话" }), "utf8");
  await writeFile(kimiWire, `${JSON.stringify({ type: "turn.prompt", origin: { kind: "user" }, input: [{ text: "Kimi 独立项目" }] })}\n`, "utf8");
  await writeFile(
    join(home, ".kimi-code", "session_index.jsonl"),
    `${JSON.stringify({ sessionId: kimiId, sessionDir: kimiDir, workDir: cwd })}\n`,
    "utf8",
  );

  const piId = "2026-07-23T12-02-00-000Z_pi-only";
  const piDir = join(home, ".pi", "agent", "sessions", "--I-demo-non-claude-only--");
  await mkdir(piDir, { recursive: true });
  await writeFile(
    join(piDir, `${piId}.jsonl`),
    `${JSON.stringify({ type: "session", id: piId, cwd })}\n${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Pi 独立项目" }] } })}\n`,
    "utf8",
  );

  if (DatabaseSync) {
    const cursorId = "aaaa1111-2222-4333-8444-555566667777";
    const bubbleId = "bbbb1111-2222-4333-8444-555566667777";
    const storageDir = cursorStorageDir(home);
    await mkdir(storageDir, { recursive: true });
    const db = new DatabaseSync(join(storageDir, "state.vscdb"));
    try {
      db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
      db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)");
      db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("composer.composerHeaders", JSON.stringify({
        allComposers: [{
          composerId: cursorId,
          name: "Cursor 独立会话",
          createdAt: 1784808000000,
          lastUpdatedAt: 1784808180000,
          isArchived: false,
          isDraft: false,
          workspaceIdentifier: { uri: { fsPath: cwd } },
        }],
      }));
      db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
        `composerData:${cursorId}`,
        JSON.stringify({ fullConversationHeadersOnly: [{ bubbleId, type: 1, createdAt: "2026-07-23T12:03:00.000Z" }] }),
      );
      db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
        `bubbleId:${cursorId}:${bubbleId}`,
        JSON.stringify({ type: 1, text: "Cursor 独立项目", createdAt: "2026-07-23T12:03:00.000Z" }),
      );
    } finally {
      db.close();
    }
  }

  return { cwd };
}

test("project scan keeps non-Claude sources when ~/.claude/projects is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "cc-session-sources-"));
  const home = join(root, "home");
  try {
    const { cwd } = await createNonClaudeSources(home);
    const result = await new SessionAggregator({ aiSharedRoot: join(root, ".ai-shared"), home }).projects({ includeSummaries: true });

    assert.equal(result.available, true, "任一真实 CLI 源可用时整棵项目树应可用");
    const sourceStatus = Object.fromEntries(result.sources.map((source) => [source.source, source]));
    assert.equal(sourceStatus.claude.available, false, "Claude 根确实缺失，不得伪装 available");
    for (const source of ["codex", "kimi", "pi"]) {
      assert.equal(sourceStatus[source].available, true, `${source} 应独立完成扫描`);
      assert.equal(sourceStatus[source].sessionCount, 1, `${source} 应报告真实会话数`);
    }
    if (DatabaseSync) {
      assert.equal(sourceStatus.cursor.available, true, "cursor 应独立完成扫描");
      assert.equal(sourceStatus.cursor.sessionCount, 1, "cursor 应报告真实会话数");
    }

    const project = result.projects.find((item) => item.path?.toLowerCase() === cwd.toLowerCase());
    assert.ok(project, "无 Claude 根时仍应合成非 Claude 项目");
    const expectedClis = DatabaseSync ? ["codex", "cursor", "kimi", "pi"] : ["codex", "kimi", "pi"];
    assert.deepEqual(project.sessions.map((session) => session.cli).sort(), expectedClis);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("flat session API model exposes every promised CLI with truthful status and count", async () => {
  const root = await mkdtemp(join(tmpdir(), "cc-session-list-sources-"));
  const home = join(root, "home");
  try {
    await createNonClaudeSources(home);
    const result = await new SessionAggregator({ aiSharedRoot: join(root, ".ai-shared"), home }).list({
      limitPerSource: 10,
      includeSummaries: true,
    });
    assert.deepEqual(result.sources.map((source) => source.source), [
      "claude", "codex", "cursor", "kimi", "pi", "bridge", "grok",
      "opencode", "cline", "openclaw", "hermes", "codebuddy", "gemini",
    ]);

    const bySource = Object.fromEntries(result.sources.map((source) => [source.source, source]));
    for (const source of ["codex", "kimi", "pi"]) {
      assert.equal(bySource[source].available, true, `${source} 状态应来自真实存储探测`);
      assert.equal(bySource[source].sessionCount, 1, `${source} 计数应独立报告`);
      assert.equal(bySource[source].sessions.length, 1);
      assert.ok(bySource[source].sessions[0].summary, `${source} opt-in 摘要应走现有脱敏管线`);
    }
    if (DatabaseSync) {
      assert.equal(bySource.cursor.available, true, "cursor 状态应来自真实存储探测");
      assert.equal(bySource.cursor.sessionCount, 1, "cursor 计数应独立报告");
      assert.equal(bySource.cursor.sessions.length, 1);
      assert.ok(bySource.cursor.sessions[0].summary, "cursor opt-in 摘要应走现有脱敏管线");
    } else {
      assert.equal(bySource.cursor.available, false, "node:sqlite 不可用时 cursor 不得伪装 available");
    }
    for (const source of ["claude", "bridge", "grok", "opencode", "cline", "openclaw", "hermes", "codebuddy", "gemini"]) {
      assert.equal(bySource[source].available, false, `${source} 存储不存在时不得伪装已接入`);
      assert.equal(bySource[source].sessionCount, 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("W1.6 gemini sessions are listed from ~/.gemini/tmp with truthful scope mapping", async () => {
  const root = await mkdtemp(join(tmpdir(), "cc-session-gemini-"));
  const home = join(root, "home");
  try {
    // 本机实证结构：tmp/<dir>/chats/session-*.json + 可选 .project_root
    const plainDir = join(home, ".gemini", "tmp", "myproj");
    const hashDir = join(home, ".gemini", "tmp", "a".repeat(64));
    await mkdir(join(plainDir, "chats"), { recursive: true });
    await mkdir(join(hashDir, "chats"), { recursive: true });
    await writeFile(join(plainDir, ".project_root"), "i:/work/demo\n", "utf8");
    await writeFile(join(plainDir, "chats", "session-2026-08-30T01-00-aaa.json"), JSON.stringify({
      sessionId: "11111111-2222-3333-4444-555555555555",
      projectHash: "a".repeat(64),
      startTime: "2026-08-30T01:00:00.000Z",
      lastUpdated: "2026-08-30T01:05:00.000Z",
      messages: [{ id: 1, timestamp: "2026-08-30T01:00:01.000Z", type: "user", content: "帮我审查这段配置 " }],
    }), "utf8");
    await writeFile(join(hashDir, "chats", "session-2026-08-30T02-00-bbb.json"), JSON.stringify({
      sessionId: "99999999-8888-7777-6666-555555555555",
      projectHash: "a".repeat(64),
      startTime: "2026-08-30T02:00:00.000Z",
      lastUpdated: "2026-08-30T02:05:00.000Z",
      messages: [{ id: 1, timestamp: "2026-08-30T02:00:01.000Z", type: "user", content: "hash 目录会话" }],
    }), "utf8");
    const result = await new SessionAggregator({ aiSharedRoot: join(root, ".ai-shared"), home }).list({
      limitPerSource: 10,
      includeSummaries: true,
    });
    const gemini = result.sources.find((source) => source.source === "gemini");
    assert.equal(gemini.available, true);
    assert.equal(gemini.sessionCount, 2);
    assert.equal(gemini.sessions.length, 2);
    const plain = gemini.sessions.find((session) => session.id === "11111111-2222-3333-4444-555555555555");
    const hashed = gemini.sessions.find((session) => session.id === "99999999-8888-7777-6666-555555555555");
    assert.ok(plain, "sessionId 应优先于文件名");
    assert.equal(plain.scope, "i:/work/demo", "明文目录 scope 应还原 .project_root 的 cwd");
    assert.ok(plain.summary?.includes("帮我审查"), "opt-in 摘要应取首条用户消息并过脱敏");
    assert.equal(hashed.scope, `hash:${"a".repeat(64)}`, "哈希目录无法逆映射 cwd 时应如实标注 hash:");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
