/**
 * W3.8 安全巡检（secret sweep）：对控制面数据面做密钥字面量扫描——
 * 扫描对象 = dataRoot 下的运行时 JSON/JSONL（automations/macros/sessions/
 * monthly-budget/project-prefs）+ .ai-shared 顶层 markdown，全部有界。
 * 检测器复用 redaction.mjs 的 findSecretCandidates（与自动化/续聊同一道门）。
 *
 * 触发：控制面启动时后台跑一次 + POST /api/security/sweep 手动触发。
 * 结果落 dataRoot/secret-sweep-latest.json（含 event 通知）；报告只给
 * 文件名 + 命中规则名 + 位置序号，绝不回传密钥内容本身。
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findSecretCandidates } from "./redaction.mjs";

const SCAN_TARGETS = [
  "automations.json",
  "macros.json",
  "sessions.jsonl",
  "monthly-budget.json",
  "project-prefs.json",
];
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

export function createSecretSweepService({ dataRoot, aiSharedRoot, eventStore = null, nowFn = Date.now } = {}) {
  if (!dataRoot) throw new TypeError("secret sweep service needs dataRoot");

  async function sweep() {
    const startedAt = new Date(nowFn()).toISOString();
    const files = [];
    const candidates = [
      ...SCAN_TARGETS.map((name) => ({ label: name, path: join(dataRoot, name) })),
      { label: ".ai-shared/context.md", path: join(aiSharedRoot ?? dataRoot, "context.md") },
    ];
    for (const target of candidates) {
      let content;
      try {
        const info = await readFile(target.path, "utf8");
        content = info;
      } catch {
        files.push({ file: target.label, scanned: false, reason: "missing" });
        continue;
      }
      if (Buffer.byteLength(content, "utf8") > MAX_SCAN_BYTES) {
        files.push({ file: target.label, scanned: false, reason: "too-large" });
        continue;
      }
      const hits = findSecretCandidates(content).map((message) => ({ rule: String(message ?? "secret-like") }));
      files.push({ file: target.label, scanned: true, hits });
    }
    const findings = files.filter((file) => file.scanned && file.hits?.length);
    const report = {
      schema: "514cc.secret-sweep/v1",
      scannedAt: startedAt,
      scannedFiles: files.filter((file) => file.scanned).length,
      skippedFiles: files.filter((file) => !file.scanned).length,
      findingCount: findings.reduce((total, file) => total + file.hits.length, 0),
      findings,
    };
    // 最新报告落盘（原子替换）；失败不阻断返回
    try {
      const tempPath = join(dataRoot, `secret-sweep-latest.json.${Date.now()}.tmp`);
      await writeFile(tempPath, JSON.stringify(report, null, 2), "utf8");
      await rename(tempPath, join(dataRoot, "secret-sweep-latest.json"));
    } catch {
      // 忽略持久化失败
    }
    try {
      await eventStore?.emit("security.secret_sweep", {
        findingCount: report.findingCount,
        scannedFiles: report.scannedFiles,
      }, { agentId: "control-plane", sensitivity: "internal" });
    } catch {
      // 事件面缺失不影响扫描结果
    }
    return report;
  }

  async function latest() {
    try {
      return JSON.parse(await readFile(join(dataRoot, "secret-sweep-latest.json"), "utf8"));
    } catch {
      return null;
    }
  }

  return Object.freeze({ sweep, latest });
}
