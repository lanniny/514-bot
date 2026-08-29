function errorStatus(error) {
  if (Number.isInteger(error?.httpStatus)) return error.httpStatus;
  if (error?.code === "SOURCE_NOT_FOUND") return 404;
  if (error?.code === "PROXY_STORE_BLOCKED") return 503;
  return 400;
}

function maskPreview(value) {
  if (Array.isArray(value)) return value.map(maskPreview);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(?:api.?key|token|secret|password|credential)$/i.test(key) && typeof item === "string" && item) {
      output[key] = item.length > 4 ? `••••${item.slice(-4)}` : "••••";
    } else output[key] = maskPreview(item);
  }
  return output;
}

export function registerCcSwitchRoutes(router, ctx) {
  const service = ctx.state.ccswitchProxy;
  const domain = ctx.state.ccswitchDomain;
  const auth = ctx.state.ccswitchAuth;
  const handled = (handler) => async (request, response, url) => {
    try {
      await handler(request, response, url);
    } catch (error) {
      ctx.json(response, errorStatus(error), { ok: false, code: error.code || "CCSWITCH_ERROR", message: error.message });
    }
    return true;
  };

  router.get("/api/ccswitch/proxy", handled(async (request, response, url) => {
    if (url.pathname === "/api/ccswitch/proxy/status" || url.pathname === "/api/ccswitch/proxy/config") {
      ctx.json(response, 200, { ok: true, status: service.status() });
      return;
    }
    if (url.pathname === "/api/ccswitch/proxy/upstream") {
      ctx.json(response, 200, { ok: true, upstream: service.status().upstreamProxy });
      return;
    }
    if (url.pathname === "/api/ccswitch/proxy/upstream/scan") {
      ctx.json(response, 200, { ok: true, items: await service.scanLocalProxies() });
      return;
    }
    if (url.pathname === "/api/ccswitch/proxy/health") {
      ctx.json(response, 200, { ok: true, items: service.health(url.searchParams.get("app") || null) });
      return;
    }
    if (url.pathname === "/api/ccswitch/proxy/usage/summary") {
      ctx.json(response, 200, { ok: true, summary: service.usageSummary({ app: url.searchParams.get("app"), days: url.searchParams.get("days") }) });
      return;
    }
    if (url.pathname === "/api/ccswitch/proxy/usage/trends") {
      ctx.json(response, 200, {
        ok: true,
        trends: service.usageTrends({
          app: url.searchParams.get("app"),
          days: url.searchParams.get("days"),
          granularity: url.searchParams.get("granularity"),
        }),
      });
      return;
    }
    if (url.pathname === "/api/ccswitch/proxy/usage/overview") {
      ctx.json(response, 200, { ok: true, ...service.usageOverview({ app: url.searchParams.get("app"), days: url.searchParams.get("days") }) });
      return;
    }
    if (url.pathname === "/api/ccswitch/proxy/usage/providers") {
      ctx.json(response, 200, { ok: true, items: service.usageStats("provider", { app: url.searchParams.get("app"), days: url.searchParams.get("days") }) });
      return;
    }
    if (url.pathname === "/api/ccswitch/proxy/usage/models") {
      ctx.json(response, 200, { ok: true, items: service.usageStats("model", { app: url.searchParams.get("app"), days: url.searchParams.get("days") }) });
      return;
    }
    if (url.pathname === "/api/ccswitch/proxy/logs") {
      ctx.json(response, 200, {
        ok: true,
        ...service.requestLogs({
          limit: url.searchParams.get("limit"),
          offset: url.searchParams.get("offset"),
          app: url.searchParams.get("app"),
          providerId: url.searchParams.get("providerId"),
        }),
      });
      return;
    }
    const logMatch = url.pathname.match(/^\/api\/ccswitch\/proxy\/logs\/([^/]+)$/);
    if (logMatch) {
      ctx.json(response, 200, { ok: true, item: service.requestDetail(decodeURIComponent(logMatch[1])) });
      return;
    }
    if (url.pathname === "/api/ccswitch/proxy/pricing") {
      ctx.json(response, 200, { ok: true, pricing: service.pricing() });
      return;
    }
    const limitMatch = url.pathname.match(/^\/api\/ccswitch\/proxy\/limits\/([^/]+)$/);
    if (limitMatch) {
      ctx.json(response, 200, { ok: true, limits: service.checkLimits(ctx.state.providers.get(decodeURIComponent(limitMatch[1]))) });
      return;
    }
    ctx.json(response, 404, { ok: false, code: "NOT_FOUND", message: "unknown CC-Switch proxy route" });
  }));

  router.post("/api/ccswitch/proxy", handled(async (request, response, url) => {
    if (url.pathname === "/api/ccswitch/proxy/start") {
      ctx.json(response, 200, { ok: true, status: await service.start(await ctx.body(request)) });
      return;
    }
    if (url.pathname === "/api/ccswitch/proxy/stop") {
      ctx.json(response, 200, { ok: true, status: await service.stop(await ctx.body(request)) });
      return;
    }
    if (url.pathname === "/api/ccswitch/proxy/upstream/test") {
      const input = await ctx.body(request);
      ctx.json(response, 200, { ok: true, result: await service.testUpstreamProxy(input.url, {
        targetUrl: input.targetUrl,
        timeoutMs: input.timeoutMs,
      }) });
      return;
    }
    const resetMatch = url.pathname.match(/^\/api\/ccswitch\/proxy\/breaker\/([^/]+)\/([^/]+)\/reset$/);
    if (resetMatch) {
      ctx.json(response, 200, { ok: true, breaker: service.resetBreaker(decodeURIComponent(resetMatch[1]), decodeURIComponent(resetMatch[2])) });
      return;
    }
    ctx.json(response, 404, { ok: false, code: "NOT_FOUND", message: "unknown CC-Switch proxy route" });
  }));

  router.put("/api/ccswitch/proxy", handled(async (request, response, url) => {
    if (url.pathname === "/api/ccswitch/proxy/config") {
      ctx.json(response, 200, { ok: true, status: await service.updateConfig(await ctx.body(request)) });
      return;
    }
    if (url.pathname === "/api/ccswitch/proxy/upstream") {
      const input = await ctx.body(request);
      if (input.clear !== true && !String(input.url ?? "").trim()) {
        throw Object.assign(new Error("upstream proxy URL is required unless clear is true"), { code: "VALIDATION_FAILED" });
      }
      ctx.json(response, 200, { ok: true, status: await service.updateUpstreamProxy(input.clear === true ? null : input.url) });
      return;
    }
    const takeoverMatch = url.pathname.match(/^\/api\/ccswitch\/proxy\/takeover\/([^/]+)$/);
    if (takeoverMatch) {
      const input = await ctx.body(request);
      ctx.json(response, 200, { ok: true, result: await service.setTakeover(decodeURIComponent(takeoverMatch[1]), Boolean(input.enabled)) });
      return;
    }
    const pricingMatch = url.pathname.match(/^\/api\/ccswitch\/proxy\/pricing\/([^/]+)$/);
    if (pricingMatch) {
      ctx.json(response, 200, { ok: true, pricing: await service.setPricing(decodeURIComponent(pricingMatch[1]), await ctx.body(request)) });
      return;
    }
    ctx.json(response, 404, { ok: false, code: "NOT_FOUND", message: "unknown CC-Switch proxy route" });
  }));

  router.delete("/api/ccswitch/proxy/pricing/", handled(async (request, response, url) => {
    const match = url.pathname.match(/^\/api\/ccswitch\/proxy\/pricing\/([^/]+)$/);
    if (!match) {
      ctx.json(response, 404, { ok: false, code: "NOT_FOUND", message: "unknown CC-Switch proxy route" });
      return;
    }
    ctx.json(response, 200, { ok: true, result: await service.removePricing(decodeURIComponent(match[1])) });
  }));

  router.get("/api/ccswitch/domain", handled(async (request, response, url) => {
    const path = url.pathname;
    if (path === "/api/ccswitch/domain" || path === "/api/ccswitch/domain/status") {
      ctx.json(response, 200, { ok: true, state: domain.summary(), configPaths: domain.configPaths(), live: await domain.observeLiveResources() });
      return;
    }
    if (path === "/api/ccswitch/domain/prompts") {
      ctx.json(response, 200, { ok: true, items: domain.prompts(url.searchParams.get("app")) });
      return;
    }
    if (path === "/api/ccswitch/domain/prompts/current") {
      ctx.json(response, 200, { ok: true, ...(await domain.currentPromptContent(url.searchParams.get("app"))) });
      return;
    }
    if (path === "/api/ccswitch/domain/mcps") {
      ctx.json(response, 200, { ok: true, items: Object.values(domain.summary().mcps ?? {}).sort((a, b) => a.name.localeCompare(b.name)) });
      return;
    }
    if (path === "/api/ccswitch/domain/skills") {
      ctx.json(response, 200, { ok: true, items: domain.skills() });
      return;
    }
    if (path === "/api/ccswitch/domain/profiles") {
      ctx.json(response, 200, { ok: true, ...domain.profiles() });
      return;
    }
    if (path === "/api/ccswitch/domain/backups") {
      ctx.json(response, 200, { ok: true, items: await domain.listBackups() });
      return;
    }
    if (path === "/api/ccswitch/domain/stream/config") {
      ctx.json(response, 200, { ok: true, config: domain.streamCheckConfig() });
      return;
    }
    if (path === "/api/ccswitch/domain/env/conflicts") {
      ctx.json(response, 200, { ok: true, ...await domain.envConflicts(url.searchParams.get("app") || null) });
      return;
    }
    if (path === "/api/ccswitch/domain/workspace" || path === "/api/ccswitch/domain/workspace/status") {
      ctx.json(response, 200, { ok: true, workspace: await domain.workspaceStatus() });
      return;
    }
    if (path === "/api/ccswitch/domain/workspace/openclaw/daily") {
      ctx.json(response, 200, { ok: true, items: await domain.listDailyMemoryFiles() });
      return;
    }
    const dailyFile = path.match(/^\/api\/ccswitch\/domain\/workspace\/openclaw\/daily\/([^/]+)$/);
    if (dailyFile) {
      ctx.json(response, 200, { ok: true, item: await domain.readDailyMemoryFile(decodeURIComponent(dailyFile[1])) });
      return;
    }
    const workspaceFile = path.match(/^\/api\/ccswitch\/domain\/workspace\/openclaw\/files\/([^/]+)$/);
    if (workspaceFile) {
      ctx.json(response, 200, { ok: true, item: await domain.readWorkspaceFile(decodeURIComponent(workspaceFile[1])) });
      return;
    }
    if (path === "/api/ccswitch/domain/workspace/hermes/limits") {
      ctx.json(response, 200, { ok: true, limits: await domain.hermesMemoryLimits() });
      return;
    }
    const hermesMemory = path.match(/^\/api\/ccswitch\/domain\/workspace\/hermes\/(memory|user)$/);
    if (hermesMemory) {
      ctx.json(response, 200, { ok: true, item: await domain.readHermesMemory(hermesMemory[1]) });
      return;
    }
    const infoMatch = path.match(/^\/api\/ccswitch\/domain\/sync\/(webdav|s3)\/info$/);
    if (infoMatch) {
      ctx.json(response, 200, { ok: true, info: await domain.syncRemoteInfo(infoMatch[1]) });
      return;
    }
    ctx.json(response, 404, { ok: false, code: "NOT_FOUND", message: "unknown CC-Switch domain route" });
  }));

  router.post("/api/ccswitch/domain", handled(async (request, response, url) => {
    const path = url.pathname;
    const input = await ctx.body(request, 10 * 1024 * 1024);
    if (path === "/api/ccswitch/domain/prompts") {
      ctx.json(response, 200, { ok: true, item: await domain.upsertPrompt(input.app, input) });
      return;
    }
    if (path === "/api/ccswitch/domain/prompts/import") {
      ctx.json(response, 200, { ok: true, item: await domain.importPromptFromFile(input.app) });
      return;
    }
    const promptAction = path.match(/^\/api\/ccswitch\/domain\/prompts\/([^/]+)\/([^/]+)\/(enable|disable)$/);
    if (promptAction) {
      const app = decodeURIComponent(promptAction[1]);
      const id = decodeURIComponent(promptAction[2]);
      const item = promptAction[3] === "enable" ? await domain.enablePrompt(app, id) : await domain.disablePrompt(app, id);
      ctx.json(response, 200, { ok: true, item });
      return;
    }
    if (path === "/api/ccswitch/domain/mcps/import") {
      ctx.json(response, 200, { ok: true, result: await domain.adoptLiveMcps(input) });
      return;
    }
    if (path === "/api/ccswitch/domain/mcps") {
      ctx.json(response, 200, { ok: true, item: await domain.upsertMcp(input) });
      return;
    }
    if (path === "/api/ccswitch/domain/skills/import") {
      ctx.json(response, 200, { ok: true, result: await domain.adoptLiveSkills(input) });
      return;
    }
    if (path === "/api/ccswitch/domain/skills") {
      ctx.json(response, 200, { ok: true, item: await domain.installSkillFiles(input) });
      return;
    }
    if (path === "/api/ccswitch/domain/profiles") {
      ctx.json(response, 200, { ok: true, item: await domain.profileSnapshot(input) });
      return;
    }
    const applyProfile = path.match(/^\/api\/ccswitch\/domain\/profiles\/([^/]+)\/apply$/);
    if (applyProfile) {
      ctx.json(response, 200, { ok: true, result: await domain.applyProfile(decodeURIComponent(applyProfile[1]), input) });
      return;
    }
    if (path === "/api/ccswitch/domain/backups") {
      ctx.json(response, 201, { ok: true, item: await domain.createBackup(input.name) });
      return;
    }
    const restoreBackup = path.match(/^\/api\/ccswitch\/domain\/backups\/([^/]+)\/restore$/);
    if (restoreBackup) {
      ctx.json(response, 200, { ok: true, result: await domain.restoreBackup(decodeURIComponent(restoreBackup[1]), input) });
      return;
    }
    if (path === "/api/ccswitch/domain/sync-live") {
      ctx.json(response, 200, { ok: true, warnings: await domain.syncAllLive(input) });
      return;
    }
    const syncAction = path.match(/^\/api\/ccswitch\/domain\/sync\/(webdav|s3)\/(test|upload|download)$/);
    if (syncAction) {
      const [, kind, action] = syncAction;
      const result = action === "test" ? await domain.testSync(kind, input.settings ?? null)
        : action === "upload" ? await domain.syncUpload(kind)
          : await domain.syncDownload(kind, input);
      ctx.json(response, 200, { ok: true, result });
      return;
    }
    if (path === "/api/ccswitch/domain/stream/check") {
      const result = input.providerId ? await domain.streamCheckProvider(input.providerId) : await domain.streamCheckAll(input);
      ctx.json(response, 200, { ok: true, result });
      return;
    }
    if (path === "/api/ccswitch/domain/models/fetch") {
      ctx.json(response, 200, { ok: true, result: await domain.fetchModels(input) });
      return;
    }
    if (path === "/api/ccswitch/domain/deeplink/parse") {
      const parsed = domain.parseDeeplink(input.url);
      ctx.json(response, 200, { ok: true, resource: parsed.resource, preview: maskPreview(parsed.payload) });
      return;
    }
    if (path === "/api/ccswitch/domain/deeplink/import") {
      ctx.json(response, 201, { ok: true, ...(await domain.importDeeplink(input.url, input)) });
      return;
    }
    if (path === "/api/ccswitch/domain/env/delete") {
      ctx.json(response, 200, { ok: true, backup: await domain.deleteEnv(input.items, input) });
      return;
    }
    if (path === "/api/ccswitch/domain/workspace/openclaw/daily/search") {
      ctx.json(response, 200, { ok: true, items: await domain.searchDailyMemoryFiles(input.query) });
      return;
    }
    const restoreEnv = path.match(/^\/api\/ccswitch\/domain\/env\/backups\/([^/]+)\/restore$/);
    if (restoreEnv) {
      ctx.json(response, 200, { ok: true, result: await domain.restoreEnv(decodeURIComponent(restoreEnv[1]), input) });
      return;
    }
    ctx.json(response, 404, { ok: false, code: "NOT_FOUND", message: "unknown CC-Switch domain route" });
  }));

  router.put("/api/ccswitch/domain", handled(async (request, response, url) => {
    const path = url.pathname;
    const input = await ctx.body(request, 2 * 1024 * 1024);
    const configDir = path.match(/^\/api\/ccswitch\/domain\/config-dirs\/([^/]+)$/);
    if (configDir) {
      ctx.json(response, 200, { ok: true, result: await domain.setConfigDir(decodeURIComponent(configDir[1]), input.path) });
      return;
    }
    const workspaceFile = path.match(/^\/api\/ccswitch\/domain\/workspace\/openclaw\/files\/([^/]+)$/);
    if (workspaceFile) {
      ctx.json(response, 200, { ok: true, result: await domain.writeWorkspaceFile(decodeURIComponent(workspaceFile[1]), input.content) });
      return;
    }
    const dailyFile = path.match(/^\/api\/ccswitch\/domain\/workspace\/openclaw\/daily\/([^/]+)$/);
    if (dailyFile) {
      ctx.json(response, 200, { ok: true, result: await domain.writeDailyMemoryFile(decodeURIComponent(dailyFile[1]), input.content) });
      return;
    }
    const hermesEnabled = path.match(/^\/api\/ccswitch\/domain\/workspace\/hermes\/(memory|user)\/enabled$/);
    if (hermesEnabled) {
      ctx.json(response, 200, { ok: true, result: await domain.setHermesMemoryEnabled(hermesEnabled[1], input.enabled) });
      return;
    }
    const hermesMemory = path.match(/^\/api\/ccswitch\/domain\/workspace\/hermes\/(memory|user)$/);
    if (hermesMemory) {
      ctx.json(response, 200, { ok: true, result: await domain.writeHermesMemory(hermesMemory[1], input.content) });
      return;
    }
    const mcpToggle = path.match(/^\/api\/ccswitch\/domain\/mcps\/([^/]+)\/apps\/([^/]+)$/);
    if (mcpToggle) {
      ctx.json(response, 200, { ok: true, item: await domain.toggleMcp(decodeURIComponent(mcpToggle[1]), decodeURIComponent(mcpToggle[2]), input.enabled) });
      return;
    }
    const skillToggle = path.match(/^\/api\/ccswitch\/domain\/skills\/([^/]+)\/apps\/([^/]+)$/);
    if (skillToggle) {
      ctx.json(response, 200, { ok: true, item: await domain.toggleSkill(decodeURIComponent(skillToggle[1]), decodeURIComponent(skillToggle[2]), input.enabled) });
      return;
    }
    const profile = path.match(/^\/api\/ccswitch\/domain\/profiles\/([^/]+)$/);
    if (profile) {
      ctx.json(response, 200, { ok: true, item: await domain.updateProfile(decodeURIComponent(profile[1]), input) });
      return;
    }
    const currentProfile = path.match(/^\/api\/ccswitch\/domain\/profiles\/current\/([^/]+)$/);
    if (currentProfile) {
      ctx.json(response, 200, { ok: true, result: await domain.clearCurrentProfile(decodeURIComponent(currentProfile[1])) });
      return;
    }
    if (path === "/api/ccswitch/domain/stream/config") {
      ctx.json(response, 200, { ok: true, config: await domain.saveStreamCheckConfig(input) });
      return;
    }
    const syncSettings = path.match(/^\/api\/ccswitch\/domain\/sync\/(webdav|s3)\/settings$/);
    if (syncSettings) {
      ctx.json(response, 200, { ok: true, settings: await domain.saveSyncSettings(syncSettings[1], input) });
      return;
    }
    const renameBackup = path.match(/^\/api\/ccswitch\/domain\/backups\/([^/]+)\/rename$/);
    if (renameBackup) {
      ctx.json(response, 200, { ok: true, result: await domain.renameBackup(decodeURIComponent(renameBackup[1]), input.name) });
      return;
    }
    ctx.json(response, 404, { ok: false, code: "NOT_FOUND", message: "unknown CC-Switch domain route" });
  }));

  router.delete("/api/ccswitch/domain", handled(async (request, response, url) => {
    const path = url.pathname;
    const input = await ctx.body(request).catch(() => ({}));
    const prompt = path.match(/^\/api\/ccswitch\/domain\/prompts\/([^/]+)\/([^/]+)$/);
    if (prompt) {
      ctx.json(response, 200, { ok: true, result: await domain.deletePrompt(decodeURIComponent(prompt[1]), decodeURIComponent(prompt[2])) });
      return;
    }
    const mcp = path.match(/^\/api\/ccswitch\/domain\/mcps\/([^/]+)$/);
    if (mcp) {
      ctx.json(response, 200, { ok: true, result: await domain.deleteMcp(decodeURIComponent(mcp[1])) });
      return;
    }
    const skill = path.match(/^\/api\/ccswitch\/domain\/skills\/([^/]+)$/);
    if (skill) {
      ctx.json(response, 200, { ok: true, result: await domain.uninstallSkill(decodeURIComponent(skill[1]), input) });
      return;
    }
    const profile = path.match(/^\/api\/ccswitch\/domain\/profiles\/([^/]+)$/);
    if (profile) {
      ctx.json(response, 200, { ok: true, result: await domain.deleteProfile(decodeURIComponent(profile[1])) });
      return;
    }
    const backup = path.match(/^\/api\/ccswitch\/domain\/backups\/([^/]+)$/);
    if (backup) {
      ctx.json(response, 200, { ok: true, result: await domain.deleteBackup(decodeURIComponent(backup[1]), input) });
      return;
    }
    const dailyFile = path.match(/^\/api\/ccswitch\/domain\/workspace\/openclaw\/daily\/([^/]+)$/);
    if (dailyFile) {
      ctx.json(response, 200, { ok: true, result: await domain.deleteDailyMemoryFile(decodeURIComponent(dailyFile[1]), input) });
      return;
    }
    ctx.json(response, 404, { ok: false, code: "NOT_FOUND", message: "unknown CC-Switch domain route" });
  }));

  router.get("/api/ccswitch/auth", handled(async (request, response, url) => {
    const path = url.pathname;
    if (path === "/api/ccswitch/auth" || path === "/api/ccswitch/auth/status") {
      ctx.json(response, 200, { ok: true, ...auth.statusAll() });
      return;
    }
    const resource = path.match(/^\/api\/ccswitch\/auth\/([^/]+)\/(models|quota)$/);
    if (resource) {
      ctx.json(response, 200, { ok: true, result: await auth.resource(decodeURIComponent(resource[1]), resource[2], url.searchParams.get("accountId")) });
      return;
    }
    const status = path.match(/^\/api\/ccswitch\/auth\/([^/]+)$/);
    if (status) {
      ctx.json(response, 200, { ok: true, status: auth.status(decodeURIComponent(status[1])) });
      return;
    }
    ctx.json(response, 404, { ok: false, code: "NOT_FOUND", message: "unknown CC-Switch auth route" });
  }));

  router.post("/api/ccswitch/auth", handled(async (request, response, url) => {
    const input = await ctx.body(request);
    const action = url.pathname.match(/^\/api\/ccswitch\/auth\/([^/]+)\/(start|poll|logout)$/);
    if (!action) {
      ctx.json(response, 404, { ok: false, code: "NOT_FOUND", message: "unknown CC-Switch auth route" });
      return;
    }
    const provider = decodeURIComponent(action[1]);
    const result = action[2] === "start" ? await auth.startLogin(provider, input)
      : action[2] === "poll" ? await auth.pollLogin(provider, input.deviceCode)
        : await auth.logout(provider, input);
    ctx.json(response, 200, { ok: true, result });
  }));

  router.put("/api/ccswitch/auth", handled(async (request, response, url) => {
    const input = await ctx.body(request);
    const match = url.pathname.match(/^\/api\/ccswitch\/auth\/([^/]+)\/default\/([^/]+)$/);
    if (!match) {
      ctx.json(response, 404, { ok: false, code: "NOT_FOUND", message: "unknown CC-Switch auth route" });
      return;
    }
    ctx.json(response, 200, { ok: true, status: await auth.setDefault(decodeURIComponent(match[1]), decodeURIComponent(match[2]), input) });
  }));

  router.delete("/api/ccswitch/auth", handled(async (request, response, url) => {
    const input = await ctx.body(request).catch(() => ({}));
    const match = url.pathname.match(/^\/api\/ccswitch\/auth\/([^/]+)\/accounts\/([^/]+)$/);
    if (!match) {
      ctx.json(response, 404, { ok: false, code: "NOT_FOUND", message: "unknown CC-Switch auth route" });
      return;
    }
    ctx.json(response, 200, { ok: true, status: await auth.removeAccount(decodeURIComponent(match[1]), decodeURIComponent(match[2]), input) });
  }));
}
