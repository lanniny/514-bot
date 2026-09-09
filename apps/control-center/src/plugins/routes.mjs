export function registerPluginRoutes(router, { state, json, body }) {
  const handler = (method, action) => async (request, response, url) => {
    if (url.pathname !== `/api/plugins${action ? `/${action}` : ""}`) return false;
    try {
      const payload = method === "GET" ? null : await body(request, 128 * 1024);
      let result;
      if (!action) result = state.projectPlugins.list(url.searchParams.get("projectId"));
      else if (action === "execute") result = state.projectPlugins.execute(payload, { runs: [...state.orchestrator.runs.values()] });
      else result = await state.projectPlugins[action](payload);
      json(response, 200, { ok: true, ...result });
    } catch (error) { json(response, error.httpStatus || 400, { ok: false, code: error.code || "PLUGIN_ERROR", message: error.message }); }
    return true;
  };
  router.get("/api/plugins", handler("GET", ""));
  for (const action of ["install", "configure", "remove", "execute"]) router.post(`/api/plugins/${action}`, handler("POST", action));
}
