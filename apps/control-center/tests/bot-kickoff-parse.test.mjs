import test from "node:test";
import assert from "node:assert/strict";
import {
  collectKickoffMentions,
  parseComposerKickoff,
  shouldComposerKickoff,
  normalizeKickoffTasks,
} from "../public/modules/bot-kickoff-parse.js";

const members = [
  { id: "claude-fable", label: "Master", tokenLabel: "Master" },
  { id: "codex-technical", label: "烛", tokenLabel: "烛" },
  { id: "grok-search", label: "织", tokenLabel: "织" },
];

test("parseComposerKickoff splits @A do X @B do Y into two handoff tasks", () => {
  const parsed = parseComposerKickoff("@烛 do X @织 do Y", members);
  assert.deepEqual(parsed.assigneeIds, ["codex-technical", "grok-search"]);
  assert.equal(parsed.tasks[0].text, "do X");
  assert.equal(parsed.tasks[1].text, "do Y");
});

test("parseComposerKickoff keeps a shared preamble on each assignee", () => {
  const parsed = parseComposerKickoff("请两位分别处理 @Master 规划 @烛 实现", members);
  assert.deepEqual(parsed.assigneeIds, ["claude-fable", "codex-technical"]);
  assert.equal(parsed.tasks[0].text, "请两位分别处理 规划");
  assert.equal(parsed.tasks[1].text, "请两位分别处理 实现");
});

test("parseComposerKickoff accepts member ids and does not kick off a single @", () => {
  assert.equal(parseComposerKickoff("@codex-technical 只修这一处", members), null);
  assert.equal(parseComposerKickoff("没有点名的普通消息", members), null);
  const parsed = parseComposerKickoff("@claude-fable 看方案 @codex-technical 写补丁", members);
  assert.deepEqual(parsed.assigneeIds, ["claude-fable", "codex-technical"]);
});

test("shouldComposerKickoff is group-only", () => {
  const text = "@Master 规划 @烛 实现";
  assert.equal(shouldComposerKickoff(text, members, { conversationKind: "workspace_group" }), true);
  assert.equal(shouldComposerKickoff(text, members, { conversationKind: "direct" }), false);
  assert.equal(shouldComposerKickoff("@烛 单独一条", members, { conversationKind: "workspace_group" }), false);
});

test("collectKickoffMentions prefers the longest token and ignores unknown @names", () => {
  const mentions = collectKickoffMentions("@claude-fable hello @nobody @烛", members);
  assert.deepEqual(mentions.map((item) => item.memberId), ["claude-fable", "codex-technical"]);
});

test("normalizeKickoffTasks rejects outsiders and de-dupes assignees", () => {
  const allowed = new Set(["claude-fable", "codex-technical"]);
  assert.deepEqual(
    normalizeKickoffTasks([
      { assigneeId: "claude-fable", text: "plan" },
      { assigneeId: "claude-fable", text: "again" },
      { assigneeId: "codex-technical", text: "build" },
    ], { allowedIds: allowed }).map((task) => task.assigneeId),
    ["claude-fable", "codex-technical"],
  );
  assert.throws(
    () => normalizeKickoffTasks([{ assigneeId: "outsider", text: "no" }], { allowedIds: allowed }),
    { code: "NOT_TEAM_MEMBER" },
  );
});
