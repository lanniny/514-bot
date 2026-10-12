// 右栏页签端到端验收（真实浏览器 + 隔离持久服务；无任何模型调用）。
//
// 为什么必须跑真浏览器：2026-09-11 的教训——`hidden` 属性 ≠ 真实可见性，
// 面板可能被**祖先链**上的 display:none 连带藏死（recovery_ack 就是这样丢的）。
// 页签恰恰是"CSS 按 data-rail-tab 显隐"的设计，静态断言只能证明属性被写对，
// 证明不了用户真的看得到面板。所以这里一律用含祖先链的 isVisible()。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { spawnTestServer, testModelProfiles, waitForUrl } from "../tests/server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const token = "bot-rail-tabs-isolated-qa-token";
const root = await mkdtemp(resolve(tmpdir(), "514cc-bot-rail-tabs-"));
const repoRoot = resolve(root, "repo");
const runtimeRoot = resolve(root, "runtime");
const dataRoot = resolve(root, "data");
await mkdir(resolve(repoRoot, "config/control-center"), { recursive: true });
await mkdir(runtimeRoot, { recursive: true });
await mkdir(resolve(appRoot, ".qa-output"), { recursive: true });
const output = await mkdtemp(resolve(appRoot, ".qa-output/bot-rail-tabs-"));
const saveConfig = (name, value) => writeFile(resolve(repoRoot, `config/control-center/${name}.json`), JSON.stringify(value));
await saveConfig("models", { version: 1, profiles: testModelProfiles().map((profile, index) => ({ ...profile, command: `missing-rail-qa-${index}` })) });
await saveConfig("routing", { version: 1, primaryCoordinator: "claude-fable", technicalExecutor: "codex-technical", maxRounds: 6, maxDepth: 2, maxParallelAgents: 4, requireHealthyProvider: false, failOnUnavailableExplicitProvider: false, weights: { quality: .44, speed: .26, health: .22, cost: .08 }, rules: [], independentPass: { requiredFor: [], mustDifferFromPrimary: true } });
await saveConfig("permissions", { version: 1, defaultMode: "plan", modes: { plan: { write: false, approvalRequired: false }, build: { write: "workspace", approvalRequired: true } }, limits: { maxRounds: 6, maxBudgetUsdPerTurn: 2, turnTimeoutMs: 10000 }, approval: { ttlMs: 60000 } });
await saveConfig("sources", { version: 1, explicit: ["models", "routing", "permissions", "sources"].map((name) => ({ id: `control.${name}`, path: `config/control-center/${name}.json`, label: name, kind: "json", scope: "repo", critical: true })), discover: [], runtime: [] });

const child = spawnTestServer({ env: {
  CONTROL_CENTER_TOKEN: token,
  CONTROL_CENTER_PORT: "0",
  CONTROL_CENTER_DATA_DIR: dataRoot,
  CONTROL_CENTER_REPO_ROOT: repoRoot,
  CONTROL_CENTER_TEST_REPO_ROOT: repoRoot,
  CONTROL_CENTER_RUNTIME_HOME: runtimeRoot,
} });

let browser;
const report = { ok: false, productionExecution: false, checks: [], screenshots: [], errors: [], visibleChain: [] };

