/**
 * P-21 产品埋点层测试（v48 S0）。
 *
 * 重点不在"功能能跑"，而在锁死 LO 授权时的五条前提——尤其是隐私边界：
 * 这些断言一旦被后续改动破坏，说明埋点层已经越过了当初被批准的范围。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductTelemetry, filterFields, TELEMETRY_TYPES, unusedRegistered, REGISTERED_VIEWS } from "../src/product-telemetry.mjs";
import { REGISTERED_CAPABILITIES, PRODUCT_ACTION_IDS } from "../public/modules/product-telemetry-catalog.js";

async function withTelemetry(run, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "514cc-telemetry-"));
  const telemetry = new ProductTelemetry({ path: join(dir, "product-telemetry.jsonl"), ...options });
  try {
    await telemetry.init();
    return await run(telemetry, dir);
  } finally {
    await telemetry.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// ── 隐私红线（LO 授权前提，破坏即越权）──────────────────────────────────────

test("白名单丢弃一切未声明字段", () => {
  const out = filterFields({
    view: "workbench",
    prompt: "帮我重构这个模块",
    filePath: "C:/Users/16643/secrets/api-keys.json",
    userMessage: "我的密码是 hunter2",
    apiKey: "sk-proj-abc123",
    stackTrace: "Error at line 42",
  });
  assert.deepEqual(out, { view: "workbench" }, "只有白名单字段应当保留");
  for (const leaked of ["prompt", "filePath", "userMessage", "apiKey", "stackTrace"]) {
    assert.ok(!(leaked in out), `${leaked} 绝不能进入埋点`);
  }
});

test("slug 校验剥离路径、URL 与自然语言，只留标识符字符", () => {
  assert.equal(filterFields({ view: "../../etc/passwd" }).view, "....etcpasswd");
  assert.equal(filterFields({ capability: "https://evil.example.com/x?token=abc" }).capability,
    "https:evil.example.comx?token=abc".replace(/[^A-Za-z0-9._:-]/g, ""));
  // 中文自由文本被完全剥离 → 返回 undefined → 字段不落盘
  assert.equal(filterFields({ action: "用户说了一段很长的话" }).action, undefined);
  assert.ok(!("action" in filterFields({ action: "用户说了一段很长的话" })));
});

test("受控枚举字段拒绝枚举外取值", () => {
  assert.equal(filterFields({ outcome: "success" }).outcome, "success");
  assert.equal(filterFields({ outcome: "任意注入内容" }).outcome, undefined);
  assert.equal(filterFields({ surface: "desktop" }).surface, "desktop");
  assert.equal(filterFields({ surface: "<script>alert(1)</script>" }).surface, undefined);
  assert.equal(filterFields({ intervention: "takeover" }).intervention, "takeover");
  assert.equal(filterFields({ intervention: "drop-table" }).intervention, undefined);
});

test("落盘内容中不含任何被丢弃的敏感输入", async () => {
  await withTelemetry(async (telemetry) => {
    await telemetry.record("usage.view", {
      view: "config",
      prompt: "SENTINEL_PROMPT_TEXT",
      filePath: "SENTINEL_PATH_VALUE",
      token: "SENTINEL_TOKEN_VALUE",
    });
    const raw = await readFile(telemetry.path, "utf8");
    assert.ok(raw.includes("config"), "白名单字段应当落盘");
    for (const sentinel of ["SENTINEL_PROMPT_TEXT", "SENTINEL_PATH_VALUE", "SENTINEL_TOKEN_VALUE"]) {
      assert.ok(!raw.includes(sentinel), `${sentinel} 不得出现在落盘文件中`);
    }
  });
});

// ── 分类学与健壮性 ─────────────────────────────────────────────────────────

test("未知事件类型被拒绝并计入 dropped", async () => {
  await withTelemetry(async (telemetry) => {
    assert.equal(await telemetry.record("usage.view", { view: "bot" }), true);
    assert.equal(await telemetry.record("evil.exfiltrate", { view: "bot" }), false);
    assert.equal(await telemetry.record("", {}), false);
    assert.equal(telemetry.dropped, 2);
  });
});

test("record 对脏输入永不抛错——度量层不得打断主流程", async () => {
  await withTelemetry(async (telemetry) => {
    const circular = {};
    circular.self = circular;
    await assert.doesNotReject(() => telemetry.record("usage.view", circular));
    await assert.doesNotReject(() => telemetry.record("usage.view", null));
    await assert.doesNotReject(() => telemetry.record("usage.view", "字符串不是对象"));
    await assert.doesNotReject(() => telemetry.record(undefined, undefined));
  });
});

// ── 五条授权前提 ───────────────────────────────────────────────────────────

test("前提2：setEnabled(false) 立即停止写入", async () => {
  await withTelemetry(async (telemetry) => {
    await telemetry.record("usage.view", { view: "team" });
    await telemetry.setEnabled(false);
    assert.equal(await telemetry.record("usage.view", { view: "market" }), false);
    const raw = await readFile(telemetry.path, "utf8");
    assert.ok(raw.includes("team"));
    assert.ok(!raw.includes("market"), "关闭后的事件不得落盘");
  });
});

// ── 烛 R1 四个致命项的回归防线（2026-09-04）───────────────────────────────

test("F-1：并发 record 不写坏哈希链（未预先 init 的惰性路径）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "514cc-telemetry-f1-"));
  const telemetry = new ProductTelemetry({ path: join(dir, "product-telemetry.jsonl"), rateLimit: 1000 });
  try {
    // 关键：不预先 init，直接并发——这正是 clear() 之后的唯一代码路径
    await Promise.all(Array.from({ length: 20 }, () => telemetry.record("usage.view", { view: "bot" })));
    const verdict = await telemetry.store.verifyChain();
    assert.equal(verdict.ok, true, `并发下链必须完好：${JSON.stringify(verdict)}`);
    const lines = (await readFile(telemetry.path, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const sequences = lines.map((l) => l.sequence);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b), "sequence 不得回卷");
    assert.equal(new Set(sequences).size, sequences.length, "sequence 不得重复");
  } finally {
    await telemetry.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("F-2：clear() 与在途 record 交错后文件不复活且链完好", async () => {
  const dir = await mkdtemp(join(tmpdir(), "514cc-telemetry-f2-"));
  const telemetry = new ProductTelemetry({ path: join(dir, "product-telemetry.jsonl"), rateLimit: 1000 });
  try {
    await telemetry.init();
    for (let i = 0; i < 5; i += 1) await telemetry.record("usage.view", { view: "bot" });
    // clear 与 30 条并发 record 交错
    const clearing = telemetry.clear();
    const records = Array.from({ length: 30 }, () => telemetry.record("usage.view", { view: "team" }));
    await Promise.all([clearing, ...records]);
    await assert.rejects(() => access(telemetry.path), "clear 期间的写入不得让文件复活");
    // 闸门解除后可以正常重建，且新链必须从 genesis 开始
    await telemetry.record("usage.view", { view: "config" });
    const lines = (await readFile(telemetry.path, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[0].prev, "genesis", "重建后的首行必须是 genesis，不得续接已删除的旧链");
    assert.equal((await telemetry.store.verifyChain()).ok, true);
  } finally {
    await telemetry.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("F-3：enabled 跨实例持久化——关闭后重启不得自动恢复采集", async () => {
  const dir = await mkdtemp(join(tmpdir(), "514cc-telemetry-f3-"));
  const path = join(dir, "product-telemetry.jsonl");
  try {
    const first = await new ProductTelemetry({ path }).init();
    const result = await first.setEnabled(false);
    assert.equal(result.enabled, false);
    assert.equal(result.persisted, true, "开关必须真的落盘");
    await first.close();
    // 模拟进程重启：新实例、构造默认 enabled=true
    const second = await new ProductTelemetry({ path, enabled: true }).init();
    assert.equal(second.enabled, false, "磁盘上的关闭状态必须压过构造默认值");
    assert.equal(await second.record("usage.view", { view: "bot" }), false);
    await second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("F-4：原型键不污染聚合，计数恒为数字", async () => {
  await withTelemetry(async (telemetry) => {
    for (const view of ["constructor", "toString", "__proto__", "workbench"]) {
      await telemetry.record("usage.view", { view });
    }
    const result = await telemetry.summary();
    for (const key of ["constructor", "toString", "__proto__"]) {
      assert.equal(typeof result.byView[key], "number", `${key} 必须是计数而非原型上的函数`);
    }
    assert.equal(result.byView.workbench, 1);
    assert.equal(Object.getPrototypeOf({}), Object.prototype, "全局原型不得被污染");
  }, { rateLimit: 100 });
});

test("S-1：敌意 type 不能穿透「永不抛错」契约", async () => {
  await withTelemetry(async (telemetry) => {
    const hostile = { toString() { throw new Error("boom"); } };
    await assert.doesNotReject(() => telemetry.record(hostile, { view: "bot" }));
    assert.equal(await telemetry.record(hostile, {}), false);
  });
});

test("前提2：clear() 物理删除文件而非标记删除", async () => {
  await withTelemetry(async (telemetry) => {
    await telemetry.record("usage.view", { view: "overview" });
    await access(telemetry.path); // 存在
    await telemetry.clear();
    await assert.rejects(() => access(telemetry.path), "clear 后文件必须真的不存在");
    assert.equal(telemetry.dropped, 0, "计数器应一并归零");
  });
});

test("前提3：埋点走事件哈希链且可验证", async () => {
  await withTelemetry(async (telemetry) => {
    await telemetry.record("usage.view", { view: "bot" });
    await telemetry.record("trust.delegated", { member: "codex" });
    const raw = await readFile(telemetry.path, "utf8");
    const lines = raw.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].prev, "genesis", "首条 prev 应为 genesis");
    assert.equal(lines[1].prev, lines[0].hash, "第二条 prev 必须指向前一条 hash");
    const verdict = await telemetry.store.verifyChain();
    assert.ok(verdict.ok !== false, `链校验不应失败：${JSON.stringify(verdict)}`);
  });
});

test("前提5：埋点写入独立文件，不进主 Run 事件流", async () => {
  await withTelemetry(async (telemetry, dir) => {
    await telemetry.record("usage.view", { view: "sessions" });
    assert.ok(telemetry.path.endsWith("product-telemetry.jsonl"));
    await assert.rejects(() => access(join(dir, "events.jsonl")), "不得触碰主事件流文件");
  });
});

// ── 限流 ───────────────────────────────────────────────────────────────────

test("超过速率上限后静默丢弃而非抛错", async () => {
  await withTelemetry(async (telemetry) => {
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await telemetry.record("usage.view", { view: "bot" }));
    assert.deepEqual(results, [true, true, false, false, false], "前 2 条写入，其余丢弃");
    assert.equal(telemetry.dropped, 3);
  }, { rateLimit: 2 });
});

// ── summary 语义 ───────────────────────────────────────────────────────────

test("summary 聚合视图与能力使用分布", async () => {
  await withTelemetry(async (telemetry) => {
    await telemetry.record("usage.view", { view: "workbench" });
    await telemetry.record("usage.view", { view: "workbench" });
    await telemetry.record("usage.view", { view: "team" });
    await telemetry.record("usage.capability", { capability: "run.create", outcome: "success" });
    const result = await telemetry.summary();
    assert.equal(result.total, 4);
    assert.equal(result.byView.workbench, 2);
    assert.equal(result.byView.team, 1);
    assert.equal(result.byCapability["run.create"], 1);
    assert.equal(result.outcomes.success, 1);
    assert.deepEqual(result.observedViews, ["team", "workbench"]);
    assert.equal(result.truncated, false);
  });
});

test("unusedRegistered 对注册全集做差集，未知观察值不进分母", () => {
  const result = unusedRegistered(["bot", "ghost-view"], ["bot", "workbench", "team"]);
  assert.deepEqual(result.used, ["bot"]);
  assert.deepEqual(result.unused, ["workbench", "team"]);
  assert.deepEqual(result.known, ["bot", "workbench", "team"]);
});

test("summary 聚合注册视图的从未打开（C5）", async () => {
  const known = ["bot", "workbench", "team", "channels"];
  await withTelemetry(async (telemetry) => {
    await telemetry.record("usage.view", { view: "bot" });
    await telemetry.record("usage.view", { view: "bot" });
    await telemetry.record("usage.capability", { capability: PRODUCT_ACTION_IDS.paletteInvoke });
    const result = await telemetry.summary();
    assert.deepEqual(result.usedViews, ["bot"]);
    assert.deepEqual(result.unusedViews, ["workbench", "team", "channels"]);
    assert.ok(!result.unusedViews.includes("bot"));
    assert.deepEqual(result.usedCapabilities, [PRODUCT_ACTION_IDS.paletteInvoke]);
    assert.ok(result.unusedCapabilities.includes(PRODUCT_ACTION_IDS.kickoffSend));
    assert.ok(!result.unusedCapabilities.includes(PRODUCT_ACTION_IDS.paletteInvoke));
    assert.equal(result.knownViews.length, known.length);
  }, { knownViews: known, knownCapabilities: [...REGISTERED_CAPABILITIES] });
});

test("零事件时全部注册视图判为从未打开", async () => {
  await withTelemetry(async (telemetry) => {
    const result = await telemetry.summary();
    assert.deepEqual(result.usedViews, []);
    assert.deepEqual(result.unusedViews, [...REGISTERED_VIEWS]);
    assert.equal(result.unusedViews.length, REGISTERED_VIEWS.length);
    assert.ok(result.unusedViews.length >= 14);
  });
});

test("无托付数据时 trustedDelegationRate 为 null 而非 1", async () => {
  await withTelemetry(async (telemetry) => {
    await telemetry.record("usage.view", { view: "bot" });
    const result = await telemetry.summary();
    assert.equal(result.trustedDelegationRate, null, "没有数据不得被误读成完美表现");
  });
});

test("可信托付率按未被干预的托付占比计算", async () => {
  await withTelemetry(async (telemetry) => {
    for (let i = 0; i < 4; i += 1) await telemetry.record("trust.delegated", { member: "claude" });
    await telemetry.record("trust.intervention", { intervention: "steer" });
    const result = await telemetry.summary();
    assert.equal(result.delegations, 4);
    assert.equal(result.interventions, 1);
    assert.equal(result.trustedDelegationRate, 0.75);
  });
});

test("summary 触顶时显式标注 truncated，不静默给出偏斜统计", async () => {
  await withTelemetry(async (telemetry) => {
    for (let i = 0; i < 5; i += 1) await telemetry.record("usage.view", { view: "bot" });
    const result = await telemetry.summary({ maxScan: 3 });
    assert.equal(result.truncated, true);
    assert.equal(result.total, 3);
  }, { rateLimit: 100 });
});

test("事件类型分类学覆盖 v48 四层指标", () => {
  const prefixes = new Set(Object.keys(TELEMETRY_TYPES).map((type) => type.split(".")[0]));
  assert.deepEqual([...prefixes].sort(), ["activation", "friction", "trust", "usage"]);
});

// ── 端到端：验证 app.mjs 接线与 HTTP 端点真实可用 ──────────────────────────
// 单元测试只证明模块自身正确；这一段证明它真的被挂进了 state 并能经 HTTP 驱动。

import { spawnTestServer, stopTestServer, waitForUrl } from "./server-fixture.mjs";

test("端到端：埋点四端点经 HTTP 可用且写入独立文件", async () => {
  const token = "e2e-product-telemetry-token";
  const dataRoot = await mkdtemp(join(tmpdir(), "514cc-telemetry-e2e-"));
  const child = spawnTestServer({
    env: { CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_DATA_DIR: dataRoot, CONTROL_CENTER_PORT: "0" },
  });
  try {
    const origin = new URL(await waitForUrl(child)).origin;
    const authorization = `Bearer ${token}`;
    const headers = { authorization, "content-type": "application/json" };

    // 1) record：白名单字段进，敏感字段被挡在结构之外
    const recordRes = await fetch(`${origin}/api/telemetry/record`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "usage.view",
        fields: { view: "workbench", prompt: "E2E_SENTINEL_PROMPT" },
      }),
    });
    assert.equal(recordRes.status, 200);
    assert.deepEqual(await recordRes.json(), { recorded: true });

    // 2) 未知类型被拒但不报 5xx——度量失败不得打断主流程
    const rejected = await fetch(`${origin}/api/telemetry/record`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "evil.exfiltrate", fields: {} }),
    });
    assert.equal(rejected.status, 200);
    assert.deepEqual(await rejected.json(), { recorded: false });

    // 3) summary：聚合可读
    const summary = await (await fetch(`${origin}/api/telemetry/summary`, { headers })).json();
    assert.equal(summary.schema, "514cc.product-telemetry.summary/v1");
    assert.equal(summary.byView.workbench, 1);
    assert.equal(summary.trustedDelegationRate, null);
    assert.ok(summary.usedViews.includes("workbench"));
    assert.ok(summary.unusedViews.includes("bot"), "未访问的注册视图必须出现在 unusedViews");
    assert.ok(!summary.unusedViews.includes("workbench"));
    assert.ok(summary.unusedCapabilities.includes(PRODUCT_ACTION_IDS.kickoffSend));

    // 4) 落盘文件独立于 events.jsonl，且不含敏感输入
    const telemetryPath = join(dataRoot, "product-telemetry.jsonl");
    const raw = await readFile(telemetryPath, "utf8");
    assert.ok(raw.includes("workbench"));
    assert.ok(!raw.includes("E2E_SENTINEL_PROMPT"), "敏感字段不得落盘");
    const mainEvents = await readFile(join(dataRoot, "events.jsonl"), "utf8").catch(() => "");
    assert.ok(!mainEvents.includes("usage.view"), "埋点不得混入 Run 事件流");

    // 5) settings 关闭后停止写入
    const off = await fetch(`${origin}/api/telemetry/settings`, {
      method: "POST", headers, body: JSON.stringify({ enabled: false }),
    });
    assert.deepEqual(await off.json(), { enabled: false, persisted: true });
    const afterOff = await fetch(`${origin}/api/telemetry/record`, {
      method: "POST", headers, body: JSON.stringify({ type: "usage.view", fields: { view: "team" } }),
    });
    assert.deepEqual(await afterOff.json(), { recorded: false });

    // 6) DELETE 物理清空
    const cleared = await fetch(`${origin}/api/telemetry`, { method: "DELETE", headers });
    assert.equal((await cleared.json()).cleared, true);
    await assert.rejects(() => access(telemetryPath), "clear 后文件必须真的不存在");
  } finally {
    await stopTestServer(child, { token });
    await rm(dataRoot, { recursive: true, force: true });
  }
});
