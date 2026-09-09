/**
 * 自动化独立页契约：路由、模板诚实性、导航入口、不假装闲时/保持唤醒。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  AUTOMATION_TEMPLATES,
  automationRouteHash,
  isAutomationWritable,
  parseAutomationRoute,
  scheduleIssue,
  scheduleLabel,
} from "../public/modules/automations-page.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

test("parseAutomationRoute covers list / create / edit / history", () => {
  assert.deepEqual(parseAutomationRoute("#automations"), { mode: "list", id: null });
  assert.deepEqual(parseAutomationRoute("#automations/new"), { mode: "create", id: null });
  assert.deepEqual(parseAutomationRoute("#automations/abc"), { mode: "edit", id: "abc" });
  assert.deepEqual(parseAutomationRoute("#automations/abc/history"), { mode: "history", id: "abc" });
  assert.deepEqual(parseAutomationRoute("#workbench"), { mode: "list", id: null });
});

test("automation aliases preserve editor and history identity without importing the Bot shell", () => {
  assert.equal(automationRouteHash("#bot/automations/abc/history"), "#automations/abc/history");
  assert.equal(automationRouteHash("#/automations/new"), "#automations/new");
  assert.equal(automationRouteHash("#bot?conversation=abc"), "#automations");
  assert.deepEqual(parseAutomationRoute("#bot/automations/abc/history"), { mode: "history", id: "abc" });
});

test("scheduleLabel and scheduleIssue stay on the real manual/idle/every:n grammar", () => {
  assert.equal(scheduleLabel("manual"), "仅手动");
  assert.equal(scheduleLabel("idle"), "闲时");
  assert.equal(scheduleLabel("every:1d"), "每天");
  assert.equal(scheduleLabel("every:30m"), "每 30 分钟");
  assert.equal(scheduleIssue("manual"), "");
  assert.equal(scheduleIssue("idle"), "");
  assert.equal(scheduleIssue("every:6h"), "");
  assert.match(scheduleIssue("0 9 * * 1-5"), /every/);
});

test("automation write controls fail closed for degraded or unavailable stores", () => {
  assert.equal(isAutomationWritable({ writable: true, state: "ready", failClosed: false }), true);
  assert.equal(isAutomationWritable({ writable: true, state: "degraded", failClosed: false }), false);
  assert.equal(isAutomationWritable({ writable: true, state: "ready", failClosed: true }), false);
  assert.equal(isAutomationWritable({ writable: false, state: "ready", failClosed: false }), false);
});

test("idle templates ride the real idle queue, not a manual placeholder", () => {
  const idle = AUTOMATION_TEMPLATES.filter((item) => item.kind === "idle");
  const scheduled = AUTOMATION_TEMPLATES.filter((item) => item.kind === "scheduled");
  assert.ok(idle.length >= 3);
  assert.ok(scheduled.length >= 3);
  assert.ok(idle.every((item) => item.schedule === "idle"));
  assert.ok(idle.every((item) => /闲时/.test(item.footer)));
  assert.ok(idle.every((item) => !/尚未接电/.test(item.footer)));
  assert.ok(scheduled.every((item) => item.schedule.startsWith("every:")));
});

test("automations is a first-class create view, not a dialog-only leftover", async () => {
  const [html, app, state, css, panel, settingsRailChrome] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/state.js`, "utf8"),
    readFile(`${appRoot}/public/forge/automations.css`, "utf8"),
    readFile(`${appRoot}/public/modules/automations-page.js`, "utf8"),
    readFile(`${appRoot}/public/modules/settings-rail-chrome.js`, "utf8"),
  ]);
  assert.match(html, /id="view-automations"[^>]*data-view-panel="automations"/);
  assert.doesNotMatch(app, /view === "automations" \? "workbench"/);
  assert.match(html, /id="rail-search-row"[\s\S]*id="rail-automations-row"[\s\S]*id="rail-skills-row"/);
  assert.match(html, /id="rail-skills-row"[\s\S]*lucide-wand-sparkles[\s\S]*技能/);
  assert.match(app, /rail-skills-row[\s\S]*setView\("capabilities"/);
  assert.match(html, /id="automations-workbench"/);
  assert.match(html, /href="\.\/forge\/automations\.css"/);
  const settingsRail = html.match(/<aside class="settings-rail" id="settings-rail"[\s\S]*?<\/aside>/)?.[0] || "";
  // 2026-08-30 IA 对齐：自动化升为设置轨「治理」条目（与主导航一致）；协作台左栏
  // 的 rail-automations-row 快捷入口仍是第一现场。
  // 2026-09-09 侧栏迁移：设置轨内的产品导航改为动态挂载（data-nav-surface="settings"，
  // 静态 HTML 为空），自动化条目由 NAV_GROUPS 单一真源渲染——改验真源而非静态标记。
  assert.match(settingsRail, /data-nav-surface="settings"/, "设置轨缺少迁移导航动态挂载点");
  const { navViews } = await import("../public/modules/nav-config.js");
  assert.ok(navViews().includes("automations"), "NAV_GROUPS 单一真源缺少 automations 条目");
  assert.doesNotMatch(html, /rail-block-automations|id="automations-list"|id="automations-manage-button"/);
  assert.match(state, /automations:\s*"自动化"/);
  assert.match(app, /mountAutomationsPage\(/);
  // 面包屑分组已由 NAV_GROUPS 单源反推（2026-08-30 PM 走查：手写 FORGE_VIEW_GROUPS 与
  // 导航组漂移——team 显示「Agent 能力」而导航在「协作」）。automations 归「治理」组。
  assert.match(app, /Object\.fromEntries\(NAV_GROUPS\.flatMap/, "面包屑分组必须由 NAV_GROUPS 单源反推");
  assert.doesNotMatch(settingsRailChrome, /revealWorkbenchAutomations|is-automations/);
  assert.match(app, /#automations\/\$\{/);
  assert.match(app, /function openAutomationManager\(/);
  assert.match(app, /__forgeAutomationsPage\?\.compose/);
  assert.match(panel, /#automations\/new/);
  assert.match(panel, /创建闲时任务/);
  assert.match(panel, /data-auto-action="create-idle"/);
  assert.doesNotMatch(panel, /disabled title="闲时调度尚未接电"/); // 闲时已接电，不许再装成禁用占位
  assert.doesNotMatch(panel, /尚未接电/);
  assert.match(panel, /还没有运行记录/);
  assert.match(panel, /变更前确认/);
  assert.match(panel, /运行时默认/);
  assert.match(panel, /const inFlight = new Set\(\)/);
  assert.match(panel, /runOnce\(`save:\$\{payload\.id \|\| "new"\}`/);
  assert.match(panel, /runOnce\(`run:\$\{id\}`/);
  assert.match(panel, /runOnce\(`toggle:\$\{id\}`/);
  assert.doesNotMatch(panel, /grok-4\.6|option value="claude"|option value="codex"/); // 模型目录跟真实配置走，不写死运行时名
  assert.doesNotMatch(panel, /保持电脑唤醒|keep-awake|keepAwake/);
  assert.doesNotMatch(css, /keep-awake|keepAwake/);
  assert.doesNotMatch(css, /\.workbench-shell/);
  assert.match(css, /#view-automations/);
});
