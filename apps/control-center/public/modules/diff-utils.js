/**
 * diff-utils.js — 文本 diff 纯工具函数（Wave B 切片 10）
 *
 * 从 app.js 抽出 4 个纯函数：extractDiff / createLocalDiff / countDiffChanges / diffMarkup。
 * renderDiff（3 行、唯一调用点 planConfig）留在 app.js——它需要 elements DOM 引用。
 *
 * 纯 ESM，无工厂：与 event-protocol.js / event-shape.js 同模式。
 */

import { escapeHtml } from "../utils.js";

export function extractDiff(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result.diff === "string") return result.diff;
  if (result.diff && typeof result.diff === "object") {
    const lines = Array.isArray(result.diff.lines) ? result.diff.lines : [];
    if (lines.length) {
      return lines
        .map((line) => {
          if (typeof line === "string") return line;
          const kind = String(line.type ?? line.kind ?? line.operation ?? "context").toLowerCase();
          const prefix = kind === "add" || kind === "added" || kind === "insert" ? "+ " : kind === "remove" || kind === "removed" || kind === "delete" ? "- " : "  ";
          return `${prefix}${line.content ?? line.text ?? line.value ?? ""}`;
        })
        .join("\n");
    }
    if (result.diff.summary) return String(result.diff.summary);
  }
  if (typeof result.patch === "string") return result.patch;
  if (Array.isArray(result.changes)) {
    return result.changes
      .map((change) => {
        if (typeof change === "string") return change;
        const path = change.path ?? change.pointer ?? change.field ?? "value";
        return `- ${path}: ${JSON.stringify(change.before ?? change.old ?? null)}\n+ ${path}: ${JSON.stringify(change.after ?? change.new ?? null)}`;
      })
      .join("\n");
  }
  return "";
}

export function createLocalDiff(before, after) {
  if (before === after) return "无变更";
  const left = String(before).split(/\r?\n/);
  const right = String(after).split(/\r?\n/);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = left.slice(prefix, left.length - suffix);
  const added = right.slice(prefix, right.length - suffix);
  const contextBefore = left.slice(Math.max(0, prefix - 2), prefix);
  const contextAfter = suffix ? left.slice(left.length - suffix, Math.min(left.length, left.length - suffix + 2)) : [];
  return [
    `@@ line ${prefix + 1} @@`,
    ...contextBefore.map((line) => `  ${line}`),
    ...removed.map((line) => `- ${line}`),
    ...added.map((line) => `+ ${line}`),
    ...contextAfter.map((line) => `  ${line}`),
  ].join("\n");
}

export function countDiffChanges(diff) {
  return String(diff)
    .split(/\r?\n/)
    .filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))).length;
}

export function diffMarkup(diff) {
  return String(diff)
    .split(/\r?\n/)
    .map((line) => {
      const className = line.startsWith("+") && !line.startsWith("+++") ? "diff-line-add" : line.startsWith("-") && !line.startsWith("---") ? "diff-line-remove" : "";
      return `<span class="${className}">${escapeHtml(line)}</span>`;
    })
    .join("\n");
}
