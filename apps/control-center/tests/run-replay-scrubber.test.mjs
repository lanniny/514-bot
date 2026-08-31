import test from "node:test";
import assert from "node:assert/strict";
import { createRunReplayScrubber, clampIndex, normalizeReplayTimeline, replayEntryLabel } from "../public/modules/run-replay-scrubber.js";

const REPLAY_PAYLOAD = {
  schema: "514cc.run-replay/v1",
  runId: "run-1",
  status: "succeeded",
  timeline: [
    { id: "a", type: "run.created", source: "event-store", timestamp: "2026-08-30T00:00:01.000Z" },
    { id: "b", type: "bus.say", source: "bus", timestamp: "2026-08-30T00:00:02.000Z", agentId: "claude-fable" },
    { id: "c", type: "attempt.completed", source: "attempt", timestamp: "2026-08-30T00:00:03.000Z", agentId: "codex-technical" },
    { id: "d", type: "run.completed", source: "event-store", timestamp: "2026-08-30T00:00:04.000Z" },
  ],
  truncated: { events: false, bus: false, attempts: false, approvals: false },
};

function makeMount() {
  const parts = new Map();
  const mount = { innerHTML: "", hidden: false };
  mount.querySelector = (selector) => {
    if (!parts.has(selector)) {
      parts.set(selector, {
        textContent: "",
        innerHTML: "",
        hidden: false,
        addEventListener() {},
      });
    }
    return parts.get(selector);
  };
  mount.parts = parts;
  return mount;
}

test("normalizeReplayTimeline keeps bounded entries and honest truncation", () => {
  const model = normalizeReplayTimeline(REPLAY_PAYLOAD);
  assert.equal(model.entries.length, 4);
  assert.equal(model.startAt, Date.parse("2026-08-30T00:00:01.000Z"));
  assert.equal(model.endAt, Date.parse("2026-08-30T00:00:04.000Z"));
  assert.equal(model.status, "succeeded");
  const truncated = normalizeReplayTimeline({ timeline: [], truncated: { events: true } });
  assert.equal(truncated.truncated, true);
  assert.deepEqual(normalizeReplayTimeline(null).entries, []);
});

test("clampIndex and replayEntryLabel are position-safe", () => {
  assert.equal(clampIndex(-3, 4), 0);
  assert.equal(clampIndex(9, 4), 3);
  assert.equal(clampIndex(1.7, 4), 1);
  assert.equal(clampIndex(0, 0), 0);
  const entry = REPLAY_PAYLOAD.timeline[1];
  assert.match(replayEntryLabel(entry), /^bus\.say · claude-fable · /);
  assert.equal(replayEntryLabel(null), "");
});

test("scrubber fetches replay per run id with id-diff and fails closed on request error", async () => {
  const requests = [];
  let fail = false;
  const scrubber = createRunReplayScrubber({
    request: async (url) => {
      requests.push(url);
      if (fail) throw new Error("boom");
      return REPLAY_PAYLOAD;
    },
  });
  const mount = makeMount();
  scrubber.mount(mount);
  assert.match(mount.innerHTML, /data-replay-scrubber/);
  assert.match(mount.innerHTML, /data-rrs-range/);

  await scrubber.update("run-1");
  assert.deepEqual(requests, ["/api/runs/run-1/replay"]);
  // 拉取后定位到末位条目（run.completed），后续预览为空
  assert.match(mount.parts.get("[data-rrs-current]").textContent, /run\.completed/);
  assert.equal(mount.parts.get("[data-rrs-upcoming]").innerHTML, "");

  // 同一 run 重复 update 不重复拉取（id diff）
  await scrubber.update("run-1");
  assert.equal(requests.length, 1);

  // 强制刷新走 fetch
  await scrubber.update("run-2", { force: true });
  assert.equal(requests.length, 2);
  assert.match(requests[1], /run-2/);

  // 请求失败渲染空态而不是崩掉面板
  fail = true;
  await scrubber.update("run-3", { force: true });
  assert.match(mount.parts.get("[data-rrs-current]").textContent, /暂无可回放事件/);

  // null run 隐藏面板
  await scrubber.update(null);
  assert.equal(mount.hidden, true);
  scrubber.dispose();
});

test("scrubber rejects construction without request()", () => {
  assert.throws(() => createRunReplayScrubber({}), { name: "TypeError" });
});
