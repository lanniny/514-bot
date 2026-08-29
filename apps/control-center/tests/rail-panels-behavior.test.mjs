import test from "node:test";
import assert from "node:assert/strict";
import { createRailPanels, parseUnifiedDiff } from "../public/modules/rail-panels.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

class FakeNode {
  constructor() {
    this.innerHTML = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.listeners = new Map();
    this.classList = {
      add() {},
      remove() {},
      toggle() {},
    };
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  focus() {}
}

function createHarness() {
  const selectors = [
    "#rail-review-body",
    "#rail-review-stat",
    "#rail-review-range",
    "#rail-browser-form",
    "#rail-browser-url",
    "#rail-browser-empty",
    "#rail-browser-history",
    "#rail-files-path",
    "#rail-files-list",
    "#rail-files-preview",
    "#rail-files-filter",
    "#rail-files-editor",
    "#rail-files-editor-status",
    "#rail-files-save",
    "#rail-files-revert",
  ];
  const nodes = new Map(selectors.map((selector) => [selector, new FakeNode()]));
  const root = new FakeNode();
  root.querySelector = (selector) => nodes.get(selector) || null;
  root.clickPath = (path) => {
    const listener = root.listeners.get("click");
    listener?.({
      preventDefault() {},
      target: {
        closest(selector) {
          if (selector === "[data-rail-files-path]") {
            return { disabled: false, dataset: { railFilesPath: path } };
          }
          return null;
        },
      },
    });
  };
  root.clickSelector = (selector) => {
    const listener = root.listeners.get("click");
    listener?.({
      preventDefault() {},
      target: {
        closest(candidate) {
          return candidate === selector ? nodes.get(selector) : null;
        },
      },
    });
  };
  root.inputSelector = (selector) => {
    root.listeners.get("input")?.({
      target: {
        closest(candidate) {
          return candidate === selector ? nodes.get(selector) : null;
        },
      },
    });
  };
  return { root, nodes };
}

function panelOptions(harness, request) {
  return {
    root: harness.root,
    request,
    runsEndpoint: "/api/runs",
    getRunId: () => "run-1",
    getRun: () => ({ id: "run-1", worktreePath: "C:/worktree" }),
    icon: (name) => `<i>${name}</i>`,
  };
}

test("late review responses cannot overwrite the latest request", async () => {
  const harness = createHarness();
  const calls = [];
  const request = (_url, options = {}) => {
    const pending = deferred();
    calls.push({ ...pending, signal: options.signal });
    return pending.promise;
  };
  const panels = createRailPanels(panelOptions(harness, request));

  panels.activate("review");
  panels.activate("review");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].signal.aborted, true, "后选请求应主动取消旧请求");
  calls[1].resolve({ diff: "", stat: "0 files changed", status: "second-result", worktree: "w2", base: "b" });
  await settle();
  calls[0].resolve({ diff: "", stat: "0 files changed", status: "stale-first-result", worktree: "w1", base: "b" });
  await settle();

  const markup = harness.nodes.get("#rail-review-body").innerHTML;
  assert.match(markup, /second-result/);
  assert.doesNotMatch(markup, /stale-first-result|差异读取失败/);
  panels.destroy();
});

test("late workspace responses cannot replace a newer directory", async () => {
  const harness = createHarness();
  const pending = new Map();
  const request = (url) => {
    const path = new URL(url, "http://control.local").searchParams.get("path") || "";
    if (!path) {
      return Promise.resolve({ type: "directory", path: "", entries: [], truncated: false, bounds: { entries: 240 } });
    }
    const value = deferred();
    pending.set(path, value);
    return value.promise; // deliberately ignores AbortSignal; generation ownership must still hold
  };
  const panels = createRailPanels(panelOptions(harness, request));
  panels.activate("files");
  await settle();

  harness.root.clickPath("A");
  harness.root.clickPath("B");
  pending.get("B").resolve({
    type: "directory",
    path: "B",
    entries: [{ name: "b.txt", path: "B/b.txt", type: "file", openable: true }],
    truncated: true,
    bounds: { entries: 240 },
  });
  await settle();
  pending.get("A").resolve({
    type: "directory",
    path: "A",
    entries: [{ name: "a.txt", path: "A/a.txt", type: "file", openable: true }],
    truncated: false,
    bounds: { entries: 240 },
  });
  await settle();

  assert.equal(harness.nodes.get("#rail-files-path").textContent, "/B");
  const markup = harness.nodes.get("#rail-files-list").innerHTML;
  assert.match(markup, /b\.txt/);
  assert.match(markup, /仅返回前 240 个可见条目/);
  assert.doesNotMatch(markup, /a\.txt/);
  panels.destroy();
});

