/**
 * 后端事件类型扫描器（v49 · 2026-09-04）——覆盖率扳机的**单一数据源**。
 *
 * ── 为什么必须单独成模块 ──
 * 首版把扫描正则写在测试里，只匹配 `emitEvent(ctx, "type")` 一种写法，
 * 结果**漏掉 46 种事件类型**（41 vs 真实 87）：
 *   · `emitEvent(run, "run.failed")`     —— Orchestrator 的包装层（扫到了）
 *   · `this.#emit("automation.created")` —— AutomationStore 的私有包装（全漏）
 *   · `eventStore.emit("assistant.message")` —— adapter 直接调 store（全漏）
 * 于是"后端全部事件类型都已声明"那条测试**绿是因为看不见**，不是因为覆盖完整。
 * 这是"自写扳机带自己的盲区"的实例，也是把口径抽成模块的直接原因：
 * 扫描规则只有一份，任何新的发射写法只需在这里补一条。
 *
 * ── 噪音剔除（有实证，非猜测）──
 * `.emit("close"|"error"|"exit")` 是 `src/ssh/remote-run.mjs` 里 ChildProcess
 * 的 Node EventEmitter 调用，与事件信封无关（remote-run.mjs:136-146）。
 * 按**事件名必须含点号**这条结构规则排除——信封事件全部是 `domain.action` 形态，
 * 而 EventEmitter 的生命周期名是裸词。这条规则比维护黑名单更抗腐烂。
 *
 * 纯 Node ESM（用 node:fs），供测试与审计脚本共用。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 已知的三种事件发射写法。新增包装层时在此补一条正则，
 * 并在 `tests/backend-event-types.test.mjs` 里加一条对应的识别用例。
 */
export const EMIT_PATTERNS = Object.freeze([
  { name: "emitEvent(ctx, type)", regex: /emitEvent\([^,]*,\s*["']([a-z][a-z._-]*)["']/g },
  { name: "#emit(type)", regex: /#emit\(\s*["']([a-z][a-z._-]*)["']/g },
  { name: ".emit(type)", regex: /\.emit\(\s*["']([a-z][a-z._-]*)["']/g },
]);

/**
 * 信封事件名必须是 `domain.action` 形态。裸词（close/error/exit）是
 * Node EventEmitter 的生命周期名，结构性排除而非黑名单。
 */
export function isEnvelopeEventName(name) {
  return typeof name === "string" && /^[a-z][a-z_-]*\.[a-z][a-z._-]*$/.test(name);
}

function collectFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, out);
    else if (entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

/**
 * 扫描后端源码，返回 { types: string[], sites: Map<type, Set<file>> }。
 * types 已去噪、去重、排序。
 */
export function scanBackendEventTypes({ srcDir, extraFiles = [] } = {}) {
  const files = [...collectFiles(srcDir), ...extraFiles];
  const sites = new Map();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const { regex } of EMIT_PATTERNS) {
      // 每次用新 RegExp 实例，避免共享 lastIndex（g 标志的经典陷阱）
      const scoped = new RegExp(regex.source, regex.flags);
      for (const match of text.matchAll(scoped)) {
        const name = match[1];
        if (!isEnvelopeEventName(name)) continue;
        if (!sites.has(name)) sites.set(name, new Set());
        sites.get(name).add(file);
      }
    }
  }
  return { types: [...sites.keys()].sort(), sites };
}
