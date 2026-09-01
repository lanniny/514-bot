import { spawn } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defaultKillTree } from "../src/child-registry.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const sqliteFlag = "--experimental-sqlite";

/**
 * W0.5 测试残留自清：tests/*.mjs 大量使用 `mkdtemp(resolve(appRoot, ".test-<name>-"))`
 * 且无收尾，残留曾积累 4370 个目录。此处提供统一清扫（仅在测试进程树确认关闭后调用，
 * 保证不删到仍在使用的目录），并暴露 CLI 入口：`node scripts/run-tests.mjs --clean-only`。
 */
export function sweepTestResidue(root = appRoot) {
  let removed = 0;
  let skipped = 0;
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return { removed, skipped };
  }
  for (const name of entries) {
    if (!name.startsWith(".test-")) continue;
    try {
      rmSync(path.join(root, name), { recursive: true, force: true });
      removed += 1;
    } catch {
      skipped += 1; // Windows EBUSY/EPERM（句柄未释放等）：跳过不阻断
    }
  }
  return { removed, skipped };
}

if (process.argv.includes("--clean-only")) {
  const { removed, skipped } = sweepTestResidue();
  process.stdout.write(`clean-exit:swept=${removed} skipped=${skipped}\n`);
  process.exit(0);
}

/**
 * P0-10：测试启动器从「只转发退出码」升级为「clean-exit gate」。
 *
 * 单独的退出码不能证明测试进程演出的 SSE 服务器、PTY、worker 与测试服务真的被清干净：
 * 任何被测试 fork 且未 close 的服务句柄都会让子进程在自身测试跑完后仍吊着（事件循环不清空），
 * 表现为「测试明明全 green 却永不退出」。本 gate 用挂起护栏抓住这一点：
 *   - 正常尽快退出：记录 child exit，附带信号即失败；
 *   - 挂起护栏：超过 timeout 视为残留资源未释放，强制拆进程树（taskkill /T /F）并判 CLEAN_EXIT_TIMEOUT；
 *   - 退出码非 0 即失败；
 *   - 各维度（child 启动、child exit、signal、残留资源）分开记录，任一异常都令 gate 失败，
 *     每一维打印机器可读 `clean-exit.<dimension>=<ok|fail>` 供审计回读。
 */

const forwarded = process.argv.slice(2);

function parseTimeoutMs(forwarded) {
  const prefix = "--timeout=";
  const flag = forwarded.find((argument) => argument.startsWith(prefix));
  if (!flag) return 20 * 60 * 1000; // 默认 20 分钟，足够慢 CI 全量；挂了说明有句柄泄漏
  const seconds = Number(flag.slice(prefix.length));
  if (!Number.isFinite(seconds) || seconds <= 0) {
    process.stderr.write("clean-exit: invalid --timeout, falling back to default\n");
    return 20 * 60 * 1000;
  }
  return seconds * 1000; // 秒 → 毫秒
}

const timeoutMs = parseTimeoutMs(forwarded);
const flagsWithoutTimeout = forwarded.filter((argument) => !argument.startsWith("--timeout="));
const hasExplicitTarget = flagsWithoutTimeout.some((argument) => !argument.startsWith("-") && !argument.startsWith("--"));
const hasConcurrency = flagsWithoutTimeout.some((argument) => argument.startsWith("--test-concurrency"));
const args = [sqliteFlag, "--test", ...flagsWithoutTimeout];
if (!hasConcurrency) args.push("--test-concurrency=4");
if (!hasExplicitTarget) args.push("tests/*.test.mjs");

// NODE_OPTIONS is inherited by server/worker Node processes spawned from tests.
// Keep the explicit CLI flag too, so the test runner itself has node:sqlite on Node 22.5-22.x.
const inheritedNodeOptions = process.env.NODE_OPTIONS?.trim() ?? "";
const hasSqliteFlag = /(?:^|\s)--experimental-sqlite(?:\s|$)/.test(inheritedNodeOptions);
const nodeOptions = hasSqliteFlag ? inheritedNodeOptions : `${inheritedNodeOptions} ${sqliteFlag}`.trim();

const child = spawn(process.execPath, args, {
  cwd: appRoot,
  env: { ...process.env, NODE_OPTIONS: nodeOptions, CONTROL_CENTER_TEST_RUNNER_TIMEOUT_MS: String(timeoutMs) },
  stdio: "inherit",
  windowsHide: true,
  shell: false,
});

let settled = false;
let closeObserved = false;
let resolveClose;
const closeObservedPromise = new Promise((resolveClosePromise) => {
  resolveClose = resolveClosePromise;
});

function report(dimension, ok) {
  process.stdout.write(`clean-exit:${dimension}=${ok ? "ok" : "fail"}\n`);
}

child.once("error", (error) => {
  clearTimeout(hangTimer);
  if (settled) return;
  settled = true;
  report("launch", false);
  report("childexit", false);
  process.stderr.write(`clean-exit gate failed: test runner failed to start: ${error.message}\n`);
  process.exitCode = 1;
});

child.once("spawn", () => {
  report("launch", true);
});

const hangTimer = setTimeout(async () => {
  if (settled) return;
  settled = true;
  report("resource", false);
  process.stderr.write(
    `clean-exit gate failed: test process did not exit within timeout (ms=${timeoutMs}); ` +
      "a test likely left an SSE/PTY/worker/service handle open. Reaping the process tree.\n",
  );
  process.exitCode = 1;
  const killTreeSucceeded = await defaultKillTree(child.pid).catch(() => false);
  if (!killTreeSucceeded && !closeObserved) child.kill();
  if (!closeObserved) {
    await Promise.race([
      closeObservedPromise,
      new Promise((resolveDelay) => setTimeout(resolveDelay, 250)),
    ]);
  }
  report("reap", killTreeSucceeded || closeObserved);
  if (killTreeSucceeded || closeObserved) {
    const { removed, skipped } = sweepTestResidue();
    process.stdout.write(`clean-exit:swept=${removed} skipped=${skipped}\n`);
  }
}, timeoutMs);

child.once("close", (code, signal) => {
  closeObserved = true;
  resolveClose();
  clearTimeout(hangTimer);
  if (settled) return;
  settled = true;
  report("resource", true);
  if (signal) {
    report("signal", false);
    report("exit", false);
    process.stderr.write(`clean-exit gate failed: test runner terminated by ${signal}\n`);
    process.exitCode = 1;
    return;
  }
  const ok = code === 0;
  report("exit", ok);
  if (!ok) {
    process.stderr.write(`clean-exit gate failed: test runner exited ${code}\n`);
    process.exitCode = code ?? 1;
    return;
  }
  report("childexit", true);
  process.exitCode = 0;
  const { removed, skipped } = sweepTestResidue();
  process.stdout.write(`clean-exit:swept=${removed} skipped=${skipped}\n`);
});
