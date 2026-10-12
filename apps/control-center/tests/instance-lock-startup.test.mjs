/**
 * instance-lock-startup.test.mjs — 内核因实例锁被占而退出时，**必须说出理由**。
 *
 * 为什么单独一道门禁（2026-09-18 真实故障）：桌面端外壳把内核 stderr 重定向到
 * kernel-stderr.log，那是排障时第一个被打开的文件。而 `acquireInstanceLock`
 * 撞到活锁时抛的 INSTANCE_ACTIVE 只被写进仓库里的 .scratch/control-center-fatal.log，
 * stderr 一片空白——于是「内核握手前退出多次、无法自动恢复」在表面证据上没有任何线索，
 * 用户拿到的就是一份空日志。
 *
 * 实测形态（证据在 .scratch/control-center-fatal.log）：
 *   僵尸实例（外壳窗口已隐藏、内核仍活着持锁）→ 新实例不委派、自己 spawn 内核 →
 *   内核 exit 1 且 stdout/stderr 全空 → 外壳换端口重试 2 次（病因是锁不是端口）→ 放弃。
 *
 * 本测试钉住两件事：退出码必须非 0，且 stderr 必须包含「谁持有锁」与「怎么办」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

/** 用**当前真实进程**伪造锁持有者：pid 活着、image 匹配、StartTime 落进 2 秒容差。 */
function liveLockFor(dataRoot) {
  return {
    repoRoot: resolve(dataRoot, "repo"),
    dataRoot,
    pid: process.pid,
    nonce: "live-lock-fixture",
    startedAt: new Date().toISOString(),
    image: "node.exe",
  };
}

function runKernel({ root, dataRoot }) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ["--experimental-sqlite", resolve(appRoot, "server.mjs")], {
      cwd: appRoot,
      env: {
        ...process.env,
        CC_ROOT: root,
        CONTROL_CENTER_DATA_DIR: dataRoot,
        CONTROL_CENTER_REPO_ROOT: resolve(root, "repo"),
        CONTROL_CENTER_TEST_REPO_ROOT: resolve(root, "repo"),
        CONTROL_CENTER_PORT: "0",
        CONTROL_CENTER_TOKEN: "instance-lock-fixture-token",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

test("live instance lock: kernel exits non-zero AND explains why on stderr", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "514cc-lock-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = resolve(root, "data");
  await mkdir(dataRoot, { recursive: true });
  await writeFile(resolve(dataRoot, "control-center.lock"), `${JSON.stringify(liveLockFor(dataRoot))}\n`, "utf8");

  const { code, stdout, stderr } = await runKernel({ root, dataRoot });

  assert.notEqual(code, 0, "锁被活进程持有时必须非零退出（不能装作启动成功）");
  // 关键断言：stderr 必须自解释。此前这里是空的——正是「空日志」让故障变成玄学。
  assert.match(stderr, /another instance already owns the instance lock/, "stderr 必须点明是实例锁");
  assert.match(stderr, new RegExp(`pid=${process.pid}\\b`), "必须给出持有者 pid，否则用户无法定位");
  assert.match(stderr, /Quit that instance first/, "必须给出可执行的动作，而不是只丢一个错误码");
  // stdout 保持干净：外壳靠它解析 bootstrap URL，不能被诊断文字污染
  assert.doesNotMatch(stdout, /fatal|instance lock/, "诊断不得写进 stdout（那是握手通道）");
});

test("stale lock (owner pid gone) must NOT block startup", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "514cc-lock-stale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = resolve(root, "data");
  await mkdir(dataRoot, { recursive: true });
  // 一个不可能存在的 pid：stale 回收必须放行，否则强杀后永远起不来
  await writeFile(resolve(dataRoot, "control-center.lock"), `${JSON.stringify({
    repoRoot: resolve(root, "repo"),
    dataRoot,
    pid: 999_999_999,
    nonce: "stale-lock-fixture",
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    image: "node.exe",
  })}\n`, "utf8");

  const { stdout, stderr } = await runKernel({ root, dataRoot });
  // 锁不是障碍 → 内核应继续往下走（缺 repo 配置也会失败，但那是**别的原因**）
  assert.doesNotMatch(stderr, /instance lock/, "stale 锁不得被当成占用");
  assert.doesNotMatch(stdout, /instance lock/, "stale 锁不得被当成占用（stdout 同理）");
});
