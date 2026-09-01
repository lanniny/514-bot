// run 产物 diff（codeg 对标 P2：worktree 与 run 关联的产物视图——控制面独有价值）。
// 只读 git 查询；路径只信服务端 ensureRunWorktree 生成的命名形态（纵深校验防 run 记录被篡改指路）；
// 内容过 scrub 脱敏（worktree 里可能有 agent 写入的密钥字面量）；超 200KB 截断如实标注。
import { runProcess } from "./process-runner.mjs";
import { scrub } from "./bus.mjs";
import { attestRunWorkspace } from "./run-workspace.mjs";
import { basename } from "node:path";

const DIFF_LIMIT = 200 * 1024;

function publicPathLeaf(value) {
  const normalized = String(value || "").replace(/[\\/]+$/, "");
  return normalized ? basename(normalized) : null;
}

function scrubGitOutput(value, workspace) {
  let text = scrub(String(value ?? ""));
  for (const absolutePath of [workspace?.path, workspace?.base]) {
    const raw = String(absolutePath || "");
    if (!raw) continue;
    const replacement = publicPathLeaf(raw) || "[workspace]";
    text = text.replaceAll(raw, replacement);
    const slashPath = raw.replaceAll("\\", "/");
    if (slashPath !== raw) text = text.replaceAll(slashPath, replacement);
  }
  return text;
}

function checkedGitResult(result, operation, workspace) {
  if (result && result.error == null && result.code === 0) return result;
  const detail = scrubGitOutput(result?.stderr || result?.error?.message || "", workspace).trim().slice(0, 240);
  throw Object.assign(new Error(detail ? `${operation} 失败：${detail}` : `${operation} 失败，未获得可信结果`), {
    code: "DIFF_UNAVAILABLE",
    operation,
  });
}

function parseDiffStat(statText) {
  const text = String(statText ?? "");
  const files = text.match(/(\d+)\s+files?\s+changed/i);
  const additions = text.match(/(\d+)\s+insertions?\(\+\)/i);
  const deletions = text.match(/(\d+)\s+deletions?\(-\)/i);
  return {
    filesChanged: files ? Number(files[1]) : null,
    additions: additions ? Number(additions[1]) : (files ? 0 : null),
    deletions: deletions ? Number(deletions[1]) : (files ? 0 : null),
  };
}

async function attestedWorktree(run) {
  let workspace;
  try {
    workspace = await attestRunWorkspace(run);
  } catch (error) {
    if (run?.worktreePath || run?.worktreeBase) throw error;
    throw Object.assign(new Error("该任务无隔离工作树（plan 模式或未提供项目地址），无产物可比对"), { code: "VALIDATION_FAILED" });
  }
  if (workspace.kind !== "worktree") {
    throw Object.assign(new Error("该任务无隔离工作树（plan 模式或未提供项目地址），无产物可比对"), { code: "VALIDATION_FAILED" });
  }
  return workspace;
}

export async function summarizeRunDiff(run, { runner = runProcess } = {}) {
  const workspace = await attestedWorktree(run);
  const worktreePath = workspace.path;
  const [statusResult, statResult] = await Promise.all([
    runner("git", ["-C", worktreePath, "status", "--porcelain"], { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 }),
    runner("git", ["-C", worktreePath, "diff", "--stat", "HEAD"], { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 }),
  ]);
  const status = checkedGitResult(statusResult, "git status", workspace);
  const stat = checkedGitResult(statResult, "git diff --stat", workspace);
  const statusText = scrubGitOutput(status.stdout, workspace);
  const statText = scrubGitOutput(stat.stdout, workspace);
  const totals = parseDiffStat(statText);
  return {
    runId: run.id,
    available: true,
    dirty: statusText.trim().length > 0,
    truncated: false,
    worktree: publicPathLeaf(worktreePath),
    base: publicPathLeaf(workspace.base),
    status: statusText,
    stat: statText,
    ...totals,
    endpoint: `/api/runs/${encodeURIComponent(run.id)}/diff`,
  };
}

export async function runDiffForRun(run, { runner = runProcess } = {}) {
  const workspace = await attestedWorktree(run);
  const worktreePath = workspace.path;
  const [statusResult, statResult, diffResult] = await Promise.all([
    runner("git", ["-C", worktreePath, "status", "--porcelain"], { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 }),
    runner("git", ["-C", worktreePath, "diff", "--stat", "HEAD"], { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 }),
    runner("git", ["-C", worktreePath, "diff", "HEAD"], { timeoutMs: 60_000, maxOutputBytes: 2 * 1024 * 1024 }),
  ]);
  const status = checkedGitResult(statusResult, "git status", workspace);
  const stat = checkedGitResult(statResult, "git diff --stat", workspace);
  const diff = checkedGitResult(diffResult, "git diff", workspace);
  const statusText = scrubGitOutput(status.stdout, workspace);
  const statText = scrubGitOutput(stat.stdout, workspace);
  const diffText = scrubGitOutput(diff.stdout, workspace);
  const truncated = diffText.length > DIFF_LIMIT;
  return {
    runId: run.id,
    worktree: publicPathLeaf(worktreePath),
    base: publicPathLeaf(workspace.base),
    status: statusText,
    stat: statText,
    diff: truncated ? `${diffText.slice(0, DIFF_LIMIT)}\n\n…（diff 超 200KB 已截断，完整内容请在工作树内查看）` : diffText,
    truncated,
  };
}

// W3.17 会话对比报告：把 runDiffForRun 的结果渲染成可分享 Markdown（进 artifact 预览体系）。
// 纯投影：输入即 run-diff 输出，不重新执行 git。
export function renderDiffMarkdown(diff, { generatedAt = new Date().toISOString() } = {}) {
  const runId = String(diff?.runId || "?");
  const lines = [];
  lines.push("# Run 产物对比报告");
  lines.push("");
  lines.push(`- 生成时间：${generatedAt}`);
  lines.push(`- Run：\`${runId}\``);
  lines.push(`- 工作树：${diff?.worktree ?? "–"}（基线 ${diff?.base ?? "–"}）`);
  lines.push(`- 截断：${diff?.truncated ? "是（diff 超 200KB）" : "否"}`);
  lines.push("");
  lines.push("## 变更统计");
  lines.push("");
  lines.push("```");
  lines.push(String(diff?.stat || "（无变更）"));
  lines.push("```");
  lines.push("");
  lines.push("## 工作树状态");
  lines.push("");
  lines.push("```");
  lines.push(String(diff?.status || "clean"));
  lines.push("```");
  lines.push("");
  lines.push("## Diff");
  lines.push("");
  lines.push("```diff");
  lines.push(String(diff?.diff || "（无变更）"));
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}
