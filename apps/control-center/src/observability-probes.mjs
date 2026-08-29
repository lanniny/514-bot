/**
 * 观测与可运维基础（F-059 / F-060 / F-063）。
 *
 * 三块能力：
 *   1. **健康探针**（/healthz, /readyz）—— K8s/桌面壳标准 liveness + readiness
 *   2. **全链路 trace id**（x-request-id 传播）—— 请求级关联
 *   3. **崩溃快照**（crash-snapshot）—— uncaughtException 时写 JSON 诊断文件
 */

import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ─── 1. 健康探针 ──────────────────────────────────────────────────────────────

/**
 * /healthz — 存活探针。
 * 只要进程还在、event loop 能响应就返回 200。
 * 绝不触碰磁盘/网络/外部依赖——探针本身不能成为故障源。
 */
export function handleHealthz(response) {
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
}

/**
 * /readyz — 就绪探针。
 * 检查核心服务是否已初始化完成。
 * ready=true 表示可以接收流量/用户操作；ready=false 表示仍在启动中。
 */
export function createReadinessChecker() {
  const checks = new Map();
  return {
    /** 注册一个就绪检查。name 唯一，fn 返回 boolean 或 Promise<boolean>。 */
    register(name, fn) {
      checks.set(name, fn);
    },
    /** 移除检查（服务销毁时）。 */
    unregister(name) {
      checks.delete(name);
    },
    /** 执行所有检查，返回 { ready, details }。 */
    async check() {
      const details = {};
      let allReady = true;
      for (const [name, fn] of checks) {
        try {
          const result = await fn();
          details[name] = { ready: Boolean(result) };
          if (!result) allReady = false;
        } catch (error) {
          details[name] = { ready: false, error: error.message };
          allReady = false;
        }
      }
      return { ready: allReady, details };
    },
  };
}

export async function handleReadyz(response, readiness) {
  const result = await readiness.check();
  const status = result.ready ? 200 : 503;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ ...result, timestamp: new Date().toISOString() }));
}

// ─── 2. 全链路 trace id ──────────────────────────────────────────────────────

/**
 * 从请求头获取或生成 trace id。
 * 如果上游传了 x-request-id，原样透传（保持链路连续性）；
 * 否则生成新的 UUID v4。
 */
export function traceIdFromRequest(request) {
  const header = request.headers["x-request-id"];
  if (header && typeof header === "string" && header.length <= 128) {
    return header;
  }
  return randomUUID();
}

/**
 * 生成 trace id 的短码（前 8 位），用于日志前缀。
 */
export function traceShort(traceId) {
  return traceId ? traceId.slice(0, 8) : "--------";
}

// ─── 3. 崩溃快照 ──────────────────────────────────────────────────────────────

/**
 * 收集当前进程的运行时快照（同步，不 await 任何外部 IO）。
 * 用于 uncaughtException 时快速 capture 诊断信息。
 */
export function collectCrashSnapshot({ pid, generation, startedAt, repoRoot, getActiveRuns, getPendingApprovals, getChildProcesses } = {}) {
  const mem = process.memoryUsage();
  return {
    timestamp: new Date().toISOString(),
    pid,
    generation: generation ?? null,
    uptime: process.uptime(),
    startedAt: startedAt ?? null,
    repoRoot: repoRoot ?? null,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
    },
    activeRuns: typeof getActiveRuns === "function" ? getActiveRuns() : null,
    pendingApprovals: typeof getPendingApprovals === "function" ? getPendingApprovals() : null,
    childProcesses: typeof getChildProcesses === "function" ? getChildProcesses() : null,
  };
}

/**
 * 将崩溃快照写入磁盘。
 * 文件名含时间戳，避免覆盖。最多保留最近 5 个快照。
 */
export function writeCrashSnapshot(snapshot, crashDir) {
  try {
    mkdirSync(crashDir, { recursive: true });
    const ts = snapshot.timestamp.replace(/[:.]/g, "-");
    const filename = `crash-snapshot-${ts}-${snapshot.pid}.json`;
    const filepath = join(crashDir, filename);
    writeFileSync(filepath, JSON.stringify(snapshot, null, 2), "utf8");
    return filepath;
  } catch {
    // 崩溃路径不能再抛异常
    return null;
  }
}
