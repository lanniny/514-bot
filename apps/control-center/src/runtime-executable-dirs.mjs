/**
 * Non-PATH install locations for 514cc-managed CLIs.
 * Explorer-launched processes often keep a stale User PATH; adapters already
 * fall back to these dirs, but interactive PTY shells do not unless PATH is
 * synthesized here. Only directories that actually exist are returned.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export function runtimeExecutableDirCandidates(env = process.env) {
  const home = String(env.USERPROFILE || env.HOME || "").trim();
  if (!home) return [];
  return [
    join(home, ".grok", "bin"),
    join(home, ".kimi-code", "bin"),
  ];
}

export function runtimeExecutableDirs(env = process.env, { exists = existsSync } = {}) {
  return runtimeExecutableDirCandidates(env).filter((dir) => {
    try {
      return exists(dir);
    } catch {
      return false;
    }
  });
}

function pathKey(env = {}) {
  if (Object.prototype.hasOwnProperty.call(env, "PATH")) return "PATH";
  if (Object.prototype.hasOwnProperty.call(env, "Path")) return "Path";
  return "PATH";
}

/** Plain `{...process.env}` copies lose Windows' case-insensitive lookup. */
export function envLookup(env, name) {
  if (!env) return "";
  if (env[name]) return String(env[name]);
  const needle = String(name).toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === needle && env[key]) return String(env[key]);
  }
  return "";
}

function splitPath(value) {
  return String(value || "").split(delimiter).map((item) => item.trim()).filter(Boolean);
}

/**
 * Return a shallow-copied env whose PATH includes existing runtime dirs.
 * Case-insensitive dedupe; extra dirs are prepended so stale PATH still finds grok/kimi.
 */
export function withRuntimeExecutablePath(env = process.env, options = {}) {
  const dirs = runtimeExecutableDirs(env, options);
  if (!dirs.length) return env;
  const key = pathKey(env);
  const current = splitPath(env[key] || env.PATH || env.Path || "");
  const seen = new Set(current.map((item) => item.toLowerCase()));
  const extra = [];
  for (const dir of dirs) {
    const id = dir.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    extra.push(dir);
  }
  if (!extra.length) return env;
  const next = { ...env, [key]: [...extra, ...current].join(delimiter) };
  const comspec = envLookup(env, "COMSPEC");
  if (comspec) {
    next.COMSPEC = comspec;
    next.ComSpec = comspec;
  }
  const pathext = envLookup(env, "PATHEXT");
  if (pathext) next.PATHEXT = pathext;
  return next;
}
