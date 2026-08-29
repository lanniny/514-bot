/**
 * pty/routes.mjs — Wave G PTY 终端路由注册。
 * 主驾在 server.mjs 接线：registerPtyRoutes(surfaceRouter, surfaceCtx)。
 * 每个 handler 首行门闸 assert；SSE 流自管 response（不走 json）。
 */

import { resolve } from "node:path";
import { createPtyService } from "../pty.mjs";
import { getSshService } from "../ssh/routes.mjs";
import { expandIdentityPath } from "../ssh/discover.mjs";
import { assertSshIdentityShape } from "../ssh.mjs";

/**
 * ssh 远程终端 spawn 参数（纯函数，单测直接打）：
 * 起本机 OpenSSH 客户端，认证/指纹由它吃系统 known_hosts 自己管，未知主机在终端里就地询问——真实语义。
 */
export function buildSshPtyArgs(host, path = "") {
  // spawn 边界的最后一道闸（防存量台账脏值）：`${user}@${host}` 不能伪装成 ssh 选项
  assertSshIdentityShape(host.host, host.user);
  const args = ["-tt", "-p", String(host.port || 22)];
  const identityFile = expandIdentityPath(host.identityFile, host);
  if (identityFile) args.push("-i", identityFile);
  args.push(`${host.user}@${host.host}`);
  const remotePath = String(path ?? "").trim();
  if (remotePath) args.push(`cd '${remotePath.replace(/'/g, "'\\''")}' && exec $SHELL -l`);
  return args;
}

/** node-pty/CreateProcess 认带扩展名的可执行名（cmd.exe 同理）；Windows 内置 OpenSSH 在 PATH。 */
export function sshShellCommand(platform = process.platform) {
  return platform === "win32" ? "ssh.exe" : "ssh";
}

let service = null;

function ensureService(ctx) {
  if (!service) {
    service = createPtyService({
      repoRoot: ctx.state.repoRoot,
      eventStore: ctx.state.eventStore,
      // 默认放行仓库的上一级（514claude 工作区），选中的兄弟项目才能在自己的目录开终端
      extraCwdRoots: () => [resolve(ctx.state.repoRoot, "..")],
    });
  }
  return service;
}

/** 测试注入用：允许替换服务实例（fake spawn / 独立 registry）。 */
export function setPtyServiceForTest(instance) {
  service = instance;
}

/** 供专用路由（run CLI 接续终端）复用同一 PTY 服务实例。 */
export function getPtyServiceFor(ctx) {
  return ensureService(ctx);
}

function gate(ctx) {
  try {
    ctx.remoteGates.assert("pty");
    return null;
  } catch (error) {
    return error;
  }
}

function gateReject(response, ctx, error) {
  ctx.json(response, error.httpStatus || 501, { ok: false, code: error.code, message: error.message });
}

/**
 * ssh 远程终端：payload.ssh = { hostId, path? }。
 * 双门闸（pty + ssh）；主机来自 SSH 台账，停用即拒；title 落「主机名 · 远程目录」供页签显示。
 */
async function createSshPty(ctx, pty, sshPayload) {
  ctx.remoteGates.assert("ssh");
  const sshService = getSshService();
  if (!sshService) {
    throw Object.assign(new Error("ssh service is not wired in this build"), { code: "SSH_NOT_WIRED", httpStatus: 503 });
  }
  if (sshService._initPromise) await sshService._initPromise;
  const hostId = String(sshPayload?.hostId ?? "");
  const host = sshService.list().find((entry) => entry.id === hostId) ?? null;
  if (!host) {
    throw Object.assign(new Error(`ssh host not found: ${hostId}`), { code: "SSH_HOST_NOT_FOUND", httpStatus: 404 });
  }
  if (host.enabled === false) {
    throw Object.assign(new Error(`ssh host is disabled: ${host.name}`), { code: "SSH_HOST_DISABLED", httpStatus: 409 });
  }
  const remotePath = String(sshPayload?.path ?? "").trim();
  if (remotePath.includes("\0") || remotePath.length > 500) {
    throw Object.assign(new Error("ssh remote path contains NUL or exceeds 500 chars"), { code: "PTY_BAD_SSH_PATH", httpStatus: 400 });
  }
  return pty.create({
    shell: sshShellCommand(),
    args: buildSshPtyArgs(host, remotePath),
    title: `${host.name}${remotePath ? ` · ${remotePath}` : ""}`,
  });
}

