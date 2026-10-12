/**
 * qa-bot-inbox-panel.mjs — Bot 会话协作收件箱面板的**真浏览器**验收。
 *
 * 为什么必须有这一层：`tests/bot-ops-inbox-wiring.test.mjs` 是静态断言，只能证明
 * 「app.js 里有这些调用」，证明不了「面板真的会出现、真的只取一次数、真的换会话就换归属」。
 * 2026-09-11 那次故障的形态恰恰是：四件套齐备 + 静态看起来都对，面板却永久 hidden。
 *
 * 五项：
 *   A 无会话时不摆空面板（守住「还没有会话」≠「待办是 0」）
 *   B 进入会话并展开右栏后面板**真实可见**（含祖先链的 isVisible，不是只看 hidden 属性）
 *   C 稳定态不自增（没有轮询式重取）
 *   D 展开「待我处理」触发一次 force 重取
 *   E 切会话换归属：请求带新会话 id；切回旧会话只多一次，不重复取数
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { spawnTestServer, stopTestServer, waitForUrl } from "../tests/server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const token = "qa-bot-inbox-panel-token";

async function main() {
  const root = await mkdtemp(resolve(appRoot, ".qa-bot-inbox-panel-"));
  const dataRoot = resolve(root, "data");
  const fakeHome = resolve(root, "home");
  await mkdir(fakeHome, { recursive: true });

  const outputDir = resolve(appRoot, ".qa-output", `bot-inbox-panel-${Math.random().toString(36).slice(2, 8)}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const child = spawnTestServer({
    env: {
      CONTROL_CENTER_TOKEN: token,
      CONTROL_CENTER_DATA_DIR: dataRoot,
      CONTROL_CENTER_PORT: "0",
      HOME: fakeHome,
      USERPROFILE: fakeHome,
    },
  });

  let browser;
  const checks = [];
  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? "  ✔" : "  ✖"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    const bootstrapUrl = await waitForUrl(child);
    const origin = new URL(bootstrapUrl).origin;
    const nonce = new URL(bootstrapUrl).searchParams.get("bootstrap");
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const api = async (path, { method = "GET", body } = {}) => {
      const response = await fetch(new URL(path, origin), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(payload)}`);
      return payload;
    };
    const deepLink = (conversationId) => `${origin}/?bootstrap=${encodeURIComponent(nonce)}#conversation=${encodeURIComponent(conversationId)}`;

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const inboxRequests = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/bots/inbox")) inboxRequests.push(request.url());
    });
    const countFor = (conversationId) => inboxRequests.filter((url) => url.includes(encodeURIComponent(conversationId))).length;
    const openRail = async () => {
      await page.locator("#bot-agent-info-button").click();
      await page.waitForSelector("#bot-agent-panel:not([hidden])", { timeout: 10_000 });
    };
    const waitReady = () => page.waitForFunction(
      () => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true,
      null,
      { timeout: 30_000 },
    );

    await page.addInitScript(() => {
      localStorage.setItem("514cc-product-tour-dismissed", "1");
    });

    // ── A：还没有任何会话时不摆空面板 ────────────────────────────────────────
    await page.goto(`${bootstrapUrl}#bot`, { waitUntil: "domcontentloaded" });
    await waitReady();
    await openRail();
    const bareVisible = await page.locator("#bot-ops-inbox").isVisible().catch(() => false);
    record("A 无会话时不摆空面板（#bot-ops-inbox 不可见）", bareVisible === false, `visible=${bareVisible}`);
    await page.locator("#bot-agent-panel-close").click().catch(() => {});

    // 造两个会话（放在 A 之后：A 要的就是「一个会话都没有」的现场）
    const catalog = (await api("/api/team-members"))?.members ?? [];
    assert.ok(catalog.length >= 1, "成员目录不能为空");
    const first = catalog[0];
    const second = catalog.find((member) => member.id !== first.id) ?? first;
    const conversationA = (await api("/api/conversations", {
      method: "POST",
      body: { kind: "direct", title: "收件箱验收 A", directMemberId: first.id },
    })).conversation;
    const conversationB = (await api("/api/conversations", {
      method: "POST",
      body: { kind: "direct", title: "收件箱验收 B", directMemberId: second.id },
    })).conversation;

    // ── B：进入会话后面板真实可见 ────────────────────────────────────────────
    await page.goto(deepLink(conversationA.id), { waitUntil: "domcontentloaded" });
    await waitReady();
    await openRail();
    await page.waitForFunction(() => document.querySelector("#bot-ops-inbox")?.hidden === false, null, { timeout: 15_000 })
      .catch(() => {});
    const conversationVisible = await page.locator("#bot-ops-inbox").isVisible().catch(() => false);
    // <details> 收起时子节点不参与渲染（innerText 会是空串），所以先展开再读。
    // 这一步同时把「展开能读到内容」也验了：面板可见但里面是空的，等于没接线。
    if (await page.locator("#bot-ops-inbox").getAttribute("open") === null) {
      await page.locator("#bot-ops-inbox > summary").click();
      await page.waitForTimeout(1200);
    }
    const listVisible = await page.locator("#bot-ops-inbox-list").isVisible().catch(() => false);
    const listText = (await page.locator("#bot-ops-inbox-list").innerText().catch(() => "")).trim();
    record(
      "B 进入会话后面板真实可见、展开有内容且不是读取失败",
      conversationVisible === true && listVisible === true && listText.length > 0 && !listText.includes("读取失败"),
      `panel=${conversationVisible} list=${listVisible} text=${JSON.stringify(listText.slice(0, 50))}`,
    );

    // ── C：稳定态不自增 ─────────────────────────────────────────────────────
    await page.waitForTimeout(1500);
    const steadyBefore = inboxRequests.length;
    await page.waitForTimeout(3000);
    const steadyAfter = inboxRequests.length;
    record("C 稳定态不自增（无轮询式重取）", steadyAfter === steadyBefore, `${steadyBefore} → ${steadyAfter}`);

    // ── D：收起再展开触发一次 force 重取 ────────────────────────────────────
    await page.locator("#bot-ops-inbox > summary").click(); // 收起
    await page.waitForTimeout(600);
    const aBeforeExpand = countFor(conversationA.id);
    await page.locator("#bot-ops-inbox > summary").click(); // 展开
    await page.waitForTimeout(1200);
    const aAfterExpand = countFor(conversationA.id);
    record("D 收起再展开触发一次 force 重取", aAfterExpand === aBeforeExpand + 1, `${aBeforeExpand} → ${aAfterExpand}`);

    // ── E：切会话换归属 ─────────────────────────────────────────────────────
    const rowB = page.locator(`[data-bot-conversation="${conversationB.id}"]`);
    await rowB.waitFor({ state: "visible", timeout: 15_000 });
    await rowB.click();
    await page.waitForTimeout(1500);
    const bFirst = countFor(conversationB.id);
    // 面板归属已经换到 B；<details> 的展开态跨会话保留，内容应随之重写成 B 的收件箱。
    const listTextB = (await page.locator("#bot-ops-inbox-list").innerText().catch(() => "")).trim();
    record(
      "E1 切到会话 B：请求带新会话 id",
      bFirst >= 1 && listTextB.length > 0,
      `B 请求=${bFirst} list=${JSON.stringify(listTextB.slice(0, 40))}`,
    );

    const rowA = page.locator(`[data-bot-conversation="${conversationA.id}"]`);
    await rowA.waitFor({ state: "visible", timeout: 15_000 });
    await rowA.click();
    await page.waitForTimeout(1500);
    const aAfterSwitchBack = countFor(conversationA.id);
    record(
      "E2 切回会话 A：只多一次请求（同会话已 resolved 不重复取数）",
      aAfterSwitchBack === aAfterExpand + 1,
      `${aAfterExpand} → ${aAfterSwitchBack}`,
    );
    record("E3 全程无页面异常", pageErrors.length === 0, `pageErrors=${pageErrors.length}`);

    await page.screenshot({ path: resolve(outputDir, "bot-inbox-panel.png") });
    await writeFile(resolve(outputDir, "report.json"), JSON.stringify({ checks, inboxRequests, pageErrors }, null, 2), "utf8");
    console.log(`\n报告：${resolve(outputDir, "report.json")}`);
    console.log(`检查项 ${checks.length} 条：`);
    const failed = checks.filter((item) => !item.ok);
    if (failed.length) {
      console.log(`失败 ${failed.length} 条：${failed.map((item) => item.name).join("、")}`);
      process.exitCode = 1;
    } else {
      console.log("全部通过");
    }
  } finally {
    await browser?.close();
    await stopTestServer(child, { token }).catch((error) => console.log("stop err:", error.message));
    await rm(root, { recursive: true, force: true });
  }
}

await main();
