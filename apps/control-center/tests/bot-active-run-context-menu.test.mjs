/**
 * bot-active-run-context-menu.test.mjs — Bot 面「正在工作」行的右键菜单回归。
 *
 * 病灶（LO 2026-10-10 实机截图）：右键「正在工作」里的 run 行，弹的是**浏览器原生菜单**
 * （返回/刷新/另存为/打印），不是 Console 的 run 菜单。根因是委托选择器集与点击链路不一致：
 *   - 这些行是 `[data-bot-active-run]`，挂在 `#bot-active-runs-list` 里，而 `#bot-active-runs`
 *     是 `#bot-agent-list` 的**兄弟**——`agentList.addEventListener("contextmenu")`
 *     （app.js）根本捕不到；
 *   - document 级那条委托只认 `[data-run-select]` / `[data-run-group-toggle]` /
 *     `[data-session-project]` / `[data-project-toggle]` / `[data-pinned-project]`，
 *     `[data-bot-active-run]` 五个分支全落空 → 不 preventDefault → 原生菜单。
 * 这与 DESIGN-NOTES.md 记过的同类病灶（聚合组右键落空）同源，只是换了个面复发。
 *
 * 契约（三层，机械判定）：
 *   ① contextmenu 必须被 preventDefault（否则浏览器菜单照弹）；
 *   ② 弹出的必须是 **run 菜单**（含「复制会话ID」等 run 专属项），且不是会话菜单；
 *   ③ 菜单项必须作用在**被右键的那一条 run** 上——建两条 run，右键 B，断言只 B 被置顶。
 *      第③层防「菜单能开但绑错了 run」（开了个装饰性菜单）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, waitForUrl } from "./server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

test("Bot 面「正在工作」行右键弹出 run 菜单，且作用于被右键的那一条 run", { timeout: 120_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-bot-run-ctx-"));
  const token = "bot-run-ctx-token";
  const child = spawnTestServer({
    env: { CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_DATA_DIR: dataRoot, CONTROL_CENTER_PORT: "0" },
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    await stopTestServer(child, { token }).catch(() => {});
    await rm(dataRoot, { recursive: true, force: true });
  });

  const serverUrl = await waitForUrl(child);
  const origin = new URL(serverUrl).origin;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const api = async (path, { method = "GET", body } = {}) => {
    const response = await fetch(new URL(path, origin), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${JSON.stringify(payload)}`);
    return payload;
  };

  const catalog = (await api("/api/team-members")).members ?? [];
  const seat = catalog.find((member) => member.id === "claude-fable") ?? catalog[0];
  assert.ok(seat, "团队目录不能为空——本测试要求真实花名册");

  // 两条 run：右键其中一条，另一条必须不受影响（第③层契约）
  // execute:false 会被编排器立刻标 succeeded（route-preview dry-run），「正在工作」区根本不渲染它；
  // execute:true + 默认 build 许可则停在 waiting_approval——真活跃态，且不启任何 CLI。
  const created = [];
  for (const tag of ["CTX_A", "CTX_B"]) {
    created.push(await api("/api/runs", {
      method: "POST",
      body: { prompt: `BOT_RUN_CTX_${tag}`, execute: true, startAgentId: seat.id },
    }));
  }
  const [runA, runB] = created;
  assert.ok(runA?.id && runB?.id, "两条 run 都必须建成功");

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(serverUrl, { waitUntil: "domcontentloaded" });
  // 首次运行会弹产品导览浮层，它会盖住整个页面——按真实用户的做法先关掉它，
  // 否则后面的菜单点击全被 dialog 拦截（那不是被测病灶，是测试环境噪声）。
  const tourSkip = page.locator("#bot-product-tour-dialog [data-product-tour-skip], #bot-product-tour-dialog [data-product-tour-dismiss]").first();
  await tourSkip.click({ timeout: 15_000 }).catch(async () => { await page.keyboard.press("Escape"); });
  await page.waitForFunction(() => !document.getElementById("bot-product-tour-dialog")?.open, null, { timeout: 10_000 });

  const rowB = page.locator(`#bot-active-runs [data-bot-active-run="${runB.id}"]`);
  await rowB.waitFor({ state: "visible", timeout: 30_000 });

  // 用页面内 dispatch 而不是 Playwright 的 dispatchEvent：要拿到 event.defaultPrevented 的真值
  const dispatched = await page.evaluate((runId) => {
    const row = document.querySelector(`#bot-active-runs [data-bot-active-run="${runId}"]`);
    if (!row) return { found: false };
    const rect = row.getBoundingClientRect();
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2),
    });
    row.dispatchEvent(event);
    const menu = document.getElementById("context-menu");
    return {
      found: true,
      defaultPrevented: event.defaultPrevented,
      menuHidden: menu.hidden,
      labels: [...menu.querySelectorAll("[role='menuitem'] span")].map((node) => node.textContent.trim()),
    };
  }, runB.id);

  assert.equal(dispatched.found, true, "正在工作区必须渲染出被右键的 run 行");
  // ① 原生菜单的唯一放行条件就是没被 preventDefault
  assert.equal(dispatched.defaultPrevented, true,
    "右键 run 行必须 preventDefault——没拦住就是浏览器原生菜单（LO 2026-10-10 实机病灶）");
  // ② 必须是 run 菜单
  assert.equal(dispatched.menuHidden, false, "contextmenu 必须弹出 #context-menu");
  assert.ok(dispatched.labels.includes("复制会话ID"),
    `弹出的必须是 run 菜单（含「复制会话ID」），实测：${dispatched.labels.join(" / ")}`);
  assert.ok(dispatched.labels.includes("在新工作树中继续"),
    `弹出的必须是 run 菜单（含「在新工作树中继续」），实测：${dispatched.labels.join(" / ")}`);
  assert.ok(!dispatched.labels.some((label) => label.includes("单独对话") || label.includes("会话内")),
    "不得弹成 Bot 会话菜单——两者的项集不同");

  // ③ 菜单项必须作用在被右键的那一条 run 上
  await page.locator("#context-menu [role='menuitem']", { hasText: "置顶任务" }).first().click();
  // patchRunMeta 是异步落盘的，轮询等它生效——不用固定 sleep 赌时序
  const readRuns = async () => Object.fromEntries(
    ((await api("/api/runs")).runs ?? []).map((run) => [run.id, run]),
  );
  let runsAfter = await readRuns();
  const deadline = Date.now() + 10_000;
  while (runsAfter[runB.id]?.pinned !== true && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 250));
    runsAfter = await readRuns();
  }
  // 失败时把页面上的 toast 一起带出来：patchRunMeta 失败只弹 toast、不抛，光看断言会误判成"没点上"
  const toasts = await page.evaluate(() =>
    [...document.querySelectorAll("[role='status'], [role='alert'], .toast")]
      .map((node) => node.textContent?.trim()).filter(Boolean).slice(0, 3));
  assert.equal(runsAfter[runB.id]?.pinned, true,
    `右键 B 行 → 菜单必须把 B 置顶（页面提示：${toasts.join(" | ") || "无"}）`);
  assert.notEqual(runsAfter[runA.id]?.pinned, true, "A 行未被右键，不得被置顶（菜单绑错 run 的哨兵）");
});
