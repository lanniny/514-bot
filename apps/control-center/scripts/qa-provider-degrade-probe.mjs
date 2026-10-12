// Provider 绑定降级端到端探针（隔离仓保留 swift-responder 的悬空 providerId，不做消毒）：
//  ① 服务端从仓配置启动不再崩溃（修复前 exit 1）；
//  ② 启动日志出现 provider binding degraded 警告；
//  ③ /api/runtime-seats 的 live 目录条目：providerId 已降级为 null + providerDegraded 原因；
//  ④ 席位编辑器对该席位显示「按 Adapter 管理降级运行」警告条。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnTestServer, stopTestServer, waitForUrl } from "../tests/server-fixture.mjs";
import { buildIsolatedServerEnv, createIsolatedQaRepo } from "./qa-team-workspace.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const token = "provider-degrade-probe";
const qaRoot = await mkdtemp(join(tmpdir(), "provider-degrade-"));
let server;
let browser;
try {
  await createIsolatedQaRepo(qaRoot); // 不做任何消毒——悬空 providerId 原样进隔离仓
  server = spawnTestServer({ env: buildIsolatedServerEnv({ qaRoot, token }) });
  let stderr = "";
  server.stderr?.on("data", (chunk) => { stderr += chunk; });
  const url = await waitForUrl(server); // ① 能等到 URL 即证明服务端没再崩溃
  const origin = new URL(url).origin;
  console.log("BOOT-OK:", origin);

  const degradedLog = stderr.split("\n").filter((line) => line.includes("provider binding degraded"));
  console.log("DEGRADED-LOG:", JSON.stringify(degradedLog));

  const seatsResponse = await fetch(`${origin}/api/runtime-seats`, { headers: { authorization: `Bearer ${token}` } });
  const seatsText = await seatsResponse.text();
  let seatsPayload = null;
  try { seatsPayload = JSON.parse(seatsText); } catch { /* 鉴权/路由异常时原文输出 */ }
  if (!seatsPayload) {
    console.log("SEATS-RAW:", seatsResponse.status, seatsText.slice(0, 160));
    throw new Error(`runtime-seats payload not json: ${seatsResponse.status}`);
  }
  const live = (seatsPayload.runtimeProfiles || []).find((item) => item.id === "swift-responder");
  console.log("LIVE-ENTRY:", JSON.stringify({
    status: seatsResponse.status,
    providerId: live?.providerId,
    provider: live?.provider,
    providerDegraded: live?.providerDegraded,
    teamMemberEligible: live?.teamMemberEligible,
  }));

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1512, height: 945 } });
  await page.addInitScript(() => { try { localStorage.setItem("514cc-product-tour-dismissed", "1"); } catch {} }); // 首跑导览对话框会挡视口点击（D-2026-09-28-018）
  const errs = [];
  page.on("pageerror", (e) => errs.push(`PAGEERROR: ${String(e).slice(0, 200)}`));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 20_000 });
  await page.evaluate(() => { location.hash = "config/sources"; });
  await page.waitForSelector('#runtime-seat-list [data-runtime-seat-id="swift-responder"]', { timeout: 30_000 });
  await page.locator('[data-runtime-seat-id="swift-responder"]').click();
  await page.waitForSelector("#runtime-seat-form:not([hidden])", { timeout: 10_000 });
  await page.waitForTimeout(600);
  const editorPeek = await page.evaluate(() => ({
    providerSelect: document.getElementById("runtime-seat-provider-select")?.value,
    scope: document.getElementById("runtime-seat-provider-scope")?.textContent?.trim(),
    scopeClass: document.getElementById("runtime-seat-provider-scope")?.className,
  }));
  console.log("EDITOR-PEEK:", JSON.stringify(editorPeek));
  await page.screenshot({ path: ".qa-output/seat-picker/provider-degraded-note.png" });
  console.log("ERRORS:", errs.length);
  errs.slice(0, 4).forEach((e) => console.log(" -", e));
} finally {
  if (browser) await browser.close();
  if (server) await stopTestServer(server, { token }).catch(() => server.kill("SIGKILL"));
  await rm(qaRoot, { recursive: true, force: true });
}
