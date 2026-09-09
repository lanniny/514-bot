/**
 * pet/routes.mjs — 桌宠面路由（Wave G 面模式）。
 * 主驾在 server.mjs 接线：registerPetRoutes(surfaceRouter, surfaceCtx)。
 *
 * 两条端点，都走 /api/ 统一 Bearer 门：
 *   POST /api/pet/input  — 主窗口转发的打字/交互脉冲（body 极小、限 4KiB）
 *   GET  /api/pet/stream — 独立轻量 SSE：只广播瞬态脉冲，无回放/无账本/无游标
 */

import { createPetHub } from "./hub.mjs";

const hub = createPetHub();
const INPUT_KINDS = new Set(["typing", "poke", "mouse"]);
const HEARTBEAT_MS = 15_000;

export function registerPetRoutes(router, ctx) {
  router.post("/api/pet/input", async (request, response) => {
    const payload = await ctx.body(request, 4 * 1024);
    const kind = String(payload?.kind || "").trim();
    if (!INPUT_KINDS.has(kind)) {
      ctx.json(response, 400, { ok: false, code: "PET_INPUT_KIND", message: "unknown pet input kind" });
      return true;
    }
    hub.publish({ kind });
    ctx.json(response, 202, { ok: true });
    return true;
  });

  router.get("/api/pet/stream", async (request, response) => {
    let closed = false;
    let unsubscribe = () => {};
    let heartbeat = null;
    const closeStream = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
    };
    request.on("error", closeStream);
    request.on("close", closeStream);
    response.on("error", closeStream);
    response.on("close", closeStream);

    try {
      unsubscribe = hub.subscribe((event) => {
        if (closed) return;
        try {
          if (!response.write(`event: ${event.kind}\ndata: {}\n\n`)) {
            closeStream();
            response.end();
          }
        } catch { closeStream(); }
      });
    } catch (error) {
      closeStream();
      ctx.json(response, error.httpStatus || 503, { ok: false, code: error.code || "PET_STREAM_UNAVAILABLE", message: "pet stream unavailable" });
      return true;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    response.write(`retry: 2000\n\n`);

    heartbeat = setInterval(() => {
      if (closed) return;
      try {
        if (!response.write(`: pet heartbeat\n\n`)) {
          closeStream();
          response.end();
        }
      } catch {
        closeStream();
      }
    }, HEARTBEAT_MS);
    return true;
  });
}

/** 供测试断言广播行为：直接订阅内部 hub。 */
export function petHubForTest() {
  return hub;
}
