import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeNotifications } from "../public/modules/native-notifications.js";

function harness({ permission = "granted", supported = true } = {}) {
  const sent = [];
  const toasts = [];
  const store = new Map();
  const originalLocalStorage = globalThis.localStorage;
  const originalNotification = globalThis.Notification;
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  if (supported) {
    globalThis.Notification = class FakeNotification {
      constructor(title, options) {
        sent.push({ title, body: options?.body, tag: options?.tag });
        this.close = () => {};
      }
      static permission = permission;
      static requestPermission = async () => permission;
    };
  } else {
    delete globalThis.Notification;
  }
  const notifications = createNativeNotifications({ toast: (message, tone) => toasts.push({ message, tone }) });
  return {
    notifications,
    sent,
    toasts,
    store,
    cleanup() {
      if (originalLocalStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = originalLocalStorage;
      if (originalNotification === undefined) delete globalThis.Notification;
      else globalThis.Notification = originalNotification;
    },
  };
}

test("W2.4 first sync primes the ledger without notifying historical pending approvals", async () => {
  const h = harness();
  try {
    h.notifications.syncApprovals([{ id: "a1", status: "pending", summary: "历史审批" }]);
    h.notifications.syncRuns([{ id: "r1", status: "completed", title: "历史任务" }]);
    assert.equal(h.sent.length, 0);
    // 开启开关后，新 pending 才通知
    assert.equal(await h.notifications.toggle(), true);
    h.notifications.syncApprovals([{ id: "a1", status: "pending", summary: "历史审批" }, { id: "a2", status: "pending", summary: "新审批" }]);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].tag, "514cc-approval");
    assert.match(h.sent[0].body, /新审批/);
  } finally {
    h.cleanup();
  }
});

test("W2.4 run terminal transition notifies once with dedupe and caps bursts at 3", async () => {
  const h = harness();
  try {
    h.notifications.syncRuns([{ id: "r1", status: "running" }]);
    await h.notifications.toggle();
    h.notifications.syncRuns([
      { id: "r1", status: "completed", title: "任务一" },
      { id: "r2", status: "failed", title: "任务二" },
      { id: "r3", status: "interrupted", title: "任务三" },
      { id: "r4", status: "error", title: "任务四" },
    ]);
    assert.equal(h.sent.length, 3, "批量终态最多 3 条");
    const again = h.sent.length;
    h.notifications.syncRuns([{ id: "r1", status: "completed", title: "任务一" }]);
    assert.equal(h.sent.length, again, "重复同步不重复通知");
    assert.ok(h.sent.some((item) => item.title === "任务失败"));
  } finally {
    h.cleanup();
  }
});

test("W2.4 disabled / unsupported / denied environments degrade silently", async () => {
  // 默认关闭：sync 不发
  const h1 = harness();
  try {
    h1.notifications.syncApprovals([]);
    h1.notifications.syncApprovals([{ id: "x", status: "pending", summary: "未开启" }]);
    assert.equal(h1.sent.length, 0);
    assert.equal(await h1.notifications.toggle(), true);
    h1.notifications.syncApprovals([{ id: "x", status: "pending", summary: "已开启" }]);
    assert.equal(h1.sent.length, 1);
  } finally {
    h1.cleanup();
  }
  // 不支持：toggle 返回 false + 提示
  const h2 = harness({ supported: false });
  try {
    assert.equal(await h2.notifications.toggle(), false);
    assert.match(h2.toasts[0]?.message || "", /不支持/);
  } finally {
    h2.cleanup();
  }
  // 权限拒绝：toggle 拒绝开启
  const h3 = harness({ permission: "denied" });
  try {
    assert.equal(await h3.notifications.toggle(), false);
    assert.equal(h3.sent.length, 0);
  } finally {
    h3.cleanup();
  }
});

test("W2.4 resolved approvals are evicted from the ledger", async () => {
  const h = harness();
  try {
    h.notifications.syncApprovals([{ id: "a1", status: "pending", summary: "一" }]);
    await h.notifications.toggle();
    h.notifications.syncApprovals([{ id: "a1", status: "pending", summary: "一" }, { id: "a2", status: "pending", summary: "二" }]);
    assert.equal(h.sent.length, 1);
    h.notifications.syncApprovals([{ id: "a2", status: "approved" }]);
    h.notifications.syncApprovals([{ id: "a3", status: "pending", summary: "三" }]);
    assert.equal(h.sent.length, 2, "a2 决议后出档，a3 照常通知");
    assert.match(h.sent[1].body, /三/);
  } finally {
    h.cleanup();
  }
});

test("W2.4 notifyCloseoutFailure delivers immediately when enabled", async () => {
  const h = harness();
  try {
    h.notifications.notifyCloseoutFailure("validate 未通过");
    assert.equal(h.sent.length, 0, "开关关闭时静默");
    await h.notifications.toggle();
    h.notifications.notifyCloseoutFailure("validate 未通过");
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].title, "收口失败");
    assert.match(h.sent[0].body, /validate/);
  } finally {
    h.cleanup();
  }
});
