#!/usr/bin/env node
// 全量 QA 门禁（D-2026-09-28-009）：scripts/qa-*.mjs 六十个脚本此前无聚合入口，只能逐条
// npm run qa:* 手跑——面向市场的验收链断口。本 runner 顺序执行全部 QA 脚本，汇总通过/失败/
// 时长，任一失败即 exit 1，可入 CI / 发布前闸门。
//
// 设计取舍：
//   · 顺序执行——QA 脚本各自 spawn 测试服务器（tests/server-fixture.mjs），并行有端口/资源
//     碰撞风险；单机全量约十几分钟，可接受。
//   · 人肉判定类脚本（qa-visual-baseline 只列差异不判通过）默认跳过，--include-manual 可纳入。
//   · 每脚本默认 300s 超时；--timeout=<ms> 可调；--only=<子串> / --skip=<子串> 过滤。
//   · 失败时打印该脚本输出末 40 行，便于直接定位。

import { existsSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptsDir = join(appRoot, "scripts");
const args = process.argv.slice(2);
const argOf = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = argOf("only") || null;
const skip = argOf("skip") || null;
const includeManual = args.includes("--include-manual");
const timeoutMs = Number(argOf("timeout") || 300_000);

// 人肉判定 / 探索性脚本：不进自动门禁（默认跳过，--include-manual 可纳入）
// D-2026-09-28-021 增补 global-wallpaper-visual：它要求先人工起一个隔离实例再传
// QA_WALLPAPER_BASE/TOKEN（脚本首行注释写明的用法），聚合 runner 无人供参——
// 与 qa-visual-baseline 同类：产图给人眼看，不该算自动门禁。
const MANUAL = new Set(["qa-visual-baseline.mjs", "qa-global-wallpaper-visual.mjs"]);

// D-2026-09-28-013 三色标签的 ⚪ 类机械化：*-probe.mjs 是探测/取证脚本（无通过判定、
// 只产 artifact），单独编组运行、单独汇报，不计入门禁通过率——避免探针的环境噪音
// 掩盖真门禁（🟢 当前面脚本）的红绿。
const isProbe = (name) => /-probe\.mjs$/.test(name);

// D-2026-09-28-021 环境前置门槛：四个脚本的入参/目标面此前无人提供（runner 裸 spawn 不传参），
// 它们必然以 usage error 收场——把"本机没构建 / 目标面不在这里"伪装成"门禁失败"，
// 真红被假红埋掉（上一轮 20 个红里 4 个是这一类）。此处按前置在盘与否分流：
//   · 前置满足（含补足入参）→ 照常计入门禁；
//   · 前置缺失 → 标 ⏭ 从分母剔除，汇总里显式列名+原因（禁止静默跳过，否则覆盖率缩水无人知）。
const repoRoot = resolve(appRoot, "../..");
const desktopExe = resolve(repoRoot, "apps/desktop/src-tauri/target/release/cc-desktop.exe");
const mainRs = resolve(repoRoot, "apps/desktop/src-tauri/src/main.rs");
const bundleDir = resolve(repoRoot, "apps/desktop/src-tauri/target/release/bundle");
const ENV_PREFLIGHT = {
  // 目标面 data-ccs-* 面板（[data-ccs-resource-tab]/[data-ccs-form]）不在当前 Console DOM 中，
  // 且脚本不自启测试服务器、要求外部 bootstrap-url——桌面/退役面脚本。
  "qa-ccswitch.mjs": () => ({ reason: "目标面 data-ccs-* 面板不在当前 Console DOM，且要求外部 bootstrap-url（桌面/退役面脚本）" }),
  "qa-cli-seat-catalog.mjs": () => ({ reason: "目标面 #member-strip/#view-workbench 导航级退役（#view-workbench 恒 hidden，退役面脚本）" }),
  "qa-desktop-native.mjs": () => (existsSync(bundleDir)
    ? { args: [`--bundle=${bundleDir}`, `--output-dir=${resolve(appRoot, ".qa-output", "desktop-native")}`] }
    : { reason: "缺 Tauri 安装包 bundle（tauri build 未产出）" }),
  "qa-pet-native.mjs": () => {
    if (!existsSync(desktopExe)) return { reason: "缺桌面 exe（tauri build 未产出）" };
    // 产物早于源码 = 拿旧二进制验新源码，绿/红都不可信，必须重新构建后再计入门禁
    if (statSync(mainRs).mtimeMs > statSync(desktopExe).mtimeMs) return { reason: "桌面 exe 早于 src-tauri/src/main.rs，产物过期需重新 tauri build" };
    return { args: [`--desktop-exe=${desktopExe}`, `--output-dir=${resolve(appRoot, ".qa-output", "pet-native")}`] };
  },
  "qa-portable-runtime.mjs": () => (existsSync(bundleDir)
    ? { args: [`--bundle=${bundleDir}`, `--output=${resolve(appRoot, ".qa-output", "portable-runtime")}`] }
    : { reason: "缺 bundle（tauri build 未产出）" }),
};

const all = readdirSync(scriptsDir)
  .filter((name) => /^qa-.*\.mjs$/.test(name))
  .filter((name) => name !== "qa-run-all.mjs") // 自包含：不把 runner 自己当 QA 脚本跑（曾致递归+超时）
  .filter((name) => (includeManual ? true : !MANUAL.has(name)))
  .filter((name) => (only ? name.includes(only) : true))
  .filter((name) => (skip ? !name.includes(skip) : true))
  .sort();

// 环境前置判定：--only/--skip 已过滤掉的不干预；其余按 ENV_PREFLIGHT 分流
const envArgs = new Map();
const envBlocked = [];
for (const [name, preflight] of Object.entries(ENV_PREFLIGHT)) {
  if (!all.includes(name)) continue;
  const verdict = preflight();
  if (verdict.args) envArgs.set(name, verdict.args);
  else envBlocked.push({ name, reason: verdict.reason });
}
const blockedNames = new Set(envBlocked.map((entry) => entry.name));
const runnable = all.filter((name) => !blockedNames.has(name));

const gated = runnable.filter((name) => !isProbe(name));
const probes = runnable.filter(isProbe);

if (all.length === 0) {
  console.error("没有匹配的 QA 脚本（检查 --only/--skip 过滤）");
  process.exit(2);
}
if (runnable.length === 0) {
  // 全部被环境前置挡下（如 --only=qa-ccswitch）：无可执行项，不是"通过"也不是"失败"
  console.error("匹配到的脚本全部因环境前置不满足而未执行——无门禁结论可下");
  process.exit(2);
}

async function runBatch(names, { gate }) {
  const results = [];
  for (const name of names) {
    process.stdout.write(`▶ ${name} ... `);
    const result = await runOne(name);
    results.push(result);
    const ok = result.code === 0;
    console.log(ok ? `✔ (${(result.ms / 1000).toFixed(1)}s)` : `✖ code=${result.code} (${(result.ms / 1000).toFixed(1)}s)`);
    if (!ok) {
      const tail = result.out.split("\n").slice(-40).join("\n");
      console.log(`---- ${name} 输出末 40 行 ----\n${tail}\n----`);
    }
  }
  return results;
}

function runOne(name) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(scriptsDir, name), ...(envArgs.get(name) ?? [])], {
      cwd: appRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ name, code: timedOut ? "TIMEOUT" : code, ms: Date.now() - started, out });
    });
  });
}

