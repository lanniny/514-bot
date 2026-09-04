/**
 * 许可请求的内核侧监听端（v50 · 2026-09-04）。
 *
 * ── 它在链路里的位置 ──
 *   Claude CLI ──stdio──> 每轮生成的 MCP server 脚本 ──具名管道──> 本模块 ──> ApprovalBroker ──> UI
 *
 * MCP server 是 CLI 拉起的子进程，与内核之间没有天然通道。这里开一条**每轮专属**的
 * 具名管道（Windows `\\.\pipe\...` / POSIX unix socket），路径含随机段，
 * 并把它内联进那一轮的脚本常量里 —— 连接本身即能力凭证（烛 S-1/S-2）。
 *
 * ── 为什么不复用 HTTP loopback ──
 * `CONTROL_CENTER_TOKEN` 被有意排除在子进程 env 外（`tests/adapters.test.mjs:1218` 锁死），
 * 所以 loopback 端口在本机是**无凭证**的：同用户任意进程都能连上伪造审批应答。
 * 具名管道的路径可以只存在于脚本文件里（可 ACL），不出现在任何 argv 中。
 *
 * ── 归属不可伪造 ──
 * 每条管道只服务一轮。请求里携带的 runId/sessionId 只用于**交叉校验**，
 * 真正的归属来自内核在建管道时就记住的那一份 —— 沙箱侧谎报会被当场拒绝。
 */

import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";

/** 单条许可请求的应答上限：超时按拒绝结算，绝不挂起（挂起会让整轮撞 CLI 进程超时）。 */
export const DEFAULT_DECISION_TIMEOUT_MS = 300_000;

/** 一轮内允许的许可请求总数上限 —— 防沙箱侧洪水式请求淹没审批队列。 */
export const DEFAULT_MAX_REQUESTS_PER_RUN = 64;

/** 单帧字节上限：审批卡要渲染这些参数，超大 payload 既无法阅读也是内存放大面。 */
const MAX_FRAME_BYTES = 256 * 1024;

/** 生成该轮专属的管道路径（含随机段，不可预测）。 */
export function permissionEndpointPath(runId = "run") {
  const token = randomBytes(12).toString("hex");
  const safeRun = String(runId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "run";
  return process.platform === "win32"
    ? `\\\\.\\pipe\\cc-approval-${safeRun}-${token}`
    : join(tmpdir(), `cc-approval-${safeRun}-${token}.sock`);
}

/**
 * 为一轮 run 开一条许可管道。
 *
 * @param {object} options
 * @param {string} options.runId            该轮 id —— **权威归属**，不接受请求自称
 * @param {string} options.sessionId
 * @param {string} options.agentId
 * @param {(request: object) => Promise<{approved: boolean, message?: string}>} options.decide
 *        把一条许可请求交给操作者决策；抛错或返回非对象一律按拒绝处理
 * @param {(type: string, data: object) => void} [options.emit] 事件上报（可选）
 */
export function createPermissionEndpoint({
  runId,
  sessionId = null,
  agentId = null,
  decide,
  emit = null,
  endpointPath = null,
  decisionTimeoutMs = DEFAULT_DECISION_TIMEOUT_MS,
  maxRequests = DEFAULT_MAX_REQUESTS_PER_RUN,
}) {
  if (typeof runId !== "string" || !runId) {
    throw Object.assign(new Error("permission endpoint requires a runId"), { code: "INVALID_PERMISSION_ENDPOINT" });
  }
  if (typeof decide !== "function") {
    throw Object.assign(new Error("permission endpoint requires a decide() callback"), { code: "INVALID_PERMISSION_ENDPOINT" });
  }

  const path = endpointPath || permissionEndpointPath(runId);
  let served = 0;
  let closed = false;
  const sockets = new Set();
  const report = (type, data) => { try { emit?.(type, { runId, sessionId, ...data }); } catch {} };

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;

    const reply = (value) => {
      if (handled) return;
      handled = true;
      try { socket.end(`${JSON.stringify(value)}\n`); } catch {}
    };

    socket.on("error", () => { sockets.delete(socket); });
    socket.on("close", () => { sockets.delete(socket); });

    socket.on("data", async (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        report("approval.endpoint_rejected", { reason: "frame_too_large" });
        reply({ decision: "deny", message: "许可请求超出体积上限，已拒绝。" });
        return;
      }
      const index = buffer.indexOf("\n");
      if (index === -1) return;
      let request;
      try {
        request = JSON.parse(buffer.slice(0, index));
      } catch {
        report("approval.endpoint_rejected", { reason: "malformed_frame" });
        reply({ decision: "deny", message: "许可请求格式损坏，已拒绝。" });
        return;
      }

      // 归属交叉校验：脚本内联的常量应与内核记住的一致。不一致意味着
      // 要么脚本被改写、要么有人拿别轮的脚本来连 —— 两种都拒。
      if (request?.runId !== runId) {
        report("approval.endpoint_rejected", { reason: "run_mismatch", claimed: String(request?.runId ?? "") .slice(0, 64) });
        reply({ decision: "deny", message: "许可请求的归属与本轮不符，已拒绝。" });
        return;
      }
      served += 1;
      if (served > maxRequests) {
        report("approval.endpoint_rejected", { reason: "too_many_requests", served, maxRequests });
        reply({ decision: "deny", message: `本轮许可请求已超过 ${maxRequests} 条上限，已拒绝。` });
        return;
      }

      // 有界等待：超时按拒绝结算。挂起会让整轮撞 CLI 的进程超时被杀，
      // 那正是这个特性要消灭的那个红色错误。
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ approved: false, message: "控制面未能在时限内应答，已按拒绝处理。" }), decisionTimeoutMs);
        timer.unref?.();
      });
      let verdict;
      try {
        verdict = await Promise.race([
          Promise.resolve().then(() => decide({
            runId,
            sessionId,
            agentId,
            toolName: typeof request.toolName === "string" ? request.toolName : "",
            input: request.input && typeof request.input === "object" && !Array.isArray(request.input) ? request.input : {},
            toolUseId: typeof request.toolUseId === "string" ? request.toolUseId : null,
          })),
          timeout,
        ]);
      } catch (error) {
        // fail-closed：决策链路任何异常都是拒绝，绝不放行
        report("approval.endpoint_error", { reason: "decide_threw", message: String(error?.message || error).slice(0, 200) });
        verdict = { approved: false, message: "控制面处理审批时出错，已按拒绝处理。" };
      } finally {
        clearTimeout(timer);
      }
      reply(verdict?.approved === true
        ? { decision: "approve" }
        : { decision: "deny", message: typeof verdict?.message === "string" && verdict.message ? verdict.message : "操作者拒绝了此次工具调用。" });
    });
  });

  const listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.removeListener("error", reject); resolve(); });
  });

  return {
    path,
    ready: listening,
    get servedCount() { return served; },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) { try { socket.destroy(); } catch {} }
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
      // POSIX 的 unix socket 是真实文件，要显式清理；Windows 具名管道随进程回收。
      if (process.platform !== "win32") { try { await unlink(path); } catch {} }
    },
  };
}
