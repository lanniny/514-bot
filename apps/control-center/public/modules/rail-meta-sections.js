// Wave B：置顶区 + 归档区渲染（从 app.js renderRailMetaSections 提取）
// 工厂 + DI 模式，与 statusline.js / context-menu.js 同律
export function createRailMetaSections({
  elements,
  state,
  escapeHtml,
  getRailTeamId,
  getRuns,
  getAllProjects,
  inRailTeam,
  runInRailTeam,
  projectPrefOf,
  sessionPrefOf,
  explicitProjectTeamId,
  teamById,
  buildRunHtml,
  buildPinnedProjectHtml,
  buildSessionLinkHtml,
  commitMarkup,
  ACTIVE_RUN_STATES,
}) {
  function render() {
    if (state.view !== "workbench") return;
    const railId = getRailTeamId();
    const pinnedRuns = getRuns().filter(
      (run) => !run.archived && run.pinned && !ACTIVE_RUN_STATES.has(run.status) && run.status !== "interrupted" && runInRailTeam(run),
    );
    const allProjects = getAllProjects();
    const pinnedProjects = allProjects.filter((project) => {
      const pref = projectPrefOf(project);
      return pref.pinned && !pref.hidden && inRailTeam(explicitProjectTeamId(project));
    });
    const pinnedSessions = [];
    const archivedSessions = [];
    for (const project of allProjects) {
      if (projectPrefOf(project).hidden) continue;
      for (const session of project.sessions ?? []) {
        const pref = sessionPrefOf(session.cli ?? "claude", project.id, session.id);
        const explicitTeamId = pref.teamId && teamById(pref.teamId) ? pref.teamId : explicitProjectTeamId(project);
        if (!inRailTeam(explicitTeamId)) continue;
        if (pref.archived) archivedSessions.push({ project, session });
        else if (pref.pinned) pinnedSessions.push({ project, session });
      }
    }
    const pinnedTotal = pinnedRuns.length + pinnedProjects.length + pinnedSessions.length;
    elements["rail-pinned"].hidden = !pinnedTotal;
    elements["pinned-count"].textContent = String(pinnedTotal);
    commitMarkup(
      elements["pinned-run-list"],
      [
        ...pinnedRuns.map(buildRunHtml),
        ...pinnedProjects.map((project, index) => buildPinnedProjectHtml(project, index)),
        ...pinnedSessions.map(({ project, session }) => buildSessionLinkHtml(project, session)),
      ].join(""),
    );
    const archivedRuns = getRuns().filter((run) => run.archived && runInRailTeam(run));
    const archivedTotal = archivedRuns.length + archivedSessions.length;
    elements["rail-archived"].hidden = !archivedTotal;
    elements["archived-count"].textContent = String(archivedTotal);
    elements["archived-toggle"].setAttribute("aria-expanded", String(state.archivedExpanded));
    elements["archived-run-list"].hidden = !state.archivedExpanded;
    commitMarkup(
      elements["archived-run-list"],
      state.archivedExpanded
        ? [
            ...archivedRuns.map(buildRunHtml),
            ...archivedSessions.map(({ project, session }) => buildSessionLinkHtml(project, session)),
          ].join("")
        : "",
    );
  }

  function togglePinned(id) {
    if (state.expandedPinnedProjects.has(id)) state.expandedPinnedProjects.delete(id);
    else state.expandedPinnedProjects.add(id);
    render();
  }

  function toggleArchived() {
    state.archivedExpanded = !state.archivedExpanded;
    render();
  }

  return { render, togglePinned, toggleArchived };
}