console.log(`# QA 门禁：🟢 门禁组 ${gated.length} 个 + ⚪ 探针组 ${probes.length} 个（timeout ${timeoutMs}ms/个，顺序执行）`);
if (envBlocked.length > 0) {
  console.log(`# ⏭ 环境前置不满足 ${envBlocked.length} 个（本机未构建/目标面不在此，未执行、已从门禁分母剔除）：`);
  for (const entry of envBlocked) console.log(`  ⏭ ${entry.name} — ${entry.reason}`);
}
console.log("");
console.log(`## 🟢 门禁组（当前面脚本，计入通过率）`);
const gatedResults = await runBatch(gated, { gate: true });
if (probes.length > 0) {
  console.log(`\n## ⚪ 探针组（无通过判定，只产 artifact，不计入门禁）`);
}
const probeResults = probes.length > 0 ? await runBatch(probes, { gate: false }) : [];

const passed = gatedResults.filter((r) => r.code === 0);
const failed = gatedResults.filter((r) => r.code !== 0);
const probePassed = probeResults.filter((r) => r.code === 0);
const probeFailed = probeResults.filter((r) => r.code !== 0);
const totalMs = [...gatedResults, ...probeResults].reduce((sum, r) => sum + r.ms, 0);
console.log(`\n# 汇总: 🟢 门禁 ${passed.length}/${gatedResults.length} 通过 · ⏭ 环境不满足 ${envBlocked.length} · ⚪ 探针 ${probePassed.length}/${probeResults.length}（不计入门禁）· 总时长 ${(totalMs / 1000).toFixed(1)}s`);
if (failed.length > 0) {
  console.log("# 门禁失败清单:");
  for (const r of failed) console.log(`  ✖ ${r.name} (code=${r.code})`);
}
if (envBlocked.length > 0) {
  console.log("# 环境前置不满足（未执行，已从门禁分母剔除——覆盖率相应缩小）：");
  for (const entry of envBlocked) console.log(`  ⏭ ${entry.name} — ${entry.reason}`);
}
if (probeFailed.length > 0) {
  console.log("# 探针异常备忘（不影响门禁结论）:");
  for (const r of probeFailed) console.log(`  · ${r.name} (code=${r.code})`);
}
if (failed.length > 0) process.exit(1);
// ⏭ 环境不满足默认不判红：本机没构建 Tauri 产物是常态，永久红会训练人忽略红。
// 但覆盖率缩小必须被看见——汇总显式列名+原因，且 --strict-env（发布前闸门）把缩水也判红。
if (envBlocked.length > 0 && args.includes("--strict-env")) {
  console.log("# --strict-env：环境前置不满足在发布闸门下判红（覆盖率为 100% 才算过）");
  process.exit(1);
}
console.log("# 🟢 门禁组全部通过");
