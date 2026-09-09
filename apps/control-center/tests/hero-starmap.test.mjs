import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { activityFromPanel, memberGlyph } from "../public/hero-starmap.js";

const publicRoot = resolve(import.meta.dirname, "../public");

test("starmap glyphs prefer CJK names then brand seats", () => {
  assert.equal(memberGlyph({ name: "烛", brand: "codex" }), "烛");
  assert.equal(memberGlyph({ name: "Claude Fable", brand: "claude" }), "主");
  assert.equal(memberGlyph({ name: "Kimi", brand: "kimi" }), "前");
  assert.equal(memberGlyph({ name: "", brand: "unknown" }), "?");
});

test("starmap activity follows the selected team, not six hardcoded CLI families", () => {
  const activity = activityFromPanel({
    teamName: "514cc",
    coordinatorId: "claude-fable",
    agents: [
      { id: "claude-fable", name: "主脑", brand: "claude", role: "规划", status: "busy", layer: "leader", currentTask: "拆任务" },
      { id: "codex-technical", name: "烛", brand: "codex", role: "实现", status: "ready" },
      { id: "grok-researcher", name: "织", brand: "grok", role: "检索", status: "offline" },
    ],
    flows: [
      { from: "claude-fable", to: "codex-technical", type: "delegate", count: 2 },
      { from: "codex-technical", to: "codex-technical", type: "self" },
    ],
  });
  assert.equal(activity.teamName, "514cc");
  assert.deepEqual(activity.members.map((member) => member.id), [
    "claude-fable",
    "codex-technical",
    "grok-researcher",
  ]);
  assert.equal(activity.members[0].active, true);
  assert.equal(activity.members[0].coordinator, true);
  assert.equal(activity.members[0].glyph, "主");
  assert.equal(activity.members[1].active, false);
  assert.equal(activity.members[1].glyph, "烛");
  assert.deepEqual([...activity.edges], ["claude-fable~codex-technical"]);
});

test("empty panel yields an empty constellation instead of the old six-family default", () => {
  const activity = activityFromPanel(null);
  assert.equal(activity.members.length, 0);
  assert.equal(activity.edges.size, 0);
  assert.equal(activity.teamName, "未选择团队");
});

test("team page owns the starmap and hero is only an alias into that surface", async () => {
  const [index, app, starmap, palette] = await Promise.all([
    readFile(resolve(publicRoot, "index.html"), "utf8"),
    readFile(resolve(publicRoot, "app.js"), "utf8"),
    readFile(resolve(publicRoot, "hero-starmap.js"), "utf8"),
    readFile(resolve(publicRoot, "modules/palette-catalog.js"), "utf8"),
  ]);
  assert.match(index, /id="team-starmap-root"/);
  assert.doesNotMatch(index, /id="view-hero"|id="hero-container"|data-view="hero"|src="\.\/hero-starmap\.js"/);
  assert.match(app, /if \(view === "hero"\)/);
  assert.match(app, /revealTeamStarmap/);
  assert.match(starmap, /export function mountTeamStarmap/);
  assert.match(starmap, /export function activityFromPanel/);
  assert.doesNotMatch(starmap, /bootWhenReady|getElementById\("hero-container"\)/);
  assert.match(palette, /hero: \{ icon: "orbit", keywords: "hero constellation 星图/);
});
