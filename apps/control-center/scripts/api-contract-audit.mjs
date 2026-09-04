#!/usr/bin/env node
/**
 * UI↔后端 API 契约对账报告（v49 · 2026-09-04）。
 *
 * 抽取与判定口径全部委托 `src/api-contract.mjs`（单一真相源）——本脚本只负责
 * 把结果渲染成人读的报告。机械门禁在 `tests/api-contract.test.mjs`。
 *
 * 为什么分成脚本 + 测试两份消费者：
 *   · 测试回答"能不能提交"（红/绿），信息密度低但必须每次跑
 *   · 脚本回答"现在到底什么状况"（清单 + 出处），用于排查与决策
 * 两者共用同一抽取器，避免第二份口径带来第二套盲区
 * （首版把正则写在脚本里，测试再抄一份 —— 那正是漂移的种子）。
 *
 * 用法：
 *   node scripts/api-contract-audit.mjs          # 人读报告
 *   node scripts/api-contract-audit.mjs --json   # 机器可读
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_UI_LESS, auditApiContract } from "../src/api-contract.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function main() {
  const asJson = process.argv.includes("--json");
  const report = auditApiContract({
    serverPath: resolve(ROOT, "server.mjs"),
    publicDir: resolve(ROOT, "public"),
    repoRoot: ROOT,
  });

  if (asJson) {
    console.log(JSON.stringify({ ...report, knownUiLess: KNOWN_UI_LESS }, null, 2));
    return;
  }

  const { counts, orphans, dead, staleWhitelist } = report;
  console.log(`后端路由 ${counts.backendExact} 条精确 + ${counts.backendPrefix} 条前缀`);
  console.log(`前端调用 ${counts.frontendCalls} 条（归一化去重，含 \${API.x}/suffix 拼接）`);
  console.log(`已登记无 UI 入口 ${counts.whitelisted} 条\n`);

  console.log(`── orphan-call：前端调、后端无（运行时必 404）${orphans.length} 条 ──`);
  if (!orphans.length) console.log("  ✓ 无");
  for (const item of orphans) {
    console.log(`  ✗ ${item.path}`);
    for (const site of item.sites.slice(0, 3)) console.log(`      ${site}`);
    if (item.sites.length > 3) console.log(`      …另 ${item.sites.length - 3} 处`);
  }

  console.log(`\n── dead-endpoint：后端有、前端不调且未登记 ${dead.length} 条 ──`);
  if (!dead.length) console.log("  ✓ 无");
  for (const item of dead) console.log(`  · ${item.methods.join("/")} ${item.path}`);

  if (staleWhitelist.length) {
    console.log(`\n── 白名单过期项（已接 UI，应从 KNOWN_UI_LESS 删除）${staleWhitelist.length} 条 ──`);
    for (const path of staleWhitelist) console.log(`  ! ${path}`);
  }

  console.log("\n── 已登记的无 UI 入口能力（死能力账本，只应变短）──");
  for (const [path, reason] of Object.entries(KNOWN_UI_LESS)) {
    console.log(`  · ${path}\n      ${reason}`);
  }

  const failures = orphans.length + dead.length + staleWhitelist.length;
  console.log(failures ? `\n✗ ${failures} 项需要处理` : "\n✓ 契约对账通过");
  process.exitCode = failures ? 1 : 0;
}

main();
