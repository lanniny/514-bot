// modules/project-prefs-store.js — Wave B slice 17
// 项目侧栏偏好（置顶/重命名/隐藏）的乐观并发存储：snapshot/diff/merge 代数 + 队列化保存泵。
// 工厂 + DI：state/request/toast/renderProjects/renderStatusline 从 app.js 注入。

export function createProjectPrefsStore({
  state,
  request,
  toast,
  renderProjects,
  renderStatusline,
}) {
  function projectPrefsFromPayload(payload) {
    const revision = Number(payload?.revision);
    return payload?.projects
      ? {
          revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
          projects: payload.projects,
          sessions: payload?.sessions ?? {},
        }
      : { revision: 0, projects: {}, sessions: {} };
  }

  function projectPrefsSnapshot(source = state.projectPrefs) {
    const value = { projects: source?.projects ?? {}, sessions: source?.sessions ?? {} };
    return typeof structuredClone === "function"
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  }

  function cloneProjectPrefs(source) {
    return { revision: source.revision, ...projectPrefsSnapshot(source) };
  }

  function projectPrefValueEqual(left, right) {
    if (Object.is(left, right)) return true;
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function diffProjectPrefs(base, desired) {
    const changes = [];
    for (const collection of ["projects", "sessions"]) {
      const before = base?.[collection] ?? {};
      const after = desired?.[collection] ?? {};
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (!Object.hasOwn(after, key)) {
          changes.push({ collection, key, removeEntry: true });
          continue;
        }
        const beforeEntry = Object.hasOwn(before, key) && before[key] && typeof before[key] === "object" ? before[key] : {};
        const afterEntry = after[key] && typeof after[key] === "object" ? after[key] : {};
        for (const field of new Set([...Object.keys(beforeEntry), ...Object.keys(afterEntry)])) {
          if (!Object.hasOwn(afterEntry, field)) changes.push({ collection, key, field, removeField: true });
          else if (!Object.hasOwn(beforeEntry, field) || !projectPrefValueEqual(beforeEntry[field], afterEntry[field])) {
            changes.push({ collection, key, field, value: afterEntry[field] });
          }
        }
      }
    }
    return changes;
  }

  function applyProjectPrefsChanges(base, changes) {
    const next = projectPrefsSnapshot(base);
    for (const change of changes) {
      const collection = next[change.collection];
      if (change.removeEntry) {
        delete collection[change.key];
        continue;
      }
      const entry = collection[change.key] && typeof collection[change.key] === "object"
        ? { ...collection[change.key] }
        : {};
      if (change.removeField) delete entry[change.field];
      else entry[change.field] = change.value;
      collection[change.key] = entry;
    }
    return next;
  }

  let projectPrefsAuthoritative = { revision: 0, projects: {}, sessions: {} };

  function setProjectPrefsAuthoritative(payload, { adopt = false } = {}) {
    projectPrefsAuthoritative = cloneProjectPrefs(projectPrefsFromPayload(payload));
    if (adopt) state.projectPrefs = cloneProjectPrefs(projectPrefsAuthoritative);
    return projectPrefsAuthoritative;
  }

  function rebaseProjectPrefsOperation(operation, base) {
    const changes = diffProjectPrefs(operation.baseSnapshot, operation.desired);
    operation.baseSnapshot = projectPrefsSnapshot(base);
    operation.desired = applyProjectPrefsChanges(operation.baseSnapshot, changes);
    return operation.desired;
  }

  function mergeProjectPrefsOperations(...operations) {
    const queued = operations.filter(Boolean);
    const baseSnapshot = projectPrefsSnapshot(projectPrefsAuthoritative);
    let desired = projectPrefsSnapshot(baseSnapshot);
    for (const operation of queued) {
      desired = applyProjectPrefsChanges(desired, diffProjectPrefs(operation.baseSnapshot, operation.desired));
    }
    return {
      baseSnapshot,
      desired,
      revision: Math.max(0, ...queued.map((operation) => operation.revision ?? 0)),
      waiters: queued.flatMap((operation) => operation.waiters ?? []),
    };
  }

  let projectPrefsLoadPromise = null;
  async function loadProjectPrefs({ notify = true } = {}) {
    if (state.projectPrefsStatus === "ready") return true;
    if (projectPrefsLoadPromise) return projectPrefsLoadPromise;
    state.projectPrefsStatus = "loading";
    projectPrefsLoadPromise = (async () => {
      try {
        const authoritative = setProjectPrefsAuthoritative(await request("/api/projects/prefs"));
        if (projectPrefsPendingSave) {
          const optimistic = rebaseProjectPrefsOperation(projectPrefsPendingSave, authoritative);
          state.projectPrefs = { revision: authoritative.revision, ...optimistic };
        } else {
          state.projectPrefs = cloneProjectPrefs(authoritative);
        }
        state.projectPrefsStatus = "ready";
        state.projectPrefsError = null;
        renderProjects();
        renderStatusline();
        if (projectPrefsPendingSave) queueMicrotask(() => void drainProjectPrefsSaves());
        return true;
      } catch (error) {
        state.projectPrefsStatus = "error";
        state.projectPrefsError = error.message;
        renderStatusline();
        if (notify) toast(`项目偏好加载失败，写入已锁定：${error.message}`, "error", 6000);
        return false;
      } finally {
        projectPrefsLoadPromise = null;
      }
    })();
    return projectPrefsLoadPromise;
  }

  async function ensureProjectPrefsWritable() {
    if (state.projectPrefsStatus === "ready") return true;
    const ready = await loadProjectPrefs();
    if (!ready) {
      toast(
        projectPrefsPendingSave
          ? "项目偏好仍处于写锁；已保留的本地修改会等待重试，本次新修改尚未应用"
          : "项目偏好尚未成功读取，本次修改未写入",
        "warning",
        5000,
      );
    }
    return ready;
  }

  let projectPrefsSaveRevision = 0;
  let projectPrefsSaveActive = false;
  let projectPrefsPendingSave = null;

  function saveProjectPrefs() {
    if (state.projectPrefsStatus !== "ready") return Promise.resolve(false);
    const desired = projectPrefsSnapshot();
    const revision = ++projectPrefsSaveRevision;
    const result = new Promise((resolveSave) => {
      if (projectPrefsPendingSave) {
        projectPrefsPendingSave.desired = desired;
        projectPrefsPendingSave.revision = revision;
        projectPrefsPendingSave.waiters.push(resolveSave);
      } else {
        projectPrefsPendingSave = {
          baseSnapshot: projectPrefsSnapshot(projectPrefsAuthoritative),
          desired,
          revision,
          waiters: [resolveSave],
        };
      }
    });
    queueMicrotask(() => void drainProjectPrefsSaves());
    return result;
  }

  async function drainProjectPrefsSaves() {
    if (projectPrefsSaveActive || state.projectPrefsStatus !== "ready") return;
    projectPrefsSaveActive = true;
    try {
      while (projectPrefsPendingSave) {
        const operation = projectPrefsPendingSave;
        projectPrefsPendingSave = null;
        let saved = false;
        let stop = false;
        let deferred = false;
        let conflictRetries = 0;
        while (!saved && !stop) {
          try {
            const desired = rebaseProjectPrefsOperation(operation, projectPrefsAuthoritative);
            const authoritative = setProjectPrefsAuthoritative(await request("/api/projects/prefs", {
              method: "PUT",
              body: { baseRevision: projectPrefsAuthoritative.revision, ...desired },
            }));
            if (projectPrefsPendingSave) {
              const optimistic = rebaseProjectPrefsOperation(projectPrefsPendingSave, authoritative);
              state.projectPrefs = { revision: authoritative.revision, ...optimistic };
            } else {
              state.projectPrefs = cloneProjectPrefs(authoritative);
            }
            renderProjects();
            saved = true;
          } catch (error) {
            const conflict = error.status === 409 && error.payload?.error?.code === "PREFS_REVISION_MISMATCH";
            if (conflict && conflictRetries < 3) {
              conflictRetries += 1;
              toast("项目偏好已被其它页面更新，正在合并本地修改", "warning", 5000);
              try {
                const authoritative = setProjectPrefsAuthoritative(await request("/api/projects/prefs"));
                state.projectPrefsStatus = "ready";
                state.projectPrefsError = null;
                const currentDesired = rebaseProjectPrefsOperation(operation, authoritative);
                const optimistic = projectPrefsPendingSave
                  ? rebaseProjectPrefsOperation(projectPrefsPendingSave, currentDesired)
                  : currentDesired;
                state.projectPrefs = { revision: authoritative.revision, ...optimistic };
                renderProjects();
                continue;
              } catch (refreshError) {
                projectPrefsPendingSave = mergeProjectPrefsOperations(operation, projectPrefsPendingSave);
                state.projectPrefs = {
                  revision: projectPrefsAuthoritative.revision,
                  ...projectPrefsSnapshot(projectPrefsPendingSave.desired),
                };
                state.projectPrefsStatus = "error";
                state.projectPrefsError = refreshError.message;
                deferred = true;
                renderProjects();
                renderStatusline();
                toast(`项目偏好权威回读失败；本地修改已保留，写入已锁定：${refreshError.message}`, "error", 7000);
                stop = true;
                continue;
              }
            }
            toast(
              conflict ? "项目偏好连续发生版本冲突，本次修改未保存" : `项目偏好保存失败：${error.message}`,
              "error",
            );
            try {
              setProjectPrefsAuthoritative(await request("/api/projects/prefs"), { adopt: true });
              state.projectPrefsStatus = "ready";
              state.projectPrefsError = null;
              renderProjects();
            } catch (refreshError) {
              projectPrefsPendingSave = mergeProjectPrefsOperations(operation, projectPrefsPendingSave);
              state.projectPrefs = {
                revision: projectPrefsAuthoritative.revision,
                ...projectPrefsSnapshot(projectPrefsPendingSave.desired),
              };
              state.projectPrefsStatus = "error";
              state.projectPrefsError = refreshError.message;
              deferred = true;
              renderProjects();
              renderStatusline();
              toast(`项目偏好权威回读失败；本地修改已保留，写入已锁定：${refreshError.message}`, "error", 7000);
            }
            stop = true;
          }
        }
        if (!deferred) for (const settle of operation.waiters) settle(saved);
        if (stop && projectPrefsPendingSave && !deferred) {
          for (const settle of projectPrefsPendingSave.waiters) settle(false);
          projectPrefsPendingSave = null;
        }
        if (stop) break;
      }
    } finally {
      projectPrefsSaveActive = false;
      if (projectPrefsPendingSave && state.projectPrefsStatus === "ready") queueMicrotask(() => void drainProjectPrefsSaves());
    }
  }

  return {
    loadProjectPrefs,
    ensureProjectPrefsWritable,
    saveProjectPrefs,
    getPendingSave: () => projectPrefsPendingSave,
  };
}