try {
  const origin = new URL(await waitForUrl(child)).origin;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.addInitScript((value) => {
    sessionStorage.setItem("514cc-control-token", value);
    localStorage.setItem("514cc-product-tour-dismissed", "1");
    // 右栏默认展开（"0"），否则页签条在收起的面板里，点不到
    localStorage.setItem("514cc-bot-ops-collapsed", "0");
    // 只在**本标签页第一次加载**时清空页签关闭态：addInitScript 每次导航都会跑，
    // 无条件清空会把「刷新后仍在」这条断言直接测废（QA 首版就栽在这里）。
    if (!sessionStorage.getItem("514cc-rail-qa-seeded")) {
      localStorage.removeItem("514cc.bot-rail-tabs.v1");
      sessionStorage.setItem("514cc-rail-qa-seeded", "1");
    }
  }, token);

  const check = (name) => report.checks.push(name);
  const shot = async (name) => {
    await page.screenshot({ path: resolve(output, `${name}.png`) });
    report.screenshots.push(`${name}.png`);
  };
  const railTab = () => page.locator("#bot-ops-rail").getAttribute("data-rail-tab");
  const waitTab = (tab) => page.waitForFunction(
    (expected) => document.querySelector("#bot-ops-rail")?.dataset.railTab === expected,
    tab,
    { timeout: 10000 },
  );
  /** 含祖先链的可见性判定：这是 2026-09-11 教训的落地，不能用 hidden 属性代替。 */
  const visibleChain = async (selector) => {
    const chain = await page.evaluate((sel) => {
      const node = document.querySelector(sel);
      if (!node) return { found: false, steps: [] };
      const steps = [];
      let current = node;
      while (current && current !== document.documentElement) {
        const style = getComputedStyle(current);
        steps.push({
          tag: current.tagName.toLowerCase(),
          id: current.id || null,
          cls: typeof current.className === "string" ? current.className : null,
          display: style.display,
          visibility: style.visibility,
          hidden: current.hasAttribute("hidden"),
        });
        current = current.parentElement;
      }
      return { found: true, steps };
    }, selector);
    report.visibleChain.push({ selector, ...chain });
    return chain;
  };

  await page.goto(`${origin}/#bot`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok"), null, { timeout: 30000 });
  await page.locator("#bot-ops-rail").waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#bot-rail-page-tabs").waitFor({ state: "visible", timeout: 10000 });
  check("rail-visible-with-tab-strip");
  await shot("00-initial");

  // 1. 初始停在会话页
  assert.equal(await railTab(), "overview");
  assert.equal(await page.locator("#bot-rail-tab-overview").getAttribute("aria-selected"), "true");
  assert.equal(await page.locator("#bot-ops-approvals").isVisible(), false);
  check("initial-tab-is-overview");

  // 2. 点「审批」→ 属性切换 + 面板真的可见（含祖先链）
  await page.locator("#bot-rail-tab-approvals").click();
  await waitTab("approvals");
  assert.equal(await page.locator("#bot-rail-tab-approvals").getAttribute("aria-selected"), "true");
  assert.equal(await page.locator("#bot-ops-approvals").isVisible(), true, "点页签后面板必须真实可见");
  await visibleChain("#bot-ops-approvals");
  await shot("01-approvals");
  check("click-approvals-shows-panel");

  // 3. 点「文件」→ 内容真的渲染出来（不是空壳）
  await page.locator("#bot-rail-tab-files").click();
  await waitTab("files");
  assert.equal(await page.locator("#bot-ops-files").isVisible(), true);
  assert.equal(await page.locator("#bot-ops-approvals").isVisible(), false, "非当前页签的面板必须收起");
  await shot("02-files");
  check("click-files-shows-panel-and-hides-others");

  // 4. 点「终端」→ 终端页可见 + 容器有真实尺寸（0 尺寸守卫的反向证明）
  await page.locator("#bot-rail-tab-terminal").click();
  await waitTab("terminal");
  assert.equal(await page.locator("#bot-ops-terminal").isVisible(), true);
  // 抽屉必须已被搬进页签页
  assert.equal(
    await page.evaluate(() => document.querySelector("#bot-ops-terminal-mount")?.contains(document.querySelector("#bot-terminal-drawer")) === true),
    true,
    "终端抽屉必须挂在 #bot-ops-terminal-mount 里",
  );
  await page.waitForFunction(() => {
    const box = document.querySelector("#bot-terminal-container")?.getBoundingClientRect();
    return Boolean(box && box.width > 120 && box.height > 80);
  }, null, { timeout: 15000 });
  const terminalBox = await page.evaluate(() => {
    const box = document.querySelector("#bot-terminal-container")?.getBoundingClientRect();
    return box ? { width: Math.round(box.width), height: Math.round(box.height) } : null;
  });
  report.terminalBox = terminalBox;
  await shot("03-terminal");
  check(`terminal-page-has-real-size(${terminalBox.width}x${terminalBox.height})`);

  // 5. 关闭「终端」页 → 落回会话页 + 页签从条上收起 + 落盘
  await page.locator('#bot-rail-tab-terminal [data-bot-rail-tab-close="terminal"]').click();
  await waitTab("overview");
  assert.equal(await page.locator("#bot-rail-tab-terminal").isVisible(), false, "关闭后页签必须从条上收起");
  const stored = await page.evaluate(() => localStorage.getItem("514cc.bot-rail-tabs.v1"));
  assert.equal(stored, JSON.stringify(["terminal"]), `关闭态必须落盘，实际 ${stored}`);
  await shot("04-terminal-closed");
  check("close-tab-falls-back-and-persists");

  // 6. 「＋」菜单重开
  await page.locator("#bot-rail-tab-add").click();
  await page.locator("#bot-rail-tab-menu").waitFor({ state: "visible" });
  await page.locator('[data-bot-rail-menu="terminal"]').click();
  await waitTab("terminal");
  assert.equal(await page.locator("#bot-rail-tab-terminal").isVisible(), true);
  await shot("05-menu-reopen");
  check("plus-menu-reopens-closed-tab");

  // 7. 键盘：方向键漫游 + Delete 关闭
  await page.locator("#bot-rail-tab-overview").focus();
  await page.keyboard.press("ArrowRight");
  await waitTab("approvals");
  await page.keyboard.press("Delete");
  await waitTab("overview");
  assert.equal(await page.locator("#bot-rail-tab-approvals").isVisible(), false);
  check("keyboard-roam-and-delete-close");

  // 8. 快捷键 Ctrl+Shift+A 重开并激活审批页
  await page.keyboard.press("Control+Shift+KeyA");
  await waitTab("approvals");
  assert.equal(await page.locator("#bot-ops-approvals").isVisible(), true);
  check("shortcut-ctrl-shift-a");

  // 9. 刷新后关闭态仍在（持久化真的生效）。注意要先关一个页签——
  // 前面的重开动作已经把集合清空了，不重新关就直接刷新是测不出持久化的。
  // 另外这里故意关的是**非当前**页签（当前是审批）：关闭非当前页不得把用户
  // 从正在看的页面上拽走，只有关掉当前页才回落到会话页。
  const activeBeforeClose = await railTab();
  await page.locator('#bot-rail-tab-files [data-bot-rail-tab-close="files"]').click();
  assert.equal(await page.locator("#bot-rail-tab-files").isVisible(), false, "关闭后页签必须从条上收起");
  assert.equal(await railTab(), activeBeforeClose, "关闭非当前页签不得改变当前页");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#bot-rail-page-tabs").waitFor({ state: "visible", timeout: 20000 });
  assert.equal(await page.locator("#bot-rail-tab-files").isVisible(), false, "刷新后被关掉的页签必须仍是关着的");
  await waitTab("overview");
  await page.locator("#bot-rail-tab-add").click();
  await page.locator("#bot-rail-tab-menu").waitFor({ state: "visible" });
  assert.equal(await page.locator('[data-bot-rail-menu="files"]').isVisible(), true, "关掉的页签必须能从「＋」菜单找回");
  await page.locator('[data-bot-rail-menu="files"]').click();
  await waitTab("files");
  check("closed-state-survives-reload-and-recoverable");

  // 10. 分组折叠：状态落 data-collapsed，且 CSS 只收 body（标题必须留着让用户能展开回来）
  // 注意先回「会话」页：分组住在 .bot-inspector-scroll 里，工具页签下整块被 CSS 收起
  // （这本身就是"页签显隐规则"在起作用，不是缺陷）。
  await page.locator("#bot-rail-tab-overview").click();
  await waitTab("overview");
  const firstGroupToggle = page.locator("[data-bot-rail-group]").first();
  if (await firstGroupToggle.isVisible()) {
    const groupName = await firstGroupToggle.getAttribute("data-bot-rail-group");
    await firstGroupToggle.click();
    const collapsed = await page.evaluate(
      (name) => document.querySelector(`[data-bot-rail-group="${name}"]`)?.closest(".bot-rail-group")?.hasAttribute("data-collapsed") === true,
      groupName,
    );
    assert.equal(collapsed, true, "点分组标题后必须落 data-collapsed");
    assert.equal(await firstGroupToggle.isVisible(), true, "折叠只收 body，标题必须保留");
    assert.equal(await page.evaluate(
      (name) => {
        const toggle = document.querySelector(`[data-bot-rail-group="${name}"]`);
        const body = document.getElementById(toggle?.getAttribute("aria-controls") || "");
        return body ? getComputedStyle(body).display !== "none" : false;
      },
      groupName,
    ), false, "折叠后 body 必须真的不可见");
    const storedGroups = await page.evaluate(() => JSON.parse(localStorage.getItem("514cc.bot-rail-groups.v1") || "{}"));
    assert.equal(storedGroups[groupName], true, `折叠态必须落盘（实际 ${JSON.stringify(storedGroups)}）`);
    await firstGroupToggle.click();
    check(`group-fold-${groupName}-collapses-and-persists`);
  } else {
    check("group-fold-skipped");
  }

  // 11. 拖拽分隔条：宽度变量必须真的写进去
  const grip = page.locator("#bot-ops-grip");
  if (await grip.isVisible()) {
    const before = await page.evaluate(() => document.querySelector(".bot-shell-grid")?.style.getPropertyValue("--bot-ops"));
    const box = await grip.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 80, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    const after = await page.evaluate(() => document.querySelector(".bot-shell-grid")?.style.getPropertyValue("--bot-ops"));
    assert.notEqual(after, before, "拖拽后 --bot-ops 必须变化");
    report.drag = { before, after };
    check("splitter-drag-writes-css-var");
  } else {
    report.drag = { skipped: "grip not visible at this viewport" };
    check("splitter-skipped");
  }

  report.ok = report.errors.length === 0;
} catch (error) {
  report.errors.push(`fatal: ${error?.message || String(error)}`);
} finally {
  await browser?.close().catch(() => {});
  child.kill("SIGTERM");
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

const reportPath = resolve(output, "report.json");
await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
console.log(`报告：${reportPath}`);
console.log(`检查项 ${report.checks.length} 条：`);
for (const item of report.checks) console.log(`  ✔ ${item}`);
if (report.errors.length) {
  console.error("失败：");
  for (const item of report.errors) console.error(`  ✖ ${item}`);
  process.exit(1);
}
console.log("全部通过");
