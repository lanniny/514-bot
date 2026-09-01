import test from "node:test";
import assert from "node:assert/strict";
import { isBusy, runAsyncAction } from "../public/modules/async-action.js";

/** 最小 DOM 替身：只实现 runAsyncAction 用到的成员。 */
function fakeButton({ disabled = false, html = "<span>保存</span>" } = {}) {
  const node = {
    dataset: {},
    disabled,
    innerHTML: html,
    isConnected: true,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    querySelector(selector) {
      if (selector !== "span") return null;
      const match = /<span>([\s\S]*?)<\/span>/.exec(this.innerHTML);
      return match ? { textContent: match[1] } : null;
    },
    get textContent() {
      return this.innerHTML.replace(/<[^>]*>/g, "");
    },
  };
  return node;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("busy state is applied during the action and fully restored afterwards", async () => {
  const button = fakeButton();
  const seen = [];
  await runAsyncAction(button, async () => {
    seen.push({ disabled: button.disabled, busy: button.attributes["aria-busy"], label: button.textContent });
    await tick();
  }, { busyLabel: "保存中…" });

  assert.equal(seen[0].disabled, true, "执行期间必须禁用");
  assert.equal(seen[0].busy, "true", "执行期间必须对读屏标记 aria-busy");
  assert.equal(seen[0].label, "保存中…", "执行期间显示忙态文案");
  assert.equal(button.disabled, false, "结束后必须恢复可点");
  assert.equal(button.attributes["aria-busy"], undefined, "结束后必须摘掉 aria-busy");
  assert.equal(button.innerHTML, "<span>保存</span>", "结束后必须还原原始内容");
});

test("re-entrant clicks are ignored instead of double-submitting", async () => {
  const button = fakeButton();
  let calls = 0;
  const task = async () => {
    calls += 1;
    // 忙态中再触发一次：应被直接忽略
    assert.equal(await runAsyncAction(button, async () => { calls += 100; }), undefined);
    await tick();
  };
  await runAsyncAction(button, task);
  assert.equal(calls, 1, "同一按钮忙态期间的二次调用必须被拦截");
});

test("failures still restore the button (no permanently stuck controls)", async () => {
  const button = fakeButton();
  await assert.rejects(
    runAsyncAction(button, async () => {
      await tick();
      throw new Error("boom");
    }),
    /boom/,
    "异常必须继续抛给调用方，保留既有 toast 逻辑",
  );
  assert.equal(button.disabled, false, "失败路径也必须恢复");
  assert.equal(button.attributes["aria-busy"], undefined);
  assert.equal(isBusy(button), false);
});

test("a button that was disabled before the action stays disabled", async () => {
  const button = fakeButton({ disabled: true });
  await runAsyncAction(button, async () => { await tick(); });
  assert.equal(button.disabled, true, "不能覆盖「本来就应禁用」的初始状态（如 failClosed）");
});

test("restore is skipped silently when the view re-rendered the button away", async () => {
  const button = fakeButton();
  await runAsyncAction(button, async () => {
    button.isConnected = false; // 模拟 innerHTML 重建导致节点脱离文档
    await tick();
  });
  assert.equal(button.isConnected, false);
  assert.equal(button.dataset.busy, "1", "节点已脱离文档时无需恢复，也不得抛错");
});

test("a missing button degrades to running the task directly", async () => {
  let ran = false;
  await runAsyncAction(null, async () => { ran = true; });
  assert.equal(ran, true);
});
