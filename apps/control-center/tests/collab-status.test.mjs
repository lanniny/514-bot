/**
 * collab-status.test.mjs — 协作状态唯一词典的一致性门禁。
 *
 * 这里守住三件事（对应方案 v2 的目标 G1/G2 与风险 R1）：
 *  1. 文案唯一：任何面板都不得再自行硬编码状态用语，三处输出必须等于词典输出。
 *  2. 键与语义冻结：tone / chipTone 词汇表固定，改键必须连带改既有测试（有意行为）。
 *  3. 图标真实：词典里的图标名必须在离线 sprite 里存在——动态拼接的 `#lucide-${name}`
 *     不会被 lucide-sprite-contract 的静态扫描覆盖，这里补上运行时校验，
 *     否则拼错一个名字只会渲染成空白按钮，且没有任何测试会变红。
 *
 * 原第 4 条（collab.css 覆盖每个 tone）随 `collab-status-chip.js` 一并移除：
 * 那个 chip 渲染器**生产代码零消费者**，collab.css 的令牌与类也无人引用——
 * 整块是死代码（2026-09-11 复核后按 LO 授权删除）。删掉一个"没人用的渲染器 + 只为它存在的样式"
 * 比留着一份带完整测试的死代码更诚实：测试全绿会让人以为它在生效。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  COLLAB_STATUS,
  COLLAB_SEMANTICS,
  COLLAB_STATUS_FALLBACK,
  collabStatusOf,
  collabStatusLabel,
  collabStatusCompact,
  collabSemanticOf,
  collabNeedsUser,
  collabStatusKeys,
} from "../public/modules/collab/collab-status.js";
import { collaborationProcessModel } from "../public/modules/collaboration-process.js";
import { botRunStatusChip, botRunSemantic } from "../public/modules/bot-workspace-chrome.js";
import { runStatusText } from "../public/utils.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

// 冻结的词汇表：与 collaboration-process 的 counts.* 分桶、chrome 的分组一一对应。
const FROZEN_TONES = new Set(["queued", "running", "complete", "attention", "inactive", "unknown"]);
const FROZEN_CHIP_TONES = new Set(["waiting", "running", "attention", "error", "warning", "complete", "muted"]);

const runLayerKeys = () => collabStatusKeys().filter((key) => COLLAB_STATUS[key].layer === "run");

test("词典每一项都有非空文案、图标与合法 tone", () => {
  const keys = collabStatusKeys();
  assert.ok(keys.length > 20, `词典状态数量异常：${keys.length}`);
  for (const key of keys) {
    const view = COLLAB_STATUS[key];
    assert.ok(view.label && view.label.trim(), `${key} 缺少 label`);
    assert.ok(view.compact && view.compact.trim(), `${key} 缺少 compact`);
    assert.ok(view.icon && view.icon.trim(), `${key} 缺少 icon`);
    assert.ok(FROZEN_TONES.has(view.tone), `${key} 的 tone 越界：${view.tone}`);
    assert.ok(FROZEN_CHIP_TONES.has(view.chipTone), `${key} 的 chipTone 越界：${view.chipTone}`);
    assert.ok(view.semantic === null || ["waiting-user", "waiting-peer"].includes(view.semantic), `${key} 的 semantic 越界：${view.semantic}`);
  }
});

test("词典图标名必须真实存在于离线 sprite", async () => {
  const sprite = await readFile(`${appRoot}/public/lucide-sprite.svg`, "utf8");
  const available = new Set([...sprite.matchAll(/id="lucide-([a-z0-9-]+)"/g)].map((match) => match[1]));
  assert.ok(available.size > 50, `sprite 图标数量异常：${available.size}`);
  const missing = [];
  const names = [...Object.values(COLLAB_STATUS).map((view) => view.icon), ...Object.values(COLLAB_SEMANTICS).map((view) => view.icon)];
  for (const name of new Set(names)) if (!available.has(name)) missing.push(name);
  assert.deepEqual(missing, [], `词典引用了 sprite 中不存在的图标（会渲染成空白）：${missing.join(", ")}`);
});

test("未知状态回退到「状态未知 / unknown」，不再抛错或吐原始状态串", () => {
  for (const input of [undefined, null, "", "future-state", "NOT_A_STATE"]) {
    const view = collabStatusOf(input);
    assert.equal(view.label, "状态未知", `输入 ${String(input)} 的 label 应为状态未知`);
    assert.equal(view.tone, "unknown");
    assert.equal(view.semantic, null);
  }
  assert.equal(COLLAB_STATUS_FALLBACK.label, "状态未知");
  // 归一化：大小写与连字符都要能命中
  assert.equal(collabStatusLabel("Recovery-Required"), "需人工恢复");
  assert.equal(collabStatusLabel("recovery_required"), "需人工恢复");
});

test("等你与等同伴必须可区分（协作场景最核心的一条语义）", () => {
  // 等你动手
  for (const status of ["waiting_approval", "waiting_for_approval", "approval_required", "recovery_required", "blocked", "waiting_user"]) {
    assert.equal(collabStatusOf(status).semantic, "waiting-user", `${status} 应归「等你」`);
    assert.equal(collabNeedsUser(status), true);
  }
  // 等同伴接手
  assert.equal(collabStatusOf("waiting_agent").semantic, "waiting-peer");
  assert.equal(collabStatusOf("handoff_open").semantic, "waiting-peer");
  assert.equal(collabNeedsUser("waiting_agent"), false);
  // 两种语义必须指向不同文案与图标，否则等于没分
  assert.notEqual(COLLAB_SEMANTICS["waiting-user"].label, COLLAB_SEMANTICS["waiting-peer"].label);
  assert.notEqual(COLLAB_SEMANTICS["waiting-user"].icon, COLLAB_SEMANTICS["waiting-peer"].icon);
  // pendingAsk 是运行时标志位：把「等 Agent」升级为「等你回答」
  assert.equal(collabStatusLabel("waiting_agent", { pendingAsk: true }), "等你回答");
  assert.equal(collabStatusOf("waiting_agent", { pendingAsk: true }).semantic, "waiting-user");
  assert.equal(collabSemanticOf("waiting_agent", { pendingAsk: true }).label, "等你");
  assert.equal(collabStatusLabel("waiting_agent"), "等待 Agent");
});

test("三处消费方输出必须等于词典输出（消除三套矛盾文案）", () => {
  for (const status of runLayerKeys()) {
    const view = COLLAB_STATUS[status];
    // ① utils.runStatusText → 规范用语
    assert.equal(runStatusText(status), view.label, `runStatusText(${status}) 与词典规范用语不一致`);
    // ② chrome 运行 chip → 紧凑用语
    assert.equal(botRunStatusChip(status).label, view.compact, `botRunStatusChip(${status}) 与词典紧凑用语不一致`);
    assert.equal(botRunStatusChip(status).tone, view.chipTone, `botRunStatusChip(${status}) 的 tone 与词典不一致`);
    // ③ 过程面板 → 规范用语（run 未终止时不做降级改写）
    const model = collaborationProcessModel({ run: { id: "r", status: "running", taskGraph: { tasks: [{ id: "t", status }] } } });
    assert.equal(model.tasks[0].state.label, view.label, `过程面板对 ${status} 的文案与词典不一致`);
    assert.equal(model.tasks[0].state.tone, view.tone, `过程面板对 ${status} 的 tone 与词典不一致`);
    assert.equal(model.tasks[0].state.icon, view.icon, `过程面板对 ${status} 的图标与词典不一致`);
  }
  // pendingAsk 特判在 utils 侧保留
  assert.equal(runStatusText("waiting_agent", { pendingAsk: true }), "等你回答");
});

test("已终止的 Run 不得把残留 running 显示成进行中（既有不变量保持）", () => {
  for (const status of ["succeeded", "failed", "cancelled", "recovery_required", "interrupted"]) {
    const run = { id: "r", status, conversationKind: "direct", taskGraph: { tasks: [{ id: "stale", status: "running" }] } };
    const model = collaborationProcessModel({ run });
    assert.equal(model.tasks[0].state.tone, "attention", `${status} 下残留 running 必须降级为 attention`);
    assert.equal(model.tasks[0].state.label, "执行状态待核对");
  }
});

test("chrome 暴露「在等谁」但不得改变既有 chip 分组归属", () => {
  assert.equal(botRunSemantic("waiting_approval").key, "waiting-user");
  assert.equal(botRunSemantic("waiting_agent").key, "waiting-peer");
  assert.equal(botRunSemantic("running"), null);
  // chipTone 与历史分组一致：waiting_user 仍在 waiting 组，recovery_required 仍在 error 组
  assert.equal(botRunStatusChip("waiting_user").tone, "waiting");
  assert.equal(botRunStatusChip("recovery_required").tone, "error");
  assert.equal(botRunStatusChip("interrupted").tone, "warning");
});
