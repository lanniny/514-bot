/**
 * PPT 真实帧回归测试（v50 · 2026-09-04）。
 *
 * ── 与 permission-prompt-wire.test.mjs 的分工 ──
 * 那个文件的基线抄自 `claude.exe` 的 zod **声明**（协议规格）。
 * 这个文件的基线是**本机真实跑出来的帧**（协议实况）—— 两者独立，互为证人。
 * 规格能被读错，实况不会；实况可能只覆盖部分路径，规格补上全貌。
 *
 * ── 证据来源（可复跑）──
 * `node scripts/probe-permission-frames.mjs --prompt "..." --mode plan --decision allow|deny`
 * 原始帧留在 `.evidence/permission-frames/<时间戳>/`，fixture 只存结构指纹
 * （plan 的 input 是几 KB 的 markdown，全存会让 fixture 失去可读性）。
 *
 * ── 这次实测确认了什么（此前无人跑通）──
 * 1. 批准 → 文件真的被创建，批准生效
 * 2. 拒绝 → 文件未创建，且 deny 的 `message` 原样送达模型（tool_result isError=true）
 * 3. `--permission-mode manual` 会被**静默降级成 default**，PPT 不触发；`plan` 才可靠
 * 4. 参数在 MCP 标准的 `arguments` 里，另有 `_meta["claudecode/toolUseId"]` 副本
 *    —— 这个 `_meta` 通道二进制取证时没看到，是实测的净增量
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { parsePermissionRequest } from "../src/permission-prompt-wire.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/permission-prompt-frames.json", import.meta.url), "utf8"));

test("fixture 是真实取证而非构造样本（防止有人拿想象中的帧当基线）", () => {
  assert.match(fixture.source, /真实取证/);
  assert.ok(Array.isArray(fixture.evidenceRuns) && fixture.evidenceRuns.length >= 2, "至少要有 allow / deny 两条路径的证据");
  assert.ok(fixture.samples.length >= 3, `样本太少：${fixture.samples.length}`);
});

test("真实帧的参数键就是三字段 snake_case（实况印证规格）", () => {
  for (const sample of fixture.samples) {
    assert.deepEqual(sample.argumentKeys, ["input", "tool_name", "tool_use_id"], `${sample.toolName} 的参数键与规格不符`);
  }
});

test("每个真实样本都能被 parsePermissionRequest 正确解析", () => {
  for (const sample of fixture.samples) {
    // 用样本的结构指纹重建一个等价请求（input 只需保持键集合）
    const input = Object.fromEntries(sample.inputKeys.map((key) => [key, "…"]));
    const parsed = parsePermissionRequest({ tool_name: sample.toolName, input, tool_use_id: sample.toolUseId });
    assert.equal(parsed.toolName, sample.toolName);
    assert.equal(parsed.toolUseId, sample.toolUseId);
    assert.deepEqual(Object.keys(parsed.input).sort(), sample.inputKeys);
  }
});

test("_meta 通道携带 toolUseId 副本，且与 arguments 里的一致", () => {
  // 实测净增量：二进制 zod 声明里没有 _meta，它是 MCP 标准通道。
  // 一致性重要——若两者不一致，说明请求可能被中途改写过。
  for (const sample of fixture.samples) {
    assert.ok(sample.metaKeys.includes("claudecode/toolUseId"), `${sample.toolName} 缺 _meta toolUseId`);
    assert.equal(sample.metaToolUseIdMatches, true, `${sample.toolName} 的 _meta toolUseId 与 arguments 不一致`);
  }
});

test("tool_use_id 形如 toolu_ 前缀（用于 UI 关联工具调用与审批卡）", () => {
  for (const sample of fixture.samples) {
    assert.match(sample.toolUseId, /^toolu_[A-Za-z0-9]+$/, `异常的 tool_use_id: ${sample.toolUseId}`);
  }
});

test("实测覆盖了 allow 与 deny 两条路径，且各自有观察到的后果", () => {
  const decisions = new Set(fixture.samples.map((sample) => sample.probeDecision));
  assert.ok(decisions.has("allow") && decisions.has("deny"), `只覆盖了 ${[...decisions].join("/")}`);
  for (const sample of fixture.samples) {
    // 光有帧不够——必须记录"批准/拒绝之后真实发生了什么"，否则只证明了通道通、没证明决策生效
    assert.ok(typeof sample.observedOutcome === "string" && sample.observedOutcome.length >= 10, `${sample.toolName} 缺少实际后果记录`);
  }
});

test("plan 档是可靠触发档（manual 会被静默降级，实测记录）", () => {
  for (const sample of fixture.samples) {
    assert.equal(sample.permissionMode, "plan", "样本应全部来自 plan 档——manual 档实测不触发 PPT");
  }
});

test("样本带 CLI 版本号（协议无兼容性承诺，证据必须可追溯到版本）", () => {
  for (const sample of fixture.samples) {
    assert.match(sample.cliVersion, /^\d+\.\d+\.\d+$/, `缺少可用的 cliVersion: ${sample.cliVersion}`);
  }
});

test("ExitPlanMode 也会走许可通道（plan 档下的实测发现）", () => {
  // 非显然：不只有写盘工具需要许可，退出 plan 模式本身也要批准。
  // UI 设计要考虑这一点——操作者会先看到"是否同意这个执行计划"，再看到具体工具。
  const tools = new Set(fixture.samples.map((sample) => sample.toolName));
  assert.ok(tools.has("ExitPlanMode"), "样本里应含 ExitPlanMode——它是 plan 档下第一个弹的许可");
  assert.ok(tools.has("Write"), "样本里应含真正的写盘工具");
});
