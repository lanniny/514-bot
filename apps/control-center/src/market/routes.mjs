/**
 * market/routes.mjs — Wave G 供应链路由注册（skills/mcp 双门闸）。
 * 主驾在 server.mjs 接线：registerMarketRoutes(surfaceRouter, surfaceCtx)。
 */

import { createMarketService } from "../market.mjs";

let service = null;

function ensureService(ctx) {
  if (!service) {
    service = createMarketService({
      dataRoot: ctx.state.dataRoot,
      eventStore: ctx.state.eventStore,
      ccswitchDomain: ctx.state.ccswitchDomain,
      repoRoot: ctx.state.repoRoot,
    });
  }
  return service;
}

export function setMarketServiceForTest(instance) {
  service = instance;
}

export function registerMarketRoutes(router, ctx) {
  ctx.remoteGates.registerImplementation("skills_marketplace");
  ctx.remoteGates.registerImplementation("mcp_marketplace");
  const market = ensureService(ctx);

  const guarded = (gate, handler) => async (request, response, url) => {
    try {
      ctx.remoteGates.assert(gate);
    } catch (error) {
      ctx.json(response, error.httpStatus || 501, { ok: false, code: error.code, message: error.message });
      return true;
    }
    try {
      await handler(request, response, url);
    } catch (error) {
      ctx.json(response, error.httpStatus || 400, { ok: false, code: error.code || "MARKET_ERROR", message: error.message });
    }
    return true;
  };

  router.get("/api/market/mcp/search", guarded("mcp_marketplace", async (request, response, url) => {
    const items = await market.mcpSearch(url.searchParams.get("q") || "", url.searchParams.get("source") || "official");
    ctx.json(response, 200, { ok: true, items });
  }));

  router.post("/api/market/mcp/stage", guarded("mcp_marketplace", async (request, response) => {
    const payload = await ctx.body(request);
    ctx.json(response, 200, await market.mcpStage(payload ?? {}));
  }));

  router.post("/api/market/mcp/install", guarded("mcp_marketplace", async (request, response) => {
    const payload = await ctx.body(request);
    ctx.json(response, 200, await market.mcpInstall(payload ?? {}));
  }));

  router.post("/api/market/skills/stage", guarded("skills_marketplace", async (request, response, url) => {
    const payload = await ctx.body(request, 1024 * 1024);
    if (url.pathname.startsWith("/api/market/skills/stage-repo")) {
      ctx.json(response, 200, await market.skillsStageFromRepo(payload ?? {}));
      return;
    }
    ctx.json(response, 200, await market.skillsStage(payload ?? {}));
  }));

  router.post("/api/market/skills/install", guarded("skills_marketplace", async (request, response) => {
    const payload = await ctx.body(request);
    ctx.json(response, 200, await market.skillsInstall(payload ?? {}));
  }));

  router.get("/api/market/installed", guarded("skills_marketplace", async (request, response) => {
    ctx.json(response, 200, { ok: true, items: await market.installedList() });
  }));

  // W3.12 团队模板库：上架（stage）→ 安装（install，进 installed 台账）→ 模板清单/取包
  router.post("/api/market/team/stage", guarded("skills_marketplace", async (request, response) => {
    const payload = await ctx.body(request);
    ctx.json(response, 200, await market.teamStage(payload ?? {}));
  }));
  router.post("/api/market/team/install", guarded("skills_marketplace", async (request, response) => {
    const payload = await ctx.body(request);
    ctx.json(response, 200, await market.teamInstall(payload ?? {}));
  }));
  router.get("/api/market/team/templates", guarded("skills_marketplace", async (request, response) => {
    ctx.json(response, 200, { ok: true, ...await market.teamTemplates() });
  }));
  router.get("/api/market/team/pack", guarded("skills_marketplace", async (request, response, url) => {
    ctx.json(response, 200, await market.teamPack({ id: url.searchParams.get("id") || "" }));
  }));

  router.get("/api/market/skills", guarded("skills_marketplace", async (request, response) => {
    ctx.json(response, 200, { ok: true, skills: await market.skillsList() });
  }));

  router.delete("/api/market/skills/", guarded("skills_marketplace", async (request, response, url) => {
    const name = url.pathname.replace(/^\/api\/market\/skills\//, "");
    const removed = await market.skillsRemove(name);
    ctx.json(response, removed ? 200 : 404, removed
      ? { ok: true }
      : { ok: false, code: "MARKET_NOT_FOUND", message: `skill not found: ${name}` });
  }));

  router.delete("/api/market/mcp/", guarded("mcp_marketplace", async (request, response, url) => {
    const id = decodeURIComponent(url.pathname.replace(/^\/api\/market\/mcp\//, ""));
    ctx.json(response, 200, { ok: true, ...(await market.mcpRemove(id)) });
  }));

  router.put("/api/market/mcp/", guarded("mcp_marketplace", async (request, response, url) => {
    const id = decodeURIComponent(url.pathname.replace(/^\/api\/market\/mcp\//, ""));
    const payload = await ctx.body(request);
    ctx.json(response, 200, await market.mcpUpdateApps({ id, apps: payload?.apps }));
  }));

  router.put("/api/market/skills/", guarded("skills_marketplace", async (request, response, url) => {
    const name = decodeURIComponent(url.pathname.replace(/^\/api\/market\/skills\//, ""));
    const payload = await ctx.body(request);
    ctx.json(response, 200, await market.skillUpdateApps({ name, apps: payload?.apps }));
  }));

  router.get("/api/market/repos", guarded("skills_marketplace", async (request, response) => {
    ctx.json(response, 200, { ok: true, repos: await market.listRepos() });
  }));

  router.post("/api/market/repos", guarded("skills_marketplace", async (request, response, url) => {
    const rest = url.pathname.slice("/api/market/repos".length);
    if (rest === "/scan-all") {
      ctx.json(response, 200, { ok: true, ...(await market.scanAllRepos()) });
      return;
    }
    if (rest.endsWith("/scan")) {
      const id = decodeURIComponent(rest.replace(/^\//, "").replace(/\/scan$/, ""));
      ctx.json(response, 200, { ok: true, repo: await market.scanRepo(id) });
      return;
    }
    const payload = await ctx.body(request);
    ctx.json(response, 201, { ok: true, repo: await market.addRepo(payload ?? {}) });
  }));

  router.delete("/api/market/repos/", guarded("skills_marketplace", async (request, response, url) => {
    const id = decodeURIComponent(url.pathname.replace(/^\/api\/market\/repos\//, ""));
    ctx.json(response, 200, { ok: true, ...(await market.removeRepo(id)) });
  }));

  router.get("/api/market/catalog", guarded("skills_marketplace", async (request, response, url) => {
    ctx.json(response, 200, { ok: true, skills: await market.catalogSkills(url.searchParams.get("q") || "") });
  }));

}
