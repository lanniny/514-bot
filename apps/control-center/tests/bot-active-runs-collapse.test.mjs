/**
 * bot-active-runs-collapse.test.mjs — 「正在工作」栏折叠的活体契约（LO 2026-10-11 拍板：
 * 整栏一个总开关 + 每个状态分组各自可折 + 跨刷新记住）。
 *
 * 为什么必须上活体：`bot-workspace-chrome.test.mjs` 只证明 markup 长得对，证明不了
 * **点了之后 DOM 真的变了、刷新后真的还记得、runs 快照重渲染后没自己弹开**。
 * 这三件全是交互与状态保持，静态断言一律碰不到。
 *
 * 守四件事：
 *   ① 总开关：点标题行 → 栏下**全部**（筛选条 + 工具栏 + 所有分组行）一并收起，只剩标题 + 计数；
 *   ② 分组开关：点分组标题 → 该组行收起，但**行不离开 DOM**（展开是即时的，不重新取数据）；
 *   ③ 持久化：刷新后折叠态还在；
 *   ④ 重渲染不弹开：折叠后再来一条新 run（runs 快照变化 → renderBotActiveRuns 重跑），
 *      栏必须**仍然**是折着的——这是实现里专门防的回归（回贴折叠态的那三行）。
 *
 * 如实边界：本测试只造得出「待审批」一个分组（execute:false 会被编排器立刻标 succeeded；
 * interrupt 会把 waiting_approval 撤回 cancelled，都进不了第二个活跃分组）。
 * 「折叠一组不影响兄弟组」由 tests/bot-workspace-chrome.test.mjs 的双组用例覆盖。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, waitForUrl } from "./server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

// 首次运行会弹产品导览浮层，它会盖住整个页面——按真实用户的做法先关掉
async function dismissProductTour(page) {
  const skip = page.locator("#bot-product-tour-dialog [data-product-tour-skip], #bot-product-tour-dialog [data-product-tour-dismiss]").first();
  await skip.click({ timeout: 15_000 }).catch(async () => { await page.keyboard.press("Escape"); });
  await page.waitForFunction(() => !document.getElementById("bot-product-tour-dialog")?.open, null, { timeout: 10_000 });
}

test("「正在工作」栏：整栏可折、分组可折、刷新记得、新 run 到来不弹开", { timeout: 180_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-bot-runs-fold-"));
  const token = "bot-runs-fold-token";
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
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${JSON.stringify(payload)}`);
    return payload;
  };

  const catalog = (await api("/api/team-members")).members ?? [];
  const seat = catalog.find((member) => member.id === "claude-fable") ?? catalog[0];
  assert.ok(seat, "团队目录不能为空——本测试要求真实花名册");
  // execute:true + 默认 build 许可 → 停在 waiting_approval：真活跃态，且不启任何 CLI
  const created = [];
  for (let index = 0; index < 2; index += 1) {
    created.push(await api("/api/runs", {
      method: "POST",
      body: { prompt: `BOT_RUNS_FOLD_${index}`, execute: true, startAgentId: seat.id },
    }));
  }
  assert.ok(created.every((run) => run?.id), "两条 run 都必须建成功");

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(serverUrl, { waitUntil: "domcontentloaded" });
  await dismissProductTour(page);

  const row = page.locator("#bot-active-runs [data-bot-active-run]").first();
  await row.waitFor({ state: "visible", timeout: 30_000 });

  // 页面内快照：可见性 + 折叠相关属性一次读全
  const snapshot = () => page.evaluate(() => {
    const shown = (el) => Boolean(el)
      && el.hidden !== true
      && getComputedStyle(el).display !== "none"
      && el.getBoundingClientRect().width > 0;
    const section = document.getElementById("bot-active-runs");
    const body = document.getElementById("bot-active-runs-body");
    const toggle = document.getElementById("bot-active-runs-toggle");
    const toolbar = document.getElementById("bot-active-runs-toolbar");
    const list = document.getElementById("bot-active-runs-list");
    const group = document.querySelector("#bot-active-runs [data-bot-run-group]");
    const groupToggle = document.querySelector("#bot-active-runs [data-bot-run-group-toggle]");
    const rows = document.querySelector("#bot-active-runs .bot-active-run-rows");
    return {
      count: document.getElementById("bot-active-runs-count")?.textContent ?? "",
      sectionCollapsed: section?.classList.contains("is-collapsed") ?? null,
      sectionExpanded: toggle?.getAttribute("aria-expanded") ?? null,
      bodyShown: shown(body),
      toolbarShown: shown(toolbar),
      listShown: shown(list),
      rowShown: shown(document.querySelector("#bot-active-runs [data-bot-active-run]")),
      groupCollapsed: group?.classList.contains("is-collapsed") ?? null,
      groupExpanded: groupToggle?.getAttribute("aria-expanded") ?? null,
      rowsShown: shown(rows),
      // 折叠只许藏行，不许删行——行还在 DOM 里是「展开即时」的前提
      rowCount: document.querySelectorAll("#bot-active-runs [data-bot-active-run]").length,
    };
  });

  const initial = await snapshot();
  assert.equal(initial.count, "2", "正在工作计数必须是 2");
  assert.equal(initial.sectionCollapsed, false, "初始不得折叠");
  assert.equal(initial.sectionExpanded, "true", "初始 aria-expanded 必须为 true");
  assert.equal(initial.bodyShown, true, "初始栏下内容必须可见");
  assert.equal(initial.rowShown, true, "初始 run 行必须可见");
  assert.equal(initial.rowCount, 2, "两条 run 行都必须在 DOM 里");

  // ── ① 整栏折叠：栏下全部收起 ──
  await page.click("#bot-active-runs-toggle");
  const folded = await snapshot();
  assert.equal(folded.sectionCollapsed, true, "点标题行后 section 必须带 is-collapsed");
  assert.equal(folded.sectionExpanded, "false", "aria-expanded 必须翻成 false");
  assert.equal(folded.bodyShown, false, "栏下整体容器必须收起");
  assert.equal(folded.toolbarShown, false, "折叠必须连筛选条/工具栏一起收掉——LO 要的是「栏下全部可折叠」");
  assert.equal(folded.listShown, false, "折叠必须连行列表一起收掉");
  assert.equal(folded.count, "2", "折叠后计数仍要显示（只剩标题那一行也有信息量）");
  assert.equal(folded.rowCount, 2, "折叠只许藏行，不许把行从 DOM 里删掉");

  await page.click("#bot-active-runs-toggle");
  const reopened = await snapshot();
  assert.equal(reopened.bodyShown, true, "再点一次必须展开");
  assert.equal(reopened.sectionExpanded, "true", "再点一次 aria-expanded 必须翻回 true");
  assert.equal(reopened.rowShown, true, "展开后 run 行必须重新可见");

  // ── ② 分组折叠 ──
  await page.click("#bot-active-runs [data-bot-run-group-toggle]");
  const groupFolded = await snapshot();
  assert.equal(groupFolded.groupCollapsed, true, "点分组标题后该组必须带 is-collapsed");
  assert.equal(groupFolded.groupExpanded, "false", "分组 aria-expanded 必须翻成 false");
  assert.equal(groupFolded.rowsShown, false, "该组的行必须收起");
  assert.equal(groupFolded.rowCount, 2, "分组折叠同样只藏行不删行");
  assert.equal(groupFolded.listShown, true, "分组折叠不得连带收掉整栏");

  await page.click("#bot-active-runs [data-bot-run-group-toggle]");
  assert.equal((await snapshot()).rowsShown, true, "再点一次分组必须展开");

  // ── ③ + ④ 持久化 & 重渲染不弹开 ──
  // 顺序要紧：先折分组、再折整栏。反过来点的话分组开关还在 display:none 的 body 里，
  // 根本点不到（那不是产品缺陷，是测试自己的手顺序错了）。
  await page.click("#bot-active-runs [data-bot-run-group-toggle]"); // 先折分组
  await page.click("#bot-active-runs-toggle");                     // 再折整栏
  const beforeReload = await snapshot();
  assert.equal(beforeReload.bodyShown, false);
  assert.equal(beforeReload.rowsShown, false);

  const stored = await page.evaluate(() => localStorage.getItem("514cc-bot-active-runs-v1"));
  assert.ok(stored, "折叠态必须落 localStorage——LO 选了「记住」");
  const parsed = JSON.parse(stored);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.collapsed, true, "整栏折叠态必须持久化");
  assert.ok(Array.isArray(parsed.collapsedGroups) && parsed.collapsedGroups.length === 1,
    `分组折叠态必须持久化，实测 ${JSON.stringify(parsed.collapsedGroups)}`);

  await page.reload({ waitUntil: "domcontentloaded" });
  await dismissProductTour(page);
  // 等 attached 而不是 visible：刷新后整栏本该是折着的，行不可见正是契约。
  // （等 visible 会在这儿白等 30s——那是测试自己的手笨，不是产品缺陷。）
  await page.waitForSelector("#bot-active-runs [data-bot-active-run]", { state: "attached", timeout: 30_000 });
  const afterReload = await snapshot();
  assert.equal(afterReload.bodyShown, false, "刷新后整栏必须仍然是折着的");
  assert.equal(afterReload.sectionExpanded, "false", "刷新后 aria-expanded 必须仍然是 false");
  assert.equal(afterReload.rowsShown, false, "刷新后分组必须仍然是折着的");

  // ④ 关键回归：再来一条 run → runs 快照变化 → renderBotActiveRuns 重跑，栏不许自己弹开
  await api("/api/runs", {
    method: "POST",
    body: { prompt: "BOT_RUNS_FOLD_LATE", execute: true, startAgentId: seat.id },
  });
  await page.waitForFunction(
    () => document.getElementById("bot-active-runs-count")?.textContent === "3",
    null,
    { timeout: 30_000 },
  );
  const afterNewRun = await snapshot();
  assert.equal(afterNewRun.count, "3", "新 run 必须进栏（计数变 3）");
  assert.equal(afterNewRun.bodyShown, false, "新 run 到来触发重渲染后，整栏必须仍然折着——不许自己弹开");
  assert.equal(afterNewRun.sectionExpanded, "false", "新 run 到来后 aria-expanded 必须仍然是 false");
  assert.equal(afterNewRun.rowsShown, false, "新 run 到来后分组必须仍然折着");
  assert.equal(afterNewRun.rowCount, 3, "第三条行也必须已在 DOM 里（折叠不拦渲染）");
});
