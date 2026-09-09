/**
 * 顶栏 ‹ › 双栈：同页不入栈、前进栈在新分支清空、死循环目标丢弃。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  historyShortcutBlocked,
  pushUnique,
  recordRouteChange,
  routeKey,
  sameRoute,
  stepHistory,
} from "../public/modules/view-history.js";

const workbench = { view: "workbench", settingsFocus: null, configSurface: null, capabilityWorkspace: "skills" };
const appearance = { view: "appearance", settingsFocus: null, configSurface: null, capabilityWorkspace: "skills" };
const hooks = { view: "config", settingsFocus: null, configSurface: "hooks", capabilityWorkspace: "skills" };
const skills = { view: "config", settingsFocus: null, configSurface: "capabilities", capabilityWorkspace: "skills" };
const mcp = { view: "config", settingsFocus: null, configSurface: "capabilities", capabilityWorkspace: "mcp" };
const memory = { view: "observability", settingsFocus: "memory", configSurface: null, capabilityWorkspace: "skills" };
const obs = { view: "observability", settingsFocus: null, configSurface: null, capabilityWorkspace: "skills" };

test("routeKey treats config surface and skill/mcp workspace as distinct pages", () => {
  assert.notEqual(routeKey(hooks), routeKey(skills));
  assert.notEqual(routeKey(skills), routeKey(mcp));
  assert.notEqual(routeKey(obs), routeKey(memory));
  assert.equal(sameRoute(skills, { ...skills }), true);
});

test("automation history keeps list, editor and run-history destinations distinct", () => {
  const list = { view: "automations" };
  const editor = { view: "automations", automationHash: "#automations/task-a" };
  const history = { view: "automations", automationHash: "#automations/task-a/history" };
  assert.notEqual(routeKey(list), routeKey(editor));
  assert.notEqual(routeKey(editor), routeKey(history));
  assert.equal(sameRoute(history, { ...history, automationHash: "#bot/automations/task-a/history" }), true);
  const next = stepHistory("back", { back: [history], forward: [], current: workbench });
  assert.deepEqual(next.target, history);
});

test("recordRouteChange ignores mute, same route, and duplicate tops", () => {
  const first = recordRouteChange(workbench, appearance, { back: [] });
  assert.equal(first.recorded, true);
  assert.equal(first.back.length, 1);
  const dup = recordRouteChange(workbench, appearance, { back: first.back });
  assert.equal(dup.back.length, 1);
  const muted = recordRouteChange(appearance, workbench, { back: first.back, mute: true });
  assert.equal(muted.recorded, false);
  assert.equal(muted.back.length, 1);
  const same = recordRouteChange(appearance, appearance, { back: first.back });
  assert.equal(same.recorded, false);
});

test("stepHistory back then forward restores the branch", () => {
  const recorded = recordRouteChange(workbench, appearance, { back: [] });
  const back = stepHistory("back", { back: recorded.back, forward: [], current: appearance });
  assert.deepEqual(back.target, workbench);
  assert.equal(back.back.length, 0);
  assert.equal(sameRoute(back.forward.at(-1), appearance), true);
  const forward = stepHistory("forward", { back: back.back, forward: back.forward, current: workbench });
  assert.deepEqual(forward.target, appearance);
  assert.equal(sameRoute(forward.back.at(-1), workbench), true);
  assert.equal(forward.forward.length, 0);
});

test("a new branch after back clears the abandoned forward stack at the app layer", () => {
  const afterBack = stepHistory("back", {
    back: [workbench],
    forward: [],
    current: appearance,
  });
  const next = recordRouteChange(workbench, hooks, { back: afterBack.back });
  assert.equal(next.recorded, true);
  assert.equal(sameRoute(next.back.at(-1), workbench), true);
});

test("stepHistory drops a no-op target that already matches current", () => {
  const stuck = stepHistory("back", { back: [appearance], forward: [], current: appearance });
  assert.equal(stuck.target, null);
  assert.equal(stuck.back.length, 0);
});

test("pushUnique respects the 50-entry ceiling", () => {
  let stack = [];
  for (let index = 0; index < 52; index += 1) {
    stack = pushUnique(stack, {
      view: "config",
      settingsFocus: null,
      configSurface: `s${index}`,
      capabilityWorkspace: "skills",
    });
  }
  assert.equal(stack.length, 50);
  assert.equal(stack[0].configSurface, "s2");
});

test("history shortcuts stay quiet in dialogs and editable fields", () => {
  assert.equal(historyShortcutBlocked({ defaultPrevented: true, target: { closest: () => null } }), true);
  assert.equal(historyShortcutBlocked({
    defaultPrevented: false,
    target: { closest: (sel) => sel.includes("input") ? {} : null },
  }), true);
});