export function registerPtyRoutes(router, ctx) {
  ctx.remoteGates.registerImplementation("pty");
  const pty = ensureService(ctx);

  router.post("/api/pty", async (request, response, url) => {
    if (url.pathname !== "/api/pty") return false;
    const error = gate(ctx);
    if (error) return gateReject(response, ctx, error), true;
    try {
      const payload = await ctx.body(request);
      if (payload?.ssh != null) {
        const session = await createSshPty(ctx, pty, payload.ssh);
        ctx.json(response, 201, { ok: true, session });
        return true;
      }
      const session = pty.create(payload ?? {});
      ctx.json(response, 201, { ok: true, session });
    } catch (error2) {
      ctx.json(response, error2.httpStatus || 400, { ok: false, code: error2.code, message: error2.message });
    }
    return true;
  });

  router.get("/api/pty", async (request, response, url) => {
    if (url.pathname !== "/api/pty") return false;
    const error = gate(ctx);
    if (error) return gateReject(response, ctx, error), true;
    ctx.json(response, 200, { ok: true, sessions: pty.list() });
    return true;
  });

  router.get("/api/pty/", async (request, response, url) => {
    const error = gate(ctx);
    if (error) return gateReject(response, ctx, error), true;
    const parts = url.pathname.split("/").filter(Boolean); // ["api","pty",":id",...rest]
    const id = parts[2];
    const tail = parts[3] ?? "";
    const session = pty.get(id);
    if (!session) {
      ctx.json(response, 404, { ok: false, code: "PTY_NOT_FOUND", message: `pty session not found: ${id}` });
      return true;
    }
    if (request.method === "GET" && tail === "stream") {
      // SSE：先 replay 环形缓冲再实时推流；心跳 20s；断开清理。
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      let closed = false;
      const send = (chunk, meta) => {
        if (closed) return;
        const data = meta ? JSON.stringify({ ...meta }) : JSON.stringify({ chunk });
        try {
          // JSON.stringify 输出不含真实换行，直接写帧即可（历史上多余的 \n 转义曾致前端反转义后 parse 失败丢 chunk）
          response.write(`data: ${data}\n\n`);
        } catch { closed = true; }
      };
      // 心跳与清理入口必须先于订阅就绪：subscribe 对已退出的会话会在调用内同步回调 exited 帧，
      // 若等 close 事件再清理，退出帧先置位 closed 会让心跳定时器与会话监听永远摘不掉。
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          response.write(": heartbeat\n\n");
        } catch { /* 断开 */ }
      }, 20_000);
      let unsubscribe = null;
      let tornDown = false;
      const cleanup = () => {
        if (tornDown) return;
        tornDown = true;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe?.();
      };
      unsubscribe = pty.subscribe(id, (chunk, meta) => {
        if (chunk == null) {
          send(null, { exited: true, exitCode: meta?.exitCode ?? null });
          response.end();
          cleanup();
          return;
        }
        send(chunk);
      }, { replay: url.searchParams.get("replay") !== "0" });
      response.once("close", cleanup);
      response.once("error", cleanup);
      return true;
    }
    if (tail === "") {
      ctx.json(response, 200, {
        ok: true,
        session: {
          id: session.id, shell: session.shell, title: session.title ?? null, cwd: session.cwd, pid: session.pid,
          cols: session.cols, rows: session.rows, exited: session.exited,
          exitCode: session.exitCode, createdAt: session.createdAt, bytes: session.bytes,
        },
      });
      return true;
    }
    return false;
  });

  router.post("/api/pty/", async (request, response, url) => {
    const error = gate(ctx);
    if (error) return gateReject(response, ctx, error), true;
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[2];
    const tail = parts[3] ?? "";
    try {
      const payload = await ctx.body(request);
      if (tail === "input") {
        await pty.write(id, payload?.data ?? "");
        ctx.json(response, 200, { ok: true });
        return true;
      }
      if (tail === "resize") {
        const size = pty.resize(id, payload?.cols, payload?.rows);
        ctx.json(response, 200, { ok: true, ...size });
        return true;
      }
    } catch (error2) {
      ctx.json(response, error2.httpStatus || 400, { ok: false, code: error2.code, message: error2.message });
      return true;
    }
    return false;
  });

  router.delete("/api/pty/", async (request, response, url) => {
    const error = gate(ctx);
    if (error) return gateReject(response, ctx, error), true;
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[2];
    const killed = pty.kill(id);
    ctx.json(response, killed ? 200 : 404, killed
      ? { ok: true }
      : { ok: false, code: "PTY_NOT_FOUND", message: `pty session not found: ${id}` });
    return true;
  });
}
