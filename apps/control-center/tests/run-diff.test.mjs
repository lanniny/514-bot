import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDiffForRun, summarizeRunDiff } from "../src/run-diff.mjs";
import { runProcess } from "../src/process-runner.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

async function gitRepoWithWorktree(t) {
  const root = await mkdtemp(join(tmpdir(), "514cc-rundiff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "demo-repo");
  await mkdir(repo, { recursive: true });
  const git = (args) => runProcess("git", ["-C", repo, ...args], { timeoutMs: 30_000 });
  await git(["init"]);
  await git(["config", "user.email", "test@514cc.local"]);
  await git(["config", "user.name", "514cc Test"]);
  await writeFile(join(repo, "app.js"), "const v = 1;\n");
  await git(["add", "."]);
  await git(["commit", "-m", "init"]);
  // 命名形态必须与 orchestrator.ensureRunWorktree 一致（<repo>-wt-<14位时间戳>-<8位hex>）
  const worktree = join(root, "demo-repo-wt-20260720153000-abcd1234");
  await git(["worktree", "add", "--detach", worktree]);
  return { repo, worktree };
}

test("run diff rejects runs without a worktree", async () => {
  await assert.rejects(() => runDiffForRun({ id: "r1" }), { code: "VALIDATION_FAILED" });
  await assert.rejects(() => runDiffForRun({ id: "r1", worktreePath: "x" }), { code: "VALIDATION_FAILED" });
});

test("run diff rejects tampered worktree path naming (fail-closed)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "514cc-rundiff-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const evil of ["C:\\Windows", join(root, "random-dir"), join(root, "demo-wt-123")] ) {
    await assert.rejects(
      () => runDiffForRun({ id: "r1", worktreePath: evil, worktreeBase: root }),
      { code: "VALIDATION_FAILED" },
      `should reject: ${evil}`,
    );
  }
});

test("run diff returns status/stat/diff for a dirty worktree (real git)", async (t) => {
  const { worktree, repo } = await gitRepoWithWorktree(t);
  await writeFile(join(worktree, "app.js"), "const v = 2; // agent 改动\n");
  await writeFile(join(worktree, "new-file.txt"), "agent 新建\n");
  const result = await runDiffForRun({ id: "r-9", worktreePath: worktree, worktreeBase: repo });
  assert.equal(result.runId, "r-9");
  assert.ok(result.status.includes("new-file.txt"), `porcelain 应含新文件：${result.status}`);
  assert.ok(result.stat.includes("app.js"), `stat 应含 app.js：${result.stat}`);
  assert.ok(result.diff.includes("const v = 2"), `diff 应含改动行：${result.diff}`);
  assert.equal(result.truncated, false);
  assert.equal(result.worktree, basename(worktree));
  assert.equal(result.base, basename(repo));
});

test("run diff reports a clean worktree honestly (empty outputs)", async (t) => {
  const { worktree, repo } = await gitRepoWithWorktree(t);
  const result = await runDiffForRun({ id: "r-10", worktreePath: worktree, worktreeBase: repo });
  assert.equal(result.status.trim(), "");
  assert.equal(result.diff.trim(), "");
  assert.equal(result.truncated, false);
});

test("run diff fails closed when any git probe exits non-zero", async (t) => {
  const { worktree, repo } = await gitRepoWithWorktree(t);
  const runner = async (_command, args) => {
    if (args.includes("status")) return { code: 128, stdout: "", stderr: `fatal: cannot read ${worktree}` };
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(
    () => summarizeRunDiff({ id: "r-failed", worktreePath: worktree, worktreeBase: repo }, { runner }),
    (error) => error.code === "DIFF_UNAVAILABLE"
      && error.operation === "git status"
      && !error.message.includes(worktree),
  );
});

test("run diff scrubs absolute workspace paths from every output channel", async (t) => {
  const { worktree, repo } = await gitRepoWithWorktree(t);
  const runner = async (_command, args) => ({
    code: 0,
    stdout: args.includes("status")
      ? ` M ${worktree}/app.js\n`
      : args.includes("--stat")
        ? ` ${repo}/app.js | 1 +\n 1 file changed, 1 insertion(+)\n`
        : `diff --git a/${worktree}/app.js b/${worktree}/app.js\n`,
    stderr: "",
  });
  const result = await runDiffForRun({ id: "r-scrub", worktreePath: worktree, worktreeBase: repo }, { runner });
  for (const value of [result.worktree, result.base, result.status, result.stat, result.diff]) {
    assert.equal(String(value).includes(worktree), false);
    assert.equal(String(value).includes(repo), false);
  }
});