test("a late file save cannot repaint a newer file preview", async () => {
  const harness = createHarness();
  const save = deferred();
  const file = (path, content, revision) => ({
    type: "file",
    path,
    file: {
      name: path,
      content,
      language: "text",
      binary: false,
      redacted: false,
      truncated: false,
      editable: true,
      revision,
    },
  });
  const request = (url, options = {}) => {
    const path = new URL(url, "http://control.local").searchParams.get("path") || "";
    if (options.method === "PUT") return save.promise; // deliberately ignores AbortSignal
    if (!path) return Promise.resolve({ type: "directory", path: "", entries: [], truncated: false });
    if (path === "A.txt") return Promise.resolve(file("A.txt", "alpha", "a".repeat(64)));
    return Promise.resolve(file("B.txt", "bravo", "b".repeat(64)));
  };
  const panels = createRailPanels(panelOptions(harness, request));
  panels.activate("files");
  await settle();
  harness.root.clickPath("A.txt");
  await settle();

  const editor = harness.nodes.get("#rail-files-editor");
  editor.value = "alpha changed";
  harness.root.inputSelector("#rail-files-editor");
  harness.root.clickSelector("#rail-files-save");
  harness.root.clickPath("B.txt");
  await settle();
  assert.match(harness.nodes.get("#rail-files-preview").innerHTML, /B\.txt/);

  save.resolve(file("A.txt", "alpha changed", "c".repeat(64)));
  await settle();
  assert.match(harness.nodes.get("#rail-files-preview").innerHTML, /B\.txt/);
  assert.doesNotMatch(harness.nodes.get("#rail-files-preview").innerHTML, /A\.txt/);
  panels.destroy();
});

test("diff parsing keeps complete counts while bounding rendered lines", () => {
  const additions = Array.from({ length: 605 }, (_, index) => `+line-${index + 1}`).join("\n");
  const [file] = parseUnifiedDiff(`diff --git a/large.txt b/large.txt\n@@ -1,0 +1,605 @@\n${additions}\n`);
  assert.equal(file.additions, 605);
  assert.equal(file.lines.length, 600);
  assert.equal(file.truncated, true);
});

test("diff parsing keeps content lines that begin with file-header markers", () => {
  const [file] = parseUnifiedDiff([
    "diff --git a/operators.txt b/operators.txt",
    "--- a/operators.txt",
    "+++ b/operators.txt",
    "@@ -1 +1 @@",
    "---old",
    "+++new",
  ].join("\n"));
  assert.equal(file.deletions, 1);
  assert.equal(file.additions, 1);
  assert.deepEqual(file.lines.slice(1).map(({ kind, text }) => ({ kind, text })), [
    { kind: "del", text: "--old" },
    { kind: "add", text: "++new" },
  ]);
});

test("review rendering discloses its local file limit", async () => {
  const harness = createHarness();
  const diff = Array.from({ length: 41 }, (_, index) => [
    `diff --git a/file-${index}.txt b/file-${index}.txt`,
    "@@ -0,0 +1 @@",
    "+value",
  ].join("\n")).join("\n");
  const panels = createRailPanels(panelOptions(harness, async () => ({
    diff,
    stat: "41 files changed, 41 insertions(+)",
    status: "",
    worktree: "w",
    base: "b",
    truncated: false,
  })));
  panels.activate("review");
  await settle();

  const markup = harness.nodes.get("#rail-review-body").innerHTML;
  assert.match(markup, /差异包含 41 个文件，仅显示前 40 个/);
  assert.match(markup, /file-39\.txt/);
  assert.doesNotMatch(markup, /file-40\.txt/);
  panels.destroy();
});
