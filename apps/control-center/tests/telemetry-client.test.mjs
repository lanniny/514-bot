/**
 * P-21 前端埋点采集器测试（v48 S0-3）。
 *
 * 锁死三条承诺：永不阻塞主流程、失败静默、调用面即白名单。
 * 纯 ESM 无 DOM 依赖，request 由测试注入。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTelemetryClient } from "../public/modules/telemetry-client.js";

function recorder({ fail = false, hang = false } = {}) {
  const calls = [];
  const request = (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    if (hang) return new Promise(() => {}); // 永不 settle，模拟慢网络
    return fail ? Promise.reject(new Error("network down")) : Promise.resolve({});
  };
  return { calls, request };
}

/** 让 fire-and-forget 的微任务链跑完 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

test("trackView 上报视图并带 surface", async () => {
  const { calls, request } = recorder();
  const client = createTelemetryClient({ request });
  client.trackView("workbench");
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/telemetry/record");
  assert.equal(calls[0].body.type, "usage.view");
  assert.equal(calls[0].body.fields.view, "workbench");
});

test("同一视图在去抖窗口内只上报一次", async () => {
  const { calls, request } = recorder();
  const client = createTelemetryClient({ request });
  client.trackView("bot");
  client.trackView("bot");
  client.trackView("bot");
  await flush();
  assert.equal(calls.length, 1, "setView 在一次导航中可能被多次调用，不去抖会让访问数失真");
  client.trackView("team");
  await flush();
  assert.equal(calls.length, 2, "不同视图不受彼此去抖影响");
});

test("能力调用不去抖——每次调用都是独立产品事实", async () => {
  const { calls, request } = recorder();
  const client = createTelemetryClient({ request });
  client.trackCapability("run.create", "success");
  client.trackCapability("run.create", "success");
  await flush();
  assert.equal(calls.length, 2);
});

test("track* 全部返回 undefined —— 结构上杜绝误 await", () => {
  const { request } = recorder();
  const client = createTelemetryClient({ request });
  assert.equal(client.trackView("bot"), undefined);
  assert.equal(client.trackCapability("x"), undefined);
  assert.equal(client.trackDelegation("codex"), undefined);
  assert.equal(client.trackIntervention("steer"), undefined);
  assert.equal(client.trackFriction("error", { errorKind: "network" }), undefined);
});

test("网络失败被静默吞掉，不冒泡到调用方", async () => {
  const { request } = recorder({ fail: true });
  const client = createTelemetryClient({ request });
  const rejections = [];
  const onRejection = (error) => rejections.push(error);
  process.on("unhandledRejection", onRejection);
  try {
    client.trackView("config");
    await flush();
    assert.equal(rejections.length, 0, "埋点失败绝不能产生未捕获拒绝");
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("背压：在途请求达上限后丢弃新事件而非堆积", async () => {
  const { calls, request } = recorder({ hang: true });
  const client = createTelemetryClient({ request });
  for (const view of ["a", "b", "c", "d", "e", "f"]) client.trackView(view);
  await flush();
  assert.equal(calls.length, 4, "MAX_INFLIGHT=4，其余丢弃不排队");
});

test("trackIntervention 拒绝枚举外取值", async () => {
  const { calls, request } = recorder();
  const client = createTelemetryClient({ request });
  client.trackIntervention("steer");
  client.trackIntervention("drop-table");
  client.trackIntervention("");
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.fields.intervention, "steer");
});

test("trackFriction 只接受已知种类，errorKind 是分类码不是错误文本", async () => {
  const { calls, request } = recorder();
  const client = createTelemetryClient({ request });
  client.trackFriction("error", { errorKind: "network" });
  client.trackFriction("unknown-kind", { errorKind: "network" });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.type, "friction.error");
  assert.equal(calls[0].body.fields.errorKind, "network");
  // 调用面不接受 message/stack 等自由文本入口
  assert.ok(!("message" in calls[0].body.fields));
});

test("setEnabled(false) 后停止上报", async () => {
  const { calls, request } = recorder();
  const client = createTelemetryClient({ request });
  client.trackView("overview");
  await flush();
  assert.equal(calls.length, 1);
  client.setEnabled(false);
  assert.equal(client.isEnabled(), false);
  client.trackView("market");
  client.trackCapability("run.create");
  await flush();
  assert.equal(calls.length, 1, "关闭后不得再有任何上报");
});

test("空参数被忽略，不发出无意义事件", async () => {
  const { calls, request } = recorder();
  const client = createTelemetryClient({ request });
  client.trackView("");
  client.trackView(null);
  client.trackCapability("");
  client.trackActivationStep("");
  await flush();
  assert.equal(calls.length, 0);
});

test("缺少 request 时构造即失败——不静默变成空实现", () => {
  assert.throws(() => createTelemetryClient({}), /requires request/);
});
