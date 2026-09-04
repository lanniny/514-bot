/**
 * 后端事件类型扫描器契约测试（v49 · 2026-09-04）。
 *
 * 这是**扳机的扳机**：`event-severity.test.mjs` 的覆盖率断言完全依赖本扫描器，
 * 而首版扫描器（只匹配 `emitEvent(` 一种写法）漏了 46/87 种类型，让覆盖率测试
 * 变成假绿灯。所以扫描器本身必须被测——否则"扳机退化"这类故障没有任何机械发现路径。
 *
 * 三类断言：
 *   1. 三种发射写法各自能被识别（合成样本，不依赖真实源码内容）
 *   2. EventEmitter 噪音被结构性排除（裸词名），信封名（domain.action）被保留
 *   3. 真实源码扫描的规模下界 + 已知类型的存在性抽检
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMIT_PATTERNS,
  isEnvelopeEventName,
  scanBackendEventTypes,
} from "./helpers/backend-event-types.mjs";

function withTempSrc(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "evt-scan-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const full = join(dir, name);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content, "utf8");
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("三种发射写法全部被识别", () => {
  const types = withTempSrc({
    "a.mjs": 'await this.emitEvent(run, "run.alpha", { x: 1 });',
    "b.mjs": 'await this.#emit("automation.beta", { id });',
    "c.mjs": 'this.eventStore.emit("assistant.gamma", { text });',
  }, (dir) => scanBackendEventTypes({ srcDir: dir }).types);
  assert.deepEqual(types, ["assistant.gamma", "automation.beta", "run.alpha"]);
});

test("EventEmitter 裸词名被结构性排除，信封名保留", () => {
  const types = withTempSrc({
    "ssh.mjs": [
      'child.emit("close", code);',
      'child.emit("error", err);',
      'child.emit("exit", code);',
      'store.emit("remote.source_write", {});',
    ].join("\n"),
  }, (dir) => scanBackendEventTypes({ srcDir: dir }).types);
  assert.deepEqual(types, ["remote.source_write"], "裸词生命周期名不应进入事件全集");
});

test("isEnvelopeEventName 的形态规则", () => {
  for (const good of ["run.failed", "agent.turn_completed", "ccswitch.proxy_started", "a.b"]) {
    assert.equal(isEnvelopeEventName(good), true, good);
  }
  for (const bad of ["close", "error", "exit", "", "Run.Failed", ".leading", "trailing.", "no-dot", null, undefined, 42, {}]) {
    assert.equal(isEnvelopeEventName(bad), false, String(bad));
  }
});

test("嵌套目录被递归扫描，node_modules 与点目录被跳过", () => {
  const types = withTempSrc({
    "top.mjs": 'emitEvent(r, "run.top");',
    "adapters/nested.mjs": 'emitEvent(r, "adapter.nested");',
    "node_modules/pkg/index.mjs": 'emitEvent(r, "vendor.should_not_appear");',
    ".hidden/x.mjs": 'emitEvent(r, "hidden.should_not_appear");',
  }, (dir) => scanBackendEventTypes({ srcDir: dir }).types);
  assert.deepEqual(types, ["adapter.nested", "run.top"]);
});

test("extraFiles 被纳入扫描", () => {
  const types = withTempSrc({
    "src-only.mjs": 'emitEvent(r, "run.from_src");',
    "server.mjs": 'emitEvent(r, "run.from_server");',
  }, (dir) => scanBackendEventTypes({
    srcDir: dir,
    extraFiles: [join(dir, "server.mjs")],
  }).types);
  assert.ok(types.includes("run.from_server"), "extraFiles 未被扫描");
});

test("sites 记录每个类型的出处文件（供审计定位）", () => {
  const { sites } = withTempSrc({
    "one.mjs": 'emitEvent(r, "run.shared");',
    "two.mjs": 'emitEvent(r, "run.shared");',
  }, (dir) => scanBackendEventTypes({ srcDir: dir }));
  assert.equal(sites.get("run.shared").size, 2, "同名事件的多个发射点都该被记录");
});

test("g 标志的 lastIndex 不在多文件间泄漏", () => {
  // 同一 pattern 连续用于多个文件：若共享 RegExp 实例，第二个文件会从上次
  // lastIndex 继续，导致漏匹配。这条用例锁住"每次新建实例"的实现选择。
  const types = withTempSrc({
    "f1.mjs": 'emitEvent(r, "run.first");',
    "f2.mjs": 'emitEvent(r, "run.second");',
    "f3.mjs": 'emitEvent(r, "run.third");',
  }, (dir) => scanBackendEventTypes({ srcDir: dir }).types);
  assert.deepEqual(types, ["run.first", "run.second", "run.third"]);
});

test("空目录返回空集而不抛", () => {
  const result = withTempSrc({}, (dir) => scanBackendEventTypes({ srcDir: dir }));
  assert.deepEqual(result.types, []);
  assert.equal(result.sites.size, 0);
});

test("EMIT_PATTERNS 是冻结的且每条都带 name 与 g 标志", () => {
  assert.equal(Object.isFrozen(EMIT_PATTERNS), true);
  assert.ok(EMIT_PATTERNS.length >= 3);
  for (const pattern of EMIT_PATTERNS) {
    assert.equal(typeof pattern.name, "string");
    assert.ok(pattern.name.length > 0);
    assert.ok(pattern.regex instanceof RegExp);
    assert.ok(pattern.regex.flags.includes("g"), `${pattern.name} 缺 g 标志`);
  }
});

test("真实源码扫描：规模下界 + 各前缀域抽检", () => {
  const { types } = scanBackendEventTypes({ srcDir: "src", extraFiles: ["server.mjs"] });
  assert.ok(types.length >= 80, `真实扫描只找到 ${types.length} 种，预期 ≥80`);
  // 抽检每个前缀域至少有一个代表——首版漏的正好是整域缺失（automation.* 全漏）
  for (const sample of [
    "run.failed",                    // emitEvent 写法
    "automation.created",            // #emit 写法（首版全域漏）
    "assistant.message",             // eventStore.emit 写法（首版全域漏）
    "approval.requested",
    "capability.lease_revoked",
    "provider.failover",
    "ccswitch.proxy_started",
    "config.rolled_back",
  ]) {
    assert.ok(types.includes(sample), `真实扫描缺少已知类型 ${sample}`);
  }
});
