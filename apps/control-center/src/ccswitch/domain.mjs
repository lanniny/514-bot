import { createHash, createHmac, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import JSON5 from "json5";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { checkReachability, parseDeeplink as parseProviderDeeplink } from "../provider-net.mjs";
import { PROVIDER_APPS, PROVIDER_SCHEME_APPS } from "../providers.mjs";
import { CCSWITCH_ENVIRONMENT_WATCH, createEnvironmentAdapter } from "./environment.mjs";
import { renameWithRetry } from "../atomic-rename.mjs";
import { hasPendingSkillPublication, resolveSkillTarget, SkillPublication } from "./skill-publication.mjs";
import { SkillRecovery } from "./skill-recovery.mjs";
import { skillDigest, skillStateProof } from "./skill-recovery-proof.mjs";

const STATE_VERSION = 1;
const MAX_TEXT = 1024 * 1024;
const MAX_DEEPLINK = 64 * 1024;
// kimi 无官方全局 Prompt 文件（文档只声明项目级 AGENTS.md 与 ~/.kimi-code/skills/），
// Prompt 面不收录；Skill 面保留——官方用户级技能目录即 ~/.kimi-code/skills（#skillTarget 天然吻合）。
const PROMPT_APPS = Object.freeze(PROVIDER_APPS.filter((app) => app !== "claude-desktop" && app !== "kimi"));
const SKILL_APPS = Object.freeze(PROVIDER_APPS.filter((app) => app !== "claude-desktop"));
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const LOOPBACKS = new Set(["localhost", "127.0.0.1", "::1"]);
const OPENCLAW_WORKSPACE_FILES = Object.freeze(["AGENTS.md", "SOUL.md", "USER.md", "IDENTITY.md", "TOOLS.md", "MEMORY.md", "HEARTBEAT.md", "BOOTSTRAP.md", "BOOT.md"]);
const DAILY_MEMORY_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/;
const HERMES_MEMORY_FILES = Object.freeze({ memory: "MEMORY.md", user: "USER.md" });

function fail(message, code = "CCSWITCH_DOMAIN_ERROR", httpStatus = 400) {
  throw Object.assign(new Error(message), { code, httpStatus });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function stamp() {
  return now().replace(/[:.]/g, "").replace("T", "-").slice(0, 15);
}

function cleanText(value, label, max = 300, { required = false } = {}) {
  const text = String(value ?? "").trim();
  if (required && !text) fail(`${label} is required`, "VALIDATION_FAILED");
  if (text.length > max) fail(`${label} exceeds ${max} characters`, "VALIDATION_FAILED");
  return text;
}

function cleanId(value, label = "id") {
  const id = cleanText(value, label, 96, { required: true });
  if (!ID_PATTERN.test(id)) fail(`${label} contains unsupported characters`, "VALIDATION_FAILED");
  return id;
}

function cleanApp(value, allowed = PROVIDER_APPS) {
  const app = cleanText(value, "app", 40, { required: true });
  if (!allowed.includes(app)) fail(`unsupported app: ${app}`, "VALIDATION_FAILED");
  return app;
}

function uniqueApps(value, allowed = PROVIDER_APPS) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  const output = [];
  for (const item of list) {
    const app = cleanApp(item, allowed);
    if (!output.includes(app)) output.push(app);
  }
  if (!output.length) fail("at least one app is required", "VALIDATION_FAILED");
  return output;
}

function safeRelative(value, label = "path") {
  const path = String(value ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!path || path.includes("\0") || path.split("/").some((part) => part === "..")) {
    fail(`${label} must be a safe relative path`, "VALIDATION_FAILED");
  }
  return path;
}

function assertInside(root, target, label = "path") {
  const base = resolve(root);
  const candidate = resolve(target);
  if (candidate !== base && !candidate.startsWith(`${base}${sep}`)) {
    fail(`${label} escapes its allowed root`, "PATH_FORBIDDEN", 403);
  }
  return candidate;
}

function ensureHttpUrl(value, label, { allowEmpty = false } = {}) {
  const text = cleanText(value, label, 2048, { required: !allowEmpty });
  if (!text && allowEmpty) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    fail(`${label} must be a valid URL`, "VALIDATION_FAILED");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACKS.has(url.hostname))) {
    fail(`${label} must use https (http is allowed only for loopback tests)`, "URL_FORBIDDEN", 403);
  }
  if (url.username || url.password) fail(`${label} must not embed credentials`, "URL_FORBIDDEN", 403);
  return url.href;
}

function mask(value) {
  const text = String(value ?? "");
  if (!text) return null;
  return text.length > 4 ? `••••${text.slice(-4)}` : "••••";
}

function appMap(factory) {
  return Object.fromEntries(PROVIDER_APPS.map((app) => [app, factory(app)]));
}

function defaultState() {
  return {
    version: STATE_VERSION,
    prompts: appMap(() => ({})),
    mcps: {},
    skills: {},
    profiles: {},
    currentProfile: appMap(() => null),
    settings: {
      configDirs: appMap(() => null),
      streamCheck: { timeoutMs: 10_000, degradedMs: 3_000, concurrency: 4 },
      webdav: null,
      s3: null,
    },
    envBackups: {},
  };
}

function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("ccswitch-domain.json must contain an object", "DOMAIN_STORE_CORRUPT", 503);
  if (Number(raw.version ?? STATE_VERSION) !== STATE_VERSION) fail(`unsupported domain store version: ${raw.version}`, "DOMAIN_STORE_VERSION", 503);
  for (const app of PROVIDER_APPS) {
    base.prompts[app] = raw.prompts?.[app] && typeof raw.prompts[app] === "object" && !Array.isArray(raw.prompts[app]) ? raw.prompts[app] : {};
    base.currentProfile[app] = typeof raw.currentProfile?.[app] === "string" ? raw.currentProfile[app] : null;
    const configured = raw.settings?.configDirs?.[app];
    base.settings.configDirs[app] = typeof configured === "string" && configured ? configured : null;
  }
  for (const key of ["mcps", "skills", "profiles", "envBackups"]) {
    if (raw[key] && typeof raw[key] === "object" && !Array.isArray(raw[key])) base[key] = raw[key];
  }
  if (raw.settings?.streamCheck && typeof raw.settings.streamCheck === "object") {
    base.settings.streamCheck = { ...base.settings.streamCheck, ...raw.settings.streamCheck };
  }
  if (raw.settings?.webdav && typeof raw.settings.webdav === "object") base.settings.webdav = raw.settings.webdav;
  if (raw.settings?.s3 && typeof raw.settings.s3 === "object") base.settings.s3 = raw.settings.s3;
  return base;
}

async function atomicWrite(target, content, mode = 0o600) {
  await mkdir(dirname(target), { recursive: true });
  const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, content, { encoding: "utf8", mode });
    await renameWithRetry(temp, target);
  } finally { await rm(temp, { force: true }).catch(() => {}); }
}

async function readObject(target, { json5 = false, yaml = false } = {}) {
  try {
    const text = await readFile(target, "utf8");
    if (!text.trim()) return {};
    const parsed = yaml ? parseYaml(text) : json5 ? JSON5.parse(text) : JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(`${target} must contain an object`, "LIVE_CONFIG_INVALID");
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlValue(value) {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  return tomlString(value);
}

function spliceManagedBlock(original, kind, id, body = "") {
  const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = `# >>> 514-forge-${kind} (${id}) >>>`;
  const end = `# <<< 514-forge-${kind} (${id}) <<<`;
  const pattern = new RegExp(`(?:^|\\n)${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\n|$)`, "g");
  const kept = String(original ?? "").replace(pattern, "\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  if (!body) return kept ? `${kept}\n` : "";
  const block = `${start}\n${body.trim()}\n${end}`;
  return `${kept ? `${kept}\n\n` : ""}${block}\n`;
}

function mcpToml(id, config) {
  const lines = [`[mcp_servers.${tomlString(id)}]`];
  if (config.command) lines.push(`command = ${tomlString(config.command)}`);
  if (Array.isArray(config.args)) lines.push(`args = ${tomlValue(config.args.map(String))}`);
  if (config.url) lines.push(`url = ${tomlString(config.url)}`);
  if (config.cwd) lines.push(`cwd = ${tomlString(config.cwd)}`);
  if (config.env && typeof config.env === "object" && Object.keys(config.env).length) {
    lines.push("", `[mcp_servers.${tomlString(id)}.env]`);
    for (const [key, value] of Object.entries(config.env)) lines.push(`${tomlString(key)} = ${tomlString(value)}`);
  }
  return lines.join("\n");
}

function parseTomlScalar(raw) {
  let text = String(raw ?? "").trim();
  if (text.startsWith("[")) {
    const end = text.lastIndexOf("]");
    if (end >= 0) text = text.slice(0, end + 1);
    try { return JSON.parse(text.replace(/'/g, "\"")); } catch { return []; }
  }
  if (text.startsWith("\"")) {
    const match = text.match(/^"((?:\\.|[^"\\])*)"/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { return match[1]; }
    }
  }
  text = text.replace(/\s+#.*$/, "");
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function parseTomlAssignments(body) {
  const output = {};
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim().replace(/^["']|["']$/g, "");
    if (!key) continue;
    output[key] = parseTomlScalar(trimmed.slice(eq + 1));
  }
  return output;
}

function parseTomlMcpServers(text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const servers = {};
  const header = /^\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9][A-Za-z0-9._-]*))(\.env)?\][ \t]*$/gm;
  const matches = [...normalized.matchAll(header)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const name = match[1] || match[2] || match[3];
    if (!name) continue;
    const bodyStart = match.index + match[0].length;
    const nextHeader = normalized.slice(bodyStart).search(/\n\[/);
    const body = nextHeader >= 0 ? normalized.slice(bodyStart, bodyStart + nextHeader) : normalized.slice(bodyStart);
    if (!servers[name]) servers[name] = { env: {} };
    const fields = parseTomlAssignments(body);
    if (match[4]) Object.assign(servers[name].env, fields);
    else Object.assign(servers[name], fields);
  }
  return Object.entries(servers).map(([id, config]) => {
    if (config.env && typeof config.env === "object" && !Object.keys(config.env).length) delete config.env;
    return { id, config };
  });
}

function stripTomlMcpTables(original, id) {
  const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const normalized = String(original ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const pattern = new RegExp(`(?:^|\\n)\\[mcp_servers\\.(?:${escaped}|"${escaped}"|'${escaped}')(?:\\.env)?\\][ \\t]*(?:\\n(?!\\[).*)*`, "g");
  return normalized.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function isMaskedSecret(value, original) {
  if (typeof value !== "string" || !value.startsWith("••••")) return false;
  if (original == null || original === "") return value === "••••" || /^••••.{0,4}$/.test(value);
  return value === mask(original);
}

function restoreMaskedSecrets(incoming, existing) {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming) || !existing) return incoming;
  const next = { ...incoming };
  for (const field of ["env", "headers"]) {
    const current = incoming[field];
    const previous = existing[field];
    if (!current || typeof current !== "object" || Array.isArray(current) || !previous || typeof previous !== "object") continue;
    const merged = { ...current };
    for (const [key, value] of Object.entries(merged)) {
      if (isMaskedSecret(value, previous[key]) && previous[key] != null) merged[key] = previous[key];
    }
    next[field] = merged;
  }
  return next;
}

function mcpFingerprint(config) {
  const type = String(config?.type || (config?.url ? "http" : config?.command ? "stdio" : ""));
  return JSON.stringify({
    type,
    command: String(config?.command || ""),
    url: String(config?.url || ""),
    args: Array.isArray(config?.args) ? config.args.map(String) : [],
    cwd: String(config?.cwd || ""),
  });
}

function comparableMcp(config) {
  try { return validateMcpConfig(config); } catch { return config && typeof config === "object" ? config : {}; }
}

function publicLiveMcp(item) {
  const command = item.config?.command ? basename(String(item.config.command)) : "";
  let urlHost = "";
  if (item.config?.url) {
    try { urlHost = new URL(String(item.config.url)).host; } catch { urlHost = "（URL 无法解析）"; }
  }
  return {
    id: item.id,
    name: item.name,
    transport: item.config?.url ? "http" : item.config?.command ? "stdio" : "unknown",
    ...(command ? { command } : {}),
    ...(urlHost ? { urlHost } : {}),
    apps: clone(item.apps),
    sources: (item.sources ?? []).map((source) => ({ app: source.app, scope: source.scope, path: source.path })),
    managed: Boolean(item.managed),
    importable: item.importable !== false,
    ...(item.skipReason ? { skipReason: item.skipReason } : {}),
  };
}

function publicLiveSkill(item) {
  return {
    id: item.id,
    name: item.name,
    apps: clone(item.apps),
    sources: (item.sources ?? []).map((source) => ({ app: source.app, path: source.path })),
    managed: Boolean(item.managed),
    importable: item.importable !== false,
    ...(item.skipReason ? { skipReason: item.skipReason } : {}),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding = undefined) {
  return createHmac("sha256", key).update(value).digest(encoding);
}

function encodeAwsPath(value) {
  return `/${String(value).split("/").filter(Boolean).map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/")}`;
}

function awsDate(date = new Date()) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function validateMcpConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("MCP config must be an object", "VALIDATION_FAILED");
  const type = cleanText(input.type, "MCP type", 16);
  if (type && !["stdio", "http", "sse"].includes(type)) fail("MCP type must be stdio, http, or sse", "VALIDATION_FAILED");
  const command = cleanText(input.command, "MCP command", 500);
  const url = input.url ? ensureHttpUrl(input.url, "MCP URL") : "";
  if (!command && !url) fail("MCP config requires command or url", "VALIDATION_FAILED");
  const cwd = cleanText(input.cwd, "MCP cwd", 500);
  const args = Array.isArray(input.args) ? input.args.map((item) => cleanText(item, "MCP argument", 500)) : [];
  if (args.length > 100) fail("MCP args exceeds 100 entries", "VALIDATION_FAILED");
  const env = {};
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (!ENV_PATTERN.test(key)) fail(`invalid MCP env key: ${key}`, "VALIDATION_FAILED");
    env[key] = cleanText(value, `MCP env ${key}`, 4000);
  }
  const headers = {};
  if (input.headers != null) {
    if (typeof input.headers !== "object" || Array.isArray(input.headers)) fail("MCP headers must be an object", "VALIDATION_FAILED");
    const names = Object.keys(input.headers);
    if (names.length > 40) fail("MCP headers exceeds 40 entries", "VALIDATION_FAILED");
    for (const [key, value] of Object.entries(input.headers)) {
      const header = cleanText(key, "MCP header name", 128, { required: true });
      headers[header] = cleanText(value, `MCP header ${header}`, 4000);
    }
  }
  const envPassthrough = Array.isArray(input.envPassthrough)
    ? input.envPassthrough.map((name) => {
        const key = cleanText(name, "MCP env passthrough", 128, { required: true });
        if (!ENV_PATTERN.test(key)) fail(`invalid MCP env passthrough: ${key}`, "VALIDATION_FAILED");
        return key;
      })
    : [];
  if (envPassthrough.length > 50) fail("MCP envPassthrough exceeds 50 entries", "VALIDATION_FAILED");
  return {
    ...(type ? { type } : {}),
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
    ...(cwd ? { cwd } : {}),
    args,
    env,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(envPassthrough.length ? { envPassthrough } : {}),
  };
}

function publicState(state, storeStatus) {
  const output = clone(state);
  for (const item of Object.values(output.mcps)) {
    for (const [key, value] of Object.entries(item.config?.env ?? {})) {
      if (/(?:key|token|secret|password|credential)/i.test(key)) item.config.env[key] = mask(value);
    }
    for (const [key, value] of Object.entries(item.config?.headers ?? {})) {
      if (/(?:key|token|secret|password|credential|authorization)/i.test(key)) item.config.headers[key] = mask(value);
    }
  }
  if (output.settings.webdav) {
    output.settings.webdav.hasPassword = Boolean(output.settings.webdav.password);
    output.settings.webdav.passwordMasked = mask(output.settings.webdav.password);
    delete output.settings.webdav.password;
  }
  if (output.settings.s3) {
    output.settings.s3.hasSecretAccessKey = Boolean(output.settings.s3.secretAccessKey);
    output.settings.s3.secretAccessKeyMasked = mask(output.settings.s3.secretAccessKey);
    delete output.settings.s3.secretAccessKey;
    if (output.settings.s3.sessionToken) output.settings.s3.sessionToken = mask(output.settings.s3.sessionToken);
  }
  for (const backup of Object.values(output.envBackups)) {
    for (const item of backup.items ?? []) item.value = mask(item.value);
  }
  output.storeStatus = { ...storeStatus };
  return output;
}

export class CcSwitchDomainService {
  constructor({ dataRoot, providerStore, eventStore = null, runtimeHome = null, fetchImpl = globalThis.fetch, envAdapter = null, authService = null } = {}) {
    if (!dataRoot || !providerStore) fail("dataRoot and providerStore are required", "CCSWITCH_INIT_FAILED", 500);
    this.dataRoot = dataRoot;
    this.providerStore = providerStore;
    this.eventStore = eventStore;
    this.runtimeHome = runtimeHome || providerStore.runtimeHome || process.env.CONTROL_CENTER_RUNTIME_HOME || homedir();
    this.fetchImpl = fetchImpl;
    this.authService = authService;
    this.envAdapter = envAdapter ?? createEnvironmentAdapter();
    this.path = join(dataRoot, "ccswitch-domain.json");
    this.backupDir = join(dataRoot, "backups", "ccswitch");
    this.skillRoot = join(dataRoot, "ccswitch", "skills");
    this.skillJournalRoot = join(dataRoot, "ccswitch", "skill-transactions");
    this.state = defaultState();
    this.storeStatus = { state: "missing", code: null, message: null };
    this.queue = Promise.resolve();
    this.skillRecovery = new SkillRecovery({
      journalRoot: this.skillJournalRoot, backupRoot: join(dataRoot, "backups", "skills"), statePath: this.path,
      roots: (state) => [this.skillRoot, ...SKILL_APPS.map((app) => join(this.#configDir(app, state), "skills"))],
      validateState: (raw) => raw === null ? defaultState() : normalizeState(raw),
    });
  }

  async init() {
    try {
      this.state = normalizeState(JSON.parse(await readFile(this.path, "utf8")));
      this.storeStatus = { state: "ready", code: null, message: null };
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.storeStatus = { state: "missing", code: null, message: null };
      } else {
        this.storeStatus = { state: "blocked", code: error?.code || "DOMAIN_STORE_UNREADABLE", message: String(error?.message || error).slice(0, 300) };
      }
    }
    try {
      if (await hasPendingSkillPublication(this.skillJournalRoot)) this.#blockSkillRecovery();
    } catch { this.#blockSkillRecovery(); }
    return this;
  }

  #assertWritable() {
    if (this.storeStatus.state === "blocked") fail(`CC-Switch domain store is blocked: ${this.storeStatus.message}`, this.storeStatus.code, 503);
  }

  #serialize(task) {
    const guarded = async () => {
      this.#assertWritable();
      return task();
    };
    return this.#enqueue(guarded);
  }

  #enqueue(task) {
    const pending = this.queue.then(task, task);
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  skillRecoverySummary() { return this.skillRecovery.summary(); }

  checkSkillRecovery(id) {
    return this.#enqueue(() => this.skillRecovery.check(id));
  }

  confirmSkillRecovery(id, input) {
    return this.#enqueue(async () => {
      const result = await this.skillRecovery.confirm(id, input);
      this.#blockSkillRecovery();
      this.state = result.normalized;
      const recovery = await this.skillRecovery.summary();
      if (!recovery.unavailable && !recovery.items.length) this.storeStatus = { state: result.stateExists ? "ready" : "missing", code: null, message: null };
      await this.#audit("ccswitch.skill_recovery_confirmed", { id, outcome: result.outcome, mode: "record-only" });
      return { id, outcome: result.outcome, unlocked: this.storeStatus.state !== "blocked", recovery };
    });
  }

  async #commit(state = this.state) {
    this.#assertWritable();
    await atomicWrite(this.path, `${JSON.stringify(state, null, 2)}\n`);
    this.state = state;
    this.storeStatus = { state: "ready", code: null, message: null };
  }

  #blockSkillRecovery() {
    this.storeStatus = { state: "blocked", code: "SKILL_TRANSACTION_RECOVERY_REQUIRED", message: "An interrupted skill publication requires recovery; files and backups were retained." };
  }

  async #publishSkills(skills, changes, { canonicalId = null, skillId = canonicalId } = {}) {
    this.#assertWritable();
    const key = (path) => process.platform === "win32" ? path.toLowerCase() : path;
    const canonical = await Promise.all(Object.entries(skills).map(async ([id, item]) => [id, key(await resolveSkillTarget(assertInside(this.skillRoot, item.path, "skill source")))]));
    const liveClaims = new Map();
    for (const [id, item] of Object.entries(skills)) for (const app of SKILL_APPS) if (item.apps?.[app]) {
      const target = key(await resolveSkillTarget(this.#skillTarget(app, item.name)));
      const owner = liveClaims.get(target);
      if (owner && owner !== id) fail("different skills share an active app directory", "SKILL_TARGET_CONFLICT", 409);
      for (const other of liveClaims.keys()) if (target !== other && (target.startsWith(other + sep) || other.startsWith(target + sep))) fail("active skill directories overlap", "SKILL_TARGET_CONFLICT", 409);
      liveClaims.set(target, id);
    }
    const selected = [];
    for (const change of changes) {
      const target = key(await resolveSkillTarget(change.target));
      for (const live of liveClaims.keys()) if (target !== live && (target.startsWith(live + sep) || live.startsWith(target + sep))) fail("skill change overlaps another active directory", "SKILL_TARGET_CONFLICT", 409);
      const owner = liveClaims.get(target);
      if (owner && (change.source === null || owner !== skillId)) fail("skill directory is still required by an active app", "SKILL_TARGET_CONFLICT", 409);
      if (change.source && target === key(await resolveSkillTarget(change.source))) continue;
      for (const [id, source] of canonical) {
        if (target === source && id === canonicalId && change.source !== null) continue;
        if (target === source || target.startsWith(source + sep) || source.startsWith(target + sep)) fail("skill destination overlaps a canonical skill", "SKILL_TARGET_CONFLICT", 409);
      }
      selected.push(change);
    }
    const nextState = { ...this.state, skills };
    const before = await skillStateProof(this.path).then((proof) => proof.digest, () => null);
    const publication = new SkillPublication({ journalRoot: this.skillJournalRoot, backupRoot: join(this.dataRoot, "backups", "skills"), stateProof: { before, after: skillDigest(`${JSON.stringify(nextState, null, 2)}\n`) } });
    try {
      const result = await publication.publish(selected, () => this.#commit(nextState));
      if (result.recoveryRequired) this.#blockSkillRecovery();
      return result;
    } catch (error) {
      if (error.code === "SKILL_TRANSACTION_RECOVERY_REQUIRED") this.#blockSkillRecovery();
      throw error;
    }
  }

  async #audit(type, detail) {
    await this.eventStore?.emit(type, detail, { sensitivity: "internal", agentId: "control-plane" }).catch(() => {});
  }

  summary() {
    return publicState(this.state, this.storeStatus);
  }

  #configDir(app, state = this.state) {
    const override = state.settings.configDirs[app];
    if (override) return override;
    const defaults = {
      claude: join(this.runtimeHome, ".claude"),
      "claude-desktop": process.platform === "win32"
        ? join(this.runtimeHome, "AppData", "Roaming", "Claude")
        : join(this.runtimeHome, ".config", "Claude"),
      codex: join(this.runtimeHome, ".codex"),
      gemini: join(this.runtimeHome, ".gemini"),
      grokbuild: join(this.runtimeHome, ".grok"),
      kimi: join(this.runtimeHome, ".kimi-code"),
      opencode: join(this.runtimeHome, ".config", "opencode"),
      openclaw: join(this.runtimeHome, ".openclaw"),
      hermes: process.platform === "win32" && this.runtimeHome === homedir() && process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, "hermes")
        : join(this.runtimeHome, ".hermes"),
    };
    return defaults[app];
  }

  configPaths() {
    return Object.fromEntries(PROVIDER_APPS.map((app) => [app, this.#configDir(app)]));
  }

  setConfigDir(appValue, pathValue) {
    const app = cleanApp(appValue);
    const path = cleanText(pathValue, "config directory", 2048);
    if (path && !isAbsolute(path)) fail("config directory override must be absolute", "VALIDATION_FAILED");
    return this.#serialize(async () => {
      this.state.settings.configDirs[app] = path || null;
      await this.#commit();
      await this.#audit("ccswitch.config_dir_updated", { app, configured: Boolean(path) });
      return { app, path: this.#configDir(app), overridden: Boolean(path) };
    });
  }

  #promptPath(app) {
    cleanApp(app, PROMPT_APPS);
    const names = { claude: "CLAUDE.md", codex: "AGENTS.md", gemini: "GEMINI.md", grokbuild: "AGENTS.md", opencode: "AGENTS.md", openclaw: "AGENTS.md", hermes: "AGENTS.md" };
    return join(this.#configDir(app), names[app]);
  }

  prompts(appValue) {
    const app = cleanApp(appValue, PROMPT_APPS);
    return Object.values(this.state.prompts[app]).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  upsertPrompt(appValue, input = {}) {
    const app = cleanApp(appValue, PROMPT_APPS);
    const id = input.id ? cleanId(input.id, "prompt id") : `prompt-${randomUUID()}`;
    const existing = this.state.prompts[app][id] ?? null;
    const name = cleanText(input.name ?? existing?.name, "prompt name", 120, { required: true });
    const content = String(input.content ?? existing?.content ?? "");
    if (Buffer.byteLength(content) > MAX_TEXT) fail("prompt content exceeds 1 MiB", "VALIDATION_FAILED", 413);
    const description = cleanText(input.description ?? existing?.description, "prompt description", 1000);
    return this.#serialize(async () => {
      const item = { id, name, content, description, enabled: Boolean(existing?.enabled), createdAt: existing?.createdAt || now(), updatedAt: now() };
      this.state.prompts[app][id] = item;
      if (input.enabled === false && existing?.enabled) await this.#disablePromptUnlocked(app, id);
      else if (input.enabled === true && !existing?.enabled) await this.#enablePromptUnlocked(app, id);
      else if (input.enabled === true || item.enabled) {
        await this.#backupLive(this.#promptPath(app), "prompts");
        for (const candidate of Object.values(this.state.prompts[app])) candidate.enabled = candidate.id === id;
        await atomicWrite(this.#promptPath(app), item.content);
      }
      await this.#commit();
      await this.#audit("ccswitch.prompt_upserted", { app, id, enabled: this.state.prompts[app][id].enabled });
      return clone(this.state.prompts[app][id]);
    });
  }

  async #backupLive(target, category) {
    try {
      const content = await readFile(target);
      const backup = join(this.dataRoot, "backups", category, stamp(), relative(this.runtimeHome, target).replace(/^\.\.[/\\]/, "external-").replace(/[:]/g, "_"));
      await mkdir(dirname(backup), { recursive: true });
      await writeFile(backup, content, { mode: 0o600 });
      return backup;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async #enablePromptUnlocked(app, id) {
    const prompt = this.state.prompts[app][id];
    if (!prompt) fail(`prompt not found: ${id}`, "SOURCE_NOT_FOUND", 404);
    const target = this.#promptPath(app);
    let live = "";
    try {
      live = await readFile(target, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (live.trim()) {
      const active = Object.values(this.state.prompts[app]).find((item) => item.enabled);
      if (active) {
        active.content = live;
        active.updatedAt = now();
      } else if (!Object.values(this.state.prompts[app]).some((item) => item.content.trim() === live.trim())) {
        const backupId = `backup-${Date.now()}`;
        this.state.prompts[app][backupId] = { id: backupId, name: `原始提示词 ${now().slice(0, 16).replace("T", " ")}`, content: live, description: "启用前自动备份", enabled: false, createdAt: now(), updatedAt: now() };
      }
    }
    await this.#backupLive(target, "prompts");
    for (const item of Object.values(this.state.prompts[app])) item.enabled = item.id === id;
    await atomicWrite(target, prompt.content);
    return prompt;
  }

  enablePrompt(appValue, idValue) {
    const app = cleanApp(appValue, PROMPT_APPS);
    const id = cleanId(idValue, "prompt id");
    return this.#serialize(async () => {
      const prompt = await this.#enablePromptUnlocked(app, id);
      await this.#commit();
      await this.#audit("ccswitch.prompt_enabled", { app, id });
      return clone(prompt);
    });
  }

  async #disablePromptUnlocked(app, id) {
    const prompt = this.state.prompts[app][id];
    if (!prompt) fail(`prompt not found: ${id}`, "SOURCE_NOT_FOUND", 404);
    prompt.enabled = false;
    if (!Object.values(this.state.prompts[app]).some((item) => item.enabled)) {
      const target = this.#promptPath(app);
      await this.#backupLive(target, "prompts");
      await atomicWrite(target, "");
    }
    return prompt;
  }

  disablePrompt(appValue, idValue) {
    const app = cleanApp(appValue, PROMPT_APPS);
    const id = cleanId(idValue, "prompt id");
    return this.#serialize(async () => {
      const item = await this.#disablePromptUnlocked(app, id);
      await this.#commit();
      return clone(item);
    });
  }

  deletePrompt(appValue, idValue) {
    const app = cleanApp(appValue, PROMPT_APPS);
    const id = cleanId(idValue, "prompt id");
    return this.#serialize(async () => {
      const prompt = this.state.prompts[app][id];
      if (!prompt) fail(`prompt not found: ${id}`, "SOURCE_NOT_FOUND", 404);
      if (prompt.enabled) fail("enabled prompt cannot be deleted", "PROMPT_ACTIVE", 409);
      delete this.state.prompts[app][id];
      await this.#commit();
      return { removed: id };
    });
  }

  async currentPromptContent(appValue) {
    const app = cleanApp(appValue, PROMPT_APPS);
    try {
      return { app, path: this.#promptPath(app), content: await readFile(this.#promptPath(app), "utf8") };
    } catch (error) {
      if (error?.code === "ENOENT") return { app, path: this.#promptPath(app), content: null };
      throw error;
    }
  }

  async importPromptFromFile(appValue) {
    const app = cleanApp(appValue, PROMPT_APPS);
    const current = await this.currentPromptContent(app);
    if (current.content === null) fail("prompt file does not exist", "SOURCE_NOT_FOUND", 404);
    return this.upsertPrompt(app, { name: `导入的提示词 ${now().slice(0, 16).replace("T", " ")}`, description: "从现有 live 文件导入", content: current.content });
  }

  mcps() {
    return Object.values(this.state.mcps).sort((a, b) => a.name.localeCompare(b.name));
  }

  async #readLiveMcpEntries(app) {
    try {
      const target = this.#mcpPath(app);
      if (["codex", "grokbuild"].includes(app)) {
        let text = "";
        try { text = await readFile(target, "utf8"); } catch (error) {
          if (error?.code === "ENOENT") return [];
          throw error;
        }
        return parseTomlMcpServers(text).map((item) => ({ ...item, app, path: target, scope: "global" }));
      }
      const document = await readObject(target, { yaml: app === "hermes", json5: app === "opencode" });
      const key = app === "opencode" ? "mcp" : app === "hermes" ? "mcp_servers" : "mcpServers";
      const servers = document[key];
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
      const entries = Object.entries(servers).map(([id, config]) => ({ id, config, app, path: target, scope: "global" }));
      if (app === "claude" && document.projects && typeof document.projects === "object") {
        for (const [project, projectEntry] of Object.entries(document.projects)) {
          const projectServers = projectEntry?.mcpServers;
          if (!projectServers || typeof projectServers !== "object") continue;
          for (const [id, config] of Object.entries(projectServers)) {
            entries.push({ id, config, app, path: target, scope: "project", project });
          }
        }
      }
      if (app === "claude") {
        const settingsPath = join(this.#configDir("claude"), "settings.json");
        const settings = await readObject(settingsPath);
        for (const [id, config] of Object.entries(settings.mcpServers ?? {})) {
          entries.push({ id, config, app, path: settingsPath, scope: "settings" });
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  async observeLiveMcps() {
    const byId = new Map();
    for (const app of PROVIDER_APPS) {
      const entries = await this.#readLiveMcpEntries(app);
      for (const entry of entries) {
        const id = String(entry.id ?? "").trim();
        if (!id) continue;
        const existing = byId.get(id) ?? {
          id,
          name: id,
          config: null,
          apps: appMap(() => false),
          sources: [],
          managed: Boolean(this.state.mcps[id]),
          importable: true,
          skipReason: "",
        };
        existing.sources.push({ app: entry.app, path: entry.path, scope: entry.scope, project: entry.project || "" });
        const liveConfig = entry.config && typeof entry.config === "object" ? clone(entry.config) : {};
        if (entry.scope !== "project") {
          if (!existing.config) {
            existing.config = liveConfig;
            existing.apps[app] = true;
            if (existing.skipReason.startsWith("项目级")) {
              existing.importable = ID_PATTERN.test(id);
              existing.skipReason = existing.importable ? "" : "id 含不支持的字符";
            }
          } else if (mcpFingerprint(comparableMcp(liveConfig)) === mcpFingerprint(comparableMcp(existing.config))) {
            existing.apps[app] = true;
          }
        }
        if (!ID_PATTERN.test(id)) {
          existing.importable = false;
          existing.skipReason = existing.skipReason || "id 含不支持的字符";
        } else if (entry.scope === "project" && !existing.config) {
          existing.importable = false;
          existing.skipReason = existing.skipReason || "项目级 MCP 不自动导入全局账本";
        } else if (existing.importable && existing.config && !existing.validated) {
          try {
            existing.config = validateMcpConfig(existing.config);
            existing.validated = true;
          } catch (error) {
            existing.importable = false;
            existing.skipReason = error?.message || "MCP 配置无法校验";
          }
        }
        byId.set(id, existing);
      }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  adoptLiveMcps(input = {}) {
    const requested = Array.isArray(input.ids) ? input.ids.map((id) => String(id).trim()).filter(Boolean) : null;
    return this.#serialize(async () => {
      const observed = await this.observeLiveMcps();
      const imported = [];
      const skipped = [];
      for (const item of observed) {
        if (requested && !requested.includes(item.id)) continue;
        if (this.state.mcps[item.id]) {
          skipped.push({ id: item.id, reason: "already-managed" });
          continue;
        }
        if (!item.importable || !item.config) {
          skipped.push({ id: item.id, reason: item.skipReason || "not-importable" });
          continue;
        }
        try {
          const config = validateMcpConfig(item.config);
          this.state.mcps[item.id] = {
            id: item.id,
            name: item.name,
            description: "从本机 live 配置导入",
            config,
            apps: item.apps,
            source: "live-import",
            createdAt: now(),
            updatedAt: now(),
          };
          imported.push(item.id);
        } catch (error) {
          skipped.push({ id: item.id, reason: error?.message || "invalid" });
        }
      }
      if (imported.length) await this.#commit();
      await this.#audit("ccswitch.mcp_adopted", { imported, skipped: skipped.length });
      return { imported, skipped, observed: observed.length };
    });
  }

  async observeLiveResources() {
    const [mcps, skills] = await Promise.all([this.observeLiveMcps(), this.observeLiveSkills()]);
    return {
      mcps: mcps.map((item) => publicLiveMcp(item)),
      skills: skills.map((item) => publicLiveSkill(item)),
    };
  }

  upsertMcp(input = {}) {
    const id = input.id ? cleanId(input.id, "MCP id") : `mcp-${randomUUID()}`;
    const existing = this.state.mcps[id] ?? null;
    const name = cleanText(input.name ?? existing?.name, "MCP name", 120, { required: true });
    const config = validateMcpConfig(restoreMaskedSecrets(input.config ?? existing?.config, existing?.config));
    const apps = appMap((app) => Boolean(input.apps?.[app] ?? existing?.apps?.[app]));
    return this.#serialize(async () => {
      this.state.mcps[id] = { id, name, description: cleanText(input.description ?? existing?.description, "MCP description", 1000), config, apps, createdAt: existing?.createdAt || now(), updatedAt: now() };
      for (const app of PROVIDER_APPS) {
        if (!(input.apps && Object.prototype.hasOwnProperty.call(input.apps, app))) continue;
        const enabled = apps[app];
        const wasEnabled = Boolean(existing?.apps?.[app]);
        if (!enabled && !wasEnabled) continue;
        await this.#materializeMcp(app, id, enabled);
      }
      await this.#commit();
      await this.#audit("ccswitch.mcp_upserted", { id, apps: Object.entries(apps).filter(([, enabled]) => enabled).map(([app]) => app) });
      return clone(this.state.mcps[id]);
    });
  }

  #mcpPath(app) {
    const paths = {
      claude: join(this.runtimeHome, ".claude.json"),
      "claude-desktop": join(this.#configDir(app), "claude_desktop_config.json"),
      codex: join(this.#configDir(app), "config.toml"),
      gemini: join(this.#configDir(app), "settings.json"),
      grokbuild: join(this.#configDir(app), "config.toml"),
      kimi: join(this.#configDir(app), "mcp.json"),
      opencode: join(this.#configDir(app), "opencode.json"),
      openclaw: join(this.#configDir(app), "openclaw.json"),
      hermes: join(this.#configDir(app), "config.yaml"),
    };
    return paths[app];
  }

  async #materializeMcp(app, id, enabled) {
    const item = this.state.mcps[id];
    if (!item) fail(`MCP not found: ${id}`, "SOURCE_NOT_FOUND", 404);
    const target = this.#mcpPath(app);
    await this.#backupLive(target, "mcp");
    if (["codex", "grokbuild"].includes(app)) {
      let original = "";
      try { original = await readFile(target, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      original = spliceManagedBlock(original, "mcp", id, "");
      original = stripTomlMcpTables(original, id);
      await atomicWrite(target, spliceManagedBlock(original, "mcp", id, enabled ? mcpToml(id, item.config) : ""));
      return;
    }
    if (app === "hermes") {
      const document = await readObject(target, { yaml: true });
      document.mcp_servers = document.mcp_servers && typeof document.mcp_servers === "object" ? document.mcp_servers : {};
      if (enabled) document.mcp_servers[id] = clone(item.config); else delete document.mcp_servers[id];
      await atomicWrite(target, stringifyYaml(document));
      return;
    }
    const document = await readObject(target, { json5: app === "opencode" });
    const key = app === "opencode" ? "mcp" : "mcpServers";
    document[key] = document[key] && typeof document[key] === "object" ? document[key] : {};
    if (enabled) document[key][id] = clone(item.config); else delete document[key][id];
    await atomicWrite(target, `${JSON.stringify(document, null, 2)}\n`);
  }

  toggleMcp(idValue, appValue, enabledValue) {
    const id = cleanId(idValue, "MCP id");
    const app = cleanApp(appValue);
    const enabled = Boolean(enabledValue);
    return this.#serialize(async () => {
      const item = this.state.mcps[id];
      if (!item) fail(`MCP not found: ${id}`, "SOURCE_NOT_FOUND", 404);
      await this.#materializeMcp(app, id, enabled);
      item.apps[app] = enabled;
      item.updatedAt = now();
      await this.#commit();
      await this.#audit("ccswitch.mcp_toggled", { id, app, enabled });
      return clone(item);
    });
  }

  deleteMcp(idValue) {
    const id = cleanId(idValue, "MCP id");
    return this.#serialize(async () => {
      const item = this.state.mcps[id];
      if (!item) fail(`MCP not found: ${id}`, "SOURCE_NOT_FOUND", 404);
      for (const app of PROVIDER_APPS) if (item.apps?.[app]) await this.#materializeMcp(app, id, false);
      delete this.state.mcps[id];
      await this.#commit();
      return { removed: id };
    });
  }

  skills() {
    return Object.values(this.state.skills).sort((a, b) => a.name.localeCompare(b.name));
  }

  async observeLiveSkills() {
    const byId = new Map();
    for (const app of SKILL_APPS) {
      const root = join(this.#configDir(app), "skills");
      let entries = [];
      try { entries = await readdir(root, { withFileTypes: true }); } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const id = entry.name;
        const skillDir = join(root, id);
        if (!(await stat(join(skillDir, "SKILL.md")).catch(() => null))) continue;
        const existing = byId.get(id) ?? {
          id,
          name: id,
          apps: appMap(() => false),
          sources: [],
          managed: Boolean(this.state.skills[id]),
          importable: ID_PATTERN.test(id),
          skipReason: ID_PATTERN.test(id) ? "" : "id 含不支持的字符",
        };
        existing.apps[app] = true;
        existing.sources.push({ app, path: skillDir });
        byId.set(id, existing);
      }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  adoptLiveSkills(input = {}) {
    const requested = Array.isArray(input.ids) ? input.ids.map((id) => String(id).trim()).filter(Boolean) : null;
    return this.#serialize(async () => {
      const observed = await this.observeLiveSkills();
      const imported = [];
      const skipped = [];
      for (const item of observed) {
        if (requested && !requested.includes(item.id)) continue;
        if (this.state.skills[item.id]) {
          skipped.push({ id: item.id, reason: "already-managed" });
          continue;
        }
        if (!item.importable || !item.sources?.length) {
          skipped.push({ id: item.id, reason: item.skipReason || "not-importable" });
          continue;
        }
        try {
        const sourceDir = item.sources[0].path;
        const files = {};
        let total = 0;
        const walk = async (dir, rel) => {
          const entries = await readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith(".")) continue;
            const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
              await walk(full, nextRel);
              continue;
            }
            const content = await readFile(full, "utf8");
            total += Buffer.byteLength(content);
            if (total > 8 * 1024 * 1024) fail("skill files exceed 8 MiB", "VALIDATION_FAILED", 413);
            files[nextRel] = content;
          }
        };
        await walk(sourceDir, "");
        if (!Object.keys(files).some((path) => path.replace(/\\/g, "/") === "SKILL.md")) {
          skipped.push({ id: item.id, reason: "missing SKILL.md" });
          continue;
        }
        const apps = appMap(() => false);
        if (item.sources[0]?.app) apps[item.sources[0].app] = true;
        await this.#installSkillFilesUnlocked({ id: item.id, name: item.name, files, apps, description: "从本机 live Skill 目录导入", source: "live-import" }, { materialize: false });
        imported.push(item.id);
        } catch (error) {
          skipped.push({ id: item.id, reason: error?.message || "import-failed" });
        }
      }
      await this.#audit("ccswitch.skill_adopted", { imported, skipped: skipped.length });
      return { imported, skipped, observed: observed.length };
    });
  }

  #skillTarget(app, name) {
    cleanApp(app, SKILL_APPS);
    return join(this.#configDir(app), "skills", name);
  }

  async installSkillFiles(input = {}) {
    return this.#serialize(() => this.#installSkillFilesUnlocked(input));
  }

  #assertSkillNameAvailable(id, name, apps) {
    const key = (value) => process.platform === "win32" ? value.toLowerCase() : value;
    for (const [otherId, other] of Object.entries(this.state.skills)) {
      if (otherId === id) continue;
      if (key(otherId) === key(id)) fail("skill id conflicts with an existing filesystem identity", "SKILL_ID_CONFLICT", 409);
      if (key(other.name) === key(name) && SKILL_APPS.some((app) => apps[app] && other.apps?.[app])) fail("skill name is already active for this app", "SKILL_TARGET_CONFLICT", 409);
    }
  }

  async #installSkillFilesUnlocked(input, { materialize = true } = {}) {
    this.#assertWritable();
    const name = cleanId(input.name, "skill name");
    const id = input.id ? cleanId(input.id, "skill id") : name;
    const files = input.files;
    if (!files || typeof files !== "object" || Array.isArray(files) || !Object.keys(files).length) fail("skill files are required", "VALIDATION_FAILED");
    if (!Object.keys(files).some((path) => path.replace(/\\/g, "/") === "SKILL.md")) fail("skill requires SKILL.md", "VALIDATION_FAILED");
    const existing = this.state.skills[id];
    const description = cleanText(input.description ?? existing?.description, "skill description", 1000);
    const apps = appMap((app) => Boolean(input.apps?.[app] ?? existing?.apps?.[app]));
    this.#assertSkillNameAvailable(id, name, apps);
    const root = join(this.skillRoot, id);
    const prepared = [];
    let total = 0;
    for (const [pathValue, contentValue] of Object.entries(files)) {
      const path = safeRelative(pathValue, "skill file path");
      const content = String(contentValue ?? "");
      total += Buffer.byteLength(content);
      if (total > 8 * 1024 * 1024) fail("skill files exceed 8 MiB", "VALIDATION_FAILED", 413);
      assertInside(root, join(root, path), "skill file path");
      prepared.push([path, content]);
    }
    const item = { id, name, description, source: input.source ?? existing?.source ?? "local", path: root, apps, createdAt: existing?.createdAt || now(), updatedAt: now() };
    const inputRoot = join(this.skillRoot, `.${id}.${randomUUID()}.input`);
    await mkdir(this.skillRoot, { recursive: true });
    await mkdir(inputRoot, { mode: 0o700 });
    try {
      for (const [path, content] of prepared) {
        const target = join(inputRoot, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      }
      const changes = [{ target: root, source: inputRoot }];
      if (materialize) for (const app of SKILL_APPS) {
        if (existing?.apps?.[app] && (existing.name !== name || !apps[app])) changes.push({ target: this.#skillTarget(app, existing.name), source: null });
        if (apps[app]) changes.push({ target: this.#skillTarget(app, name), source: inputRoot });
      }
      const publication = await this.#publishSkills({ ...this.state.skills, [id]: item }, changes, { canonicalId: id });
      await this.#audit("ccswitch.skill_installed", { id, name, publicationId: publication.id });
      return { ...clone(item), ...(publication.recoveryRequired || publication.cleanupPending ? { publication } : {}) };
    } finally { await rm(inputRoot, { recursive: true, force: true }).catch(() => {}); }
  }

  async #materializeSkill(app, id, enabled) {
    const item = this.state.skills[id];
    if (!item) fail(`skill not found: ${id}`, "SOURCE_NOT_FOUND", 404);
    const source = assertInside(this.skillRoot, item.path, "skill source");
    const target = this.#skillTarget(app, item.name);
    return this.#publishSkills(this.state.skills, [{ target, source: enabled ? source : null }], { skillId: id });
  }

  toggleSkill(idValue, appValue, enabledValue) {
    const id = cleanId(idValue, "skill id");
    const app = cleanApp(appValue, SKILL_APPS);
    const enabled = Boolean(enabledValue);
    return this.#serialize(async () => {
      const item = this.state.skills[id];
      if (!item) fail(`skill not found: ${id}`, "SOURCE_NOT_FOUND", 404);
      if (!enabled && !item.apps?.[app]) return clone(item);
      const next = { ...item, apps: { ...item.apps, [app]: enabled }, updatedAt: now() };
      this.#assertSkillNameAvailable(id, next.name, next.apps);
      const publication = await this.#publishSkills({ ...this.state.skills, [id]: next }, [{ target: this.#skillTarget(app, item.name), source: enabled ? assertInside(this.skillRoot, item.path, "skill source") : null }], { skillId: id });
      return { ...clone(next), ...(publication.recoveryRequired || publication.cleanupPending ? { publication } : {}) };
    });
  }

  uninstallSkill(idValue, { confirmed = false } = {}) {
    const id = cleanId(idValue, "skill id");
    if (confirmed !== true) fail("skill uninstall requires confirmed: true", "CONFIRMATION_REQUIRED", 409);
    return this.#serialize(async () => {
      const item = this.state.skills[id];
      if (!item) fail(`skill not found: ${id}`, "SOURCE_NOT_FOUND", 404);
      const changes = SKILL_APPS.filter((app) => item.apps?.[app]).map((app) => ({ target: this.#skillTarget(app, item.name), source: null }));
      changes.push({ target: assertInside(this.skillRoot, item.path, "skill source"), source: null });
      const skills = { ...this.state.skills };
      delete skills[id];
      const publication = await this.#publishSkills(skills, changes);
      return { removed: id, ...(publication.recoveryRequired || publication.cleanupPending ? { publication } : {}) };
    });
  }

  profileSnapshot({ id = null, name, description = "", apps = PROVIDER_SCHEME_APPS } = {}) {
    const selectedApps = uniqueApps(apps);
    const profileId = id ? cleanId(id, "profile id") : `profile-${randomUUID()}`;
    const existing = this.state.profiles[profileId] ?? null;
    const providers = this.providerStore.list().current;
    const payload = existing?.payload ? clone(existing.payload) : { providers: {}, mcp: {}, skills: {}, prompts: {} };
    for (const app of selectedApps) {
      payload.providers[app] = providers[app] ?? null;
      payload.mcp[app] = Object.values(this.state.mcps).filter((item) => item.apps?.[app]).map((item) => item.id);
      payload.skills[app] = Object.values(this.state.skills).filter((item) => item.apps?.[app]).map((item) => item.id);
      payload.prompts[app] = Object.values(this.state.prompts[app]).find((item) => item.enabled)?.id ?? null;
    }
    return this.#serialize(async () => {
      this.state.profiles[profileId] = { id: profileId, name: cleanText(name ?? existing?.name, "profile name", 120, { required: true }), description: cleanText(description ?? existing?.description, "profile description", 1000), payload, createdAt: existing?.createdAt || now(), updatedAt: now() };
      await this.#commit();
      return clone(this.state.profiles[profileId]);
    });
  }

  profiles() {
    return { items: Object.values(this.state.profiles).sort((a, b) => a.name.localeCompare(b.name)), current: { ...this.state.currentProfile } };
  }

  updateProfile(idValue, input = {}) {
    const id = cleanId(idValue, "profile id");
    return this.#serialize(async () => {
      const item = this.state.profiles[id];
      if (!item) fail(`profile not found: ${id}`, "SOURCE_NOT_FOUND", 404);
      if (input.name !== undefined) item.name = cleanText(input.name, "profile name", 120, { required: true });
      if (input.description !== undefined) item.description = cleanText(input.description, "profile description", 1000);
      item.updatedAt = now();
      await this.#commit();
      return clone(item);
    });
  }

  deleteProfile(idValue) {
    const id = cleanId(idValue, "profile id");
    return this.#serialize(async () => {
      if (!this.state.profiles[id]) fail(`profile not found: ${id}`, "SOURCE_NOT_FOUND", 404);
      delete this.state.profiles[id];
      for (const app of PROVIDER_APPS) if (this.state.currentProfile[app] === id) this.state.currentProfile[app] = null;
      await this.#commit();
      return { removed: id };
    });
  }

  clearCurrentProfile(appValue) {
    const app = cleanApp(appValue);
    return this.#serialize(async () => {
      this.state.currentProfile[app] = null;
      await this.#commit();
      return { app, current: null };
    });
  }

  async applyProfile(idValue, { apps = PROVIDER_SCHEME_APPS } = {}) {
    const id = cleanId(idValue, "profile id");
    const selectedApps = uniqueApps(apps);
    const profile = this.state.profiles[id];
    if (!profile) fail(`profile not found: ${id}`, "SOURCE_NOT_FOUND", 404);
    const warnings = [];
    for (const app of selectedApps) {
      const providerId = profile.payload.providers?.[app];
      if (providerId) await this.providerStore.switchTo(app, providerId).catch((error) => warnings.push({ app, kind: "provider", message: error.message }));
      const targetMcps = new Set(profile.payload.mcp?.[app] ?? []);
      for (const item of Object.values(this.state.mcps)) {
        const desired = targetMcps.has(item.id);
        if (Boolean(item.apps?.[app]) !== desired) await this.toggleMcp(item.id, app, desired).catch((error) => warnings.push({ app, kind: "mcp", id: item.id, message: error.message }));
      }
      if (SKILL_APPS.includes(app)) {
        const targetSkills = new Set(profile.payload.skills?.[app] ?? []);
        for (const item of Object.values(this.state.skills)) {
          const desired = targetSkills.has(item.id);
          if (Boolean(item.apps?.[app]) !== desired) await this.toggleSkill(item.id, app, desired).catch((error) => warnings.push({ app, kind: "skill", id: item.id, message: error.message }));
        }
      }
      const promptId = profile.payload.prompts?.[app];
      if (PROMPT_APPS.includes(app) && promptId) await this.enablePrompt(app, promptId).catch((error) => warnings.push({ app, kind: "prompt", id: promptId, message: error.message }));
      this.state.currentProfile[app] = id;
    }
    await this.#serialize(async () => this.#commit());
    await this.#audit("ccswitch.profile_applied", { id, apps: selectedApps, warningCount: warnings.length });
    return { id, apps: selectedApps, warnings };
  }

  snapshot() {
    return {
      schema: "514cc.ccswitch-snapshot/v1",
      createdAt: now(),
      providers: this.providerStore.exportProviders({ includeSecrets: true }),
      domain: clone(this.state),
      auth: this.authService?.exportState?.() ?? null,
    };
  }

  async restoreSnapshot(snapshot, { syncLive = true, apps = PROVIDER_SCHEME_APPS } = {}) {
    if (snapshot?.schema !== "514cc.ccswitch-snapshot/v1" || !snapshot.domain || !snapshot.providers) fail("invalid CC-Switch snapshot", "BACKUP_INVALID");
    const selectedApps = syncLive ? uniqueApps(apps) : [];
    const nextState = normalizeState(snapshot.domain);
    for (const [app, configured] of Object.entries(nextState.settings.configDirs)) {
      if (!configured) continue;
      if (!isAbsolute(configured)) fail(`snapshot config directory is not absolute for ${app}`, "BACKUP_INVALID");
      assertInside(this.runtimeHome, configured, `snapshot config directory for ${app}`);
    }
    const previous = this.snapshot();
    try {
      await this.providerStore.importProviders(snapshot.providers, { mode: "replace" });
      await this.#serialize(async () => {
        this.state = nextState;
        await this.#commit();
      });
      if (snapshot.auth && this.authService) await this.authService.importState(snapshot.auth);
    } catch (error) {
      await this.providerStore.importProviders(previous.providers, { mode: "replace" }).catch(() => {});
      this.state = normalizeState(previous.domain);
      await this.#serialize(async () => this.#commit()).catch(() => {});
      if (previous.auth && this.authService) await this.authService.importState(previous.auth).catch(() => {});
      throw error;
    }
    const warnings = syncLive ? await this.syncAllLive({ apps: selectedApps }) : [];
    return { restoredAt: now(), warnings };
  }

  async createBackup(nameValue = "") {
    const name = cleanText(nameValue, "backup name", 80).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    const filename = `${stamp()}${name ? `-${name}` : ""}.json`;
    const path = join(this.backupDir, filename);
    const payload = this.snapshot();
    await atomicWrite(path, `${JSON.stringify(payload, null, 2)}\n`);
    return { filename, path, size: Buffer.byteLength(JSON.stringify(payload)), createdAt: payload.createdAt };
  }

  async listBackups() {
    const entries = await readdir(this.backupDir, { withFileTypes: true }).catch(() => []);
    const output = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || !ID_PATTERN.test(entry.name.replace(/\.json$/, ""))) continue;
      const info = await stat(join(this.backupDir, entry.name));
      output.push({ filename: entry.name, size: info.size, modifiedAt: info.mtime.toISOString() });
    }
    return output.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  async restoreBackup(filenameValue, options = {}) {
    const filename = `${cleanId(String(filenameValue).replace(/\.json$/, ""), "backup filename")}.json`;
    const path = assertInside(this.backupDir, join(this.backupDir, filename), "backup path");
    let payload;
    try { payload = JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error?.code === "ENOENT") fail("backup not found", "SOURCE_NOT_FOUND", 404); throw error; }
    return this.restoreSnapshot(payload, options);
  }

  async renameBackup(filenameValue, nameValue) {
    const oldName = `${cleanId(String(filenameValue).replace(/\.json$/, ""), "backup filename")}.json`;
    const nextName = `${cleanId(String(nameValue).replace(/\.json$/, ""), "backup name")}.json`;
    await rename(assertInside(this.backupDir, join(this.backupDir, oldName)), assertInside(this.backupDir, join(this.backupDir, nextName)));
    return { filename: nextName };
  }

  async deleteBackup(filenameValue, { confirmed = false } = {}) {
    if (confirmed !== true) fail("backup deletion requires confirmed: true", "CONFIRMATION_REQUIRED", 409);
    const filename = `${cleanId(String(filenameValue).replace(/\.json$/, ""), "backup filename")}.json`;
    await rm(assertInside(this.backupDir, join(this.backupDir, filename)), { force: true });
    return { removed: filename };
  }

  async syncAllLive({ apps = PROVIDER_SCHEME_APPS } = {}) {
    this.#assertWritable();
    const selectedApps = uniqueApps(apps);
    const selected = new Set(selectedApps);
    const warnings = [];
    const current = this.providerStore.list().current;
    for (const app of selectedApps) {
      if (current[app]) await this.providerStore.switchTo(app, current[app]).catch((error) => warnings.push({ app, kind: "provider", message: error.message }));
    }
    for (const item of Object.values(this.state.mcps)) for (const app of selectedApps) if (item.apps?.[app]) await this.#materializeMcp(app, item.id, true).catch((error) => warnings.push({ app, kind: "mcp", id: item.id, message: error.message }));
    await this.#serialize(async () => {
      for (const item of Object.values(this.state.skills)) for (const app of SKILL_APPS) if (selected.has(app) && item.apps?.[app]) {
        try {
          const publication = await this.#materializeSkill(app, item.id, true);
          if (publication.recoveryRequired || publication.cleanupPending) warnings.push({ app, kind: "skill", id: item.id, message: publication.recoveryRequired ? "SKILL_TRANSACTION_RECOVERY_REQUIRED" : "SKILL_CLEANUP_PENDING" });
        } catch (error) { warnings.push({ app, kind: "skill", id: item.id, message: error.message }); }
        if (this.storeStatus.state === "blocked") return;
      }
    });
    if (this.storeStatus.state === "blocked") return warnings;
    for (const app of PROMPT_APPS.filter((app) => selected.has(app))) {
      const active = Object.values(this.state.prompts[app]).find((item) => item.enabled);
      if (active) await atomicWrite(this.#promptPath(app), active.content).catch((error) => warnings.push({ app, kind: "prompt", id: active.id, message: error.message }));
    }
    return warnings;
  }

  saveStreamCheckConfig(input = {}) {
    const timeoutMs = Math.max(500, Math.min(120_000, Number(input.timeoutMs ?? this.state.settings.streamCheck.timeoutMs) || 10_000));
    const degradedMs = Math.max(1, Math.min(timeoutMs, Number(input.degradedMs ?? this.state.settings.streamCheck.degradedMs) || 3_000));
    const concurrency = Math.max(1, Math.min(16, Math.round(Number(input.concurrency ?? this.state.settings.streamCheck.concurrency) || 4)));
    return this.#serialize(async () => {
      this.state.settings.streamCheck = { timeoutMs, degradedMs, concurrency };
      await this.#commit();
      return { ...this.state.settings.streamCheck };
    });
  }

  streamCheckConfig() {
    return { ...this.state.settings.streamCheck };
  }

  async streamCheckProvider(providerId) {
    const provider = this.providerStore.get(cleanId(providerId, "provider id"));
    const config = this.state.settings.streamCheck;
    return checkReachability({ baseUrl: provider.baseUrl, timeoutMs: config.timeoutMs, degradedMs: config.degradedMs });
  }

  async streamCheckAll({ app = null } = {}) {
    if (app !== null) cleanApp(app);
    const providers = this.providerStore.list().providers.filter((provider) => !app || provider.apps?.[app]);
    const results = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.state.settings.streamCheck.concurrency, Math.max(1, providers.length)) }, async () => {
      while (cursor < providers.length) {
        const provider = providers[cursor++];
        try { results.push({ providerId: provider.id, name: provider.name, ...(await this.streamCheckProvider(provider.id)) }); }
        catch (error) { results.push({ providerId: provider.id, name: provider.name, status: "failed", message: error.message }); }
      }
    });
    await Promise.all(workers);
    return results;
  }

  async fetchModels({ providerId, app } = {}) {
    const provider = this.providerStore.get(cleanId(providerId, "provider id"));
    const targetApp = cleanApp(app);
    if (!provider.apps?.[targetApp]) fail(`provider is not enabled for ${targetApp}`, "VALIDATION_FAILED");
    const base = ensureHttpUrl(provider.baseUrl, "provider base URL").replace(/\/+$/, "");
    let url = `${base}${/\/v\d+(?:beta)?$/i.test(new URL(base).pathname) ? "" : targetApp === "gemini" ? "/v1beta" : "/v1"}/models`;
    const headers = { accept: "application/json" };
    if (targetApp === "gemini") {
      const parsed = new URL(url);
      parsed.searchParams.set("key", provider.apiKey || "");
      url = parsed.href;
    } else if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await this.fetchImpl(url, { headers, signal: controller.signal });
      const payload = await response.json().catch(() => null);
      if (!response.ok) fail(`model endpoint returned HTTP ${response.status}`, "MODEL_FETCH_FAILED", 502);
      const list = payload?.data ?? payload?.models ?? [];
      return { providerId: provider.id, app: targetApp, source: url.replace(/([?&]key=)[^&]+/, "$1••••"), models: list.map((item) => typeof item === "string" ? item : item.id ?? item.name).filter(Boolean) };
    } finally {
      clearTimeout(timer);
    }
  }

  parseDeeplink(rawValue) {
    const raw = String(rawValue ?? "").trim();
    if (Buffer.byteLength(raw) > MAX_DEEPLINK) fail("deep link exceeds 64 KiB", "DEEPLINK_TOO_LARGE", 413);
    let url;
    try { url = new URL(raw); } catch { fail("invalid deep link URL", "DEEPLINK_INVALID"); }
    if (url.protocol !== "ccswitch:" || url.hostname !== "v1" || url.pathname !== "/import" || url.username || url.password || url.port || url.hash) fail("deep link must target ccswitch://v1/import", "DEEPLINK_INVALID");
    const resource = url.searchParams.get("resource");
    if (resource === "provider") return { resource, payload: parseProviderDeeplink(raw) };
    if (resource === "prompt") {
      const app = cleanApp(url.searchParams.get("app"), PROMPT_APPS);
      return { resource, payload: { app, name: cleanText(url.searchParams.get("name"), "prompt name", 120, { required: true }), content: String(url.searchParams.get("content") ?? ""), description: cleanText(url.searchParams.get("description"), "prompt description", 1000), enabled: url.searchParams.get("enabled") === "true" } };
    }
    if (resource === "mcp") {
      const apps = uniqueApps(url.searchParams.get("apps"));
      const rawConfig = String(url.searchParams.get("config") ?? "");
      let config;
      try { config = JSON.parse(rawConfig); } catch {
        try { config = JSON.parse(Buffer.from(rawConfig, "base64url").toString("utf8")); } catch { fail("MCP deep link config must be JSON or base64url JSON", "DEEPLINK_INVALID"); }
      }
      const id = cleanId(config.id ?? config.name ?? `mcp-${sha256(rawConfig).slice(0, 12)}`, "MCP id");
      const name = cleanText(config.name ?? id, "MCP name", 120, { required: true });
      const spec = config.config ? clone(config.config) : clone(config);
      delete spec.id;
      delete spec.name;
      return { resource, payload: { id, name, config: validateMcpConfig(spec), apps: Object.fromEntries(PROVIDER_APPS.map((app) => [app, apps.includes(app)])) } };
    }
    if (resource === "skill") {
      const repo = cleanText(url.searchParams.get("repo"), "skill repo", 200, { required: true });
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail("skill repo must use owner/name format", "DEEPLINK_INVALID");
      const directory = cleanText(url.searchParams.get("directory"), "skill directory", 500);
      if (directory) safeRelative(directory, "skill directory");
      const branch = cleanText(url.searchParams.get("branch") || "main", "skill branch", 200);
      if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..")) fail("invalid skill branch", "DEEPLINK_INVALID");
      return { resource, payload: { repo, directory: directory || null, branch } };
    }
    fail(`unsupported deep link resource: ${resource}`, "DEEPLINK_INVALID");
  }

  async importDeeplink(raw, { confirmed = false } = {}) {
    const parsed = this.parseDeeplink(raw);
    if (parsed.resource === "provider") return { resource: parsed.resource, item: await this.providerStore.create(parsed.payload) };
    if (parsed.resource === "prompt") return { resource: parsed.resource, item: await this.upsertPrompt(parsed.payload.app, parsed.payload) };
    if (parsed.resource === "mcp") return { resource: parsed.resource, item: await this.upsertMcp(parsed.payload) };
    if (confirmed !== true) fail("remote skill installation requires confirmed: true", "CONFIRMATION_REQUIRED", 409);
    return { resource: parsed.resource, item: await this.#installGithubSkill(parsed.payload) };
  }

  async #installGithubSkill({ repo, directory, branch }) {
    const url = `https://github.com/${repo}.git`;
    const tempRoot = join(this.dataRoot, "ccswitch", "staging", `skill-${randomUUID()}`);
    await mkdir(dirname(tempRoot), { recursive: true });
    await new Promise((resolveClone, rejectClone) => {
      const child = spawn("git", ["clone", "--depth", "1", "--branch", branch, "--", url, tempRoot], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 4000) stderr = stderr.slice(-4000); });
      child.on("error", rejectClone);
      child.on("close", (code) => {
        if (code === 0) resolveClone();
        else rejectClone(Object.assign(new Error(`git clone failed (${code}): ${stderr.slice(-500)}`), { code: "SKILL_INSTALL_FAILED", httpStatus: 502 }));
      });
    });
    try {
      const root = directory ? assertInside(tempRoot, join(tempRoot, safeRelative(directory)), "skill directory") : tempRoot;
      if (!(await stat(join(root, "SKILL.md")).catch(() => null))) fail("remote skill directory contains no SKILL.md", "SKILL_INVALID");
      const files = {};
      const walk = async (dir) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entry.name === ".git") continue;
          const path = join(dir, entry.name);
          if (entry.isDirectory()) await walk(path);
          else if (entry.isFile()) {
            const rel = relative(root, path).replace(/\\/g, "/");
            files[rel] = await readFile(path, "utf8");
          }
        }
      };
      await walk(root);
      const frontmatter = files["SKILL.md"].match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
      const sourceName = frontmatter.match(/^name\s*:\s*["']?([^\r\n"']+)/m)?.[1]?.trim();
      const name = cleanId(sourceName || basename(directory || repo), "skill name");
      return this.installSkillFiles({ name, files, source: { repo, directory, branch }, apps: { claude: true, codex: true } });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  #openClawWorkspaceRoot() {
    return join(this.#configDir("openclaw"), "workspace");
  }

  #hermesRoot() {
    return this.#configDir("hermes");
  }

  async #runtimeBackup(target, namespace) {
    const info = await stat(target).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!info?.isFile()) return null;
    const root = join(this.backupDir, "runtime", safeRelative(namespace, "backup namespace"));
    await mkdir(root, { recursive: true });
    const backup = join(root, `${stamp()}-${basename(target)}`);
    await cp(target, backup);
    return backup;
  }

  #workspaceFilename(value) {
    const filename = cleanText(value, "workspace filename", 64, { required: true });
    if (!OPENCLAW_WORKSPACE_FILES.includes(filename)) fail(`unsupported workspace filename: ${filename}`, "VALIDATION_FAILED");
    return filename;
  }

  #dailyMemoryFilename(value) {
    const filename = cleanText(value, "daily memory filename", 32, { required: true });
    if (!DAILY_MEMORY_PATTERN.test(filename)) fail("daily memory filename must use YYYY-MM-DD.md", "VALIDATION_FAILED");
    const date = new Date(`${filename.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== filename.slice(0, 10)) fail("daily memory filename contains an invalid date", "VALIDATION_FAILED");
    return filename;
  }

  async workspaceStatus() {
    const workspaceRoot = this.#openClawWorkspaceRoot();
    const files = [];
    for (const filename of OPENCLAW_WORKSPACE_FILES) {
      const info = await stat(join(workspaceRoot, filename)).catch(() => null);
      files.push({ filename, exists: Boolean(info?.isFile()), size: info?.isFile() ? info.size : 0, modifiedAt: info?.isFile() ? info.mtime.toISOString() : null });
    }
    return { openclaw: { root: workspaceRoot, files, daily: await this.listDailyMemoryFiles() }, hermes: { root: this.#hermesRoot(), limits: await this.hermesMemoryLimits() } };
  }

  async readWorkspaceFile(filenameValue) {
    const filename = this.#workspaceFilename(filenameValue);
    const target = join(this.#openClawWorkspaceRoot(), filename);
    const content = await readFile(target, "utf8").catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    return { filename, content, target };
  }

  writeWorkspaceFile(filenameValue, contentValue) {
    const filename = this.#workspaceFilename(filenameValue);
    const content = String(contentValue ?? "");
    if (Buffer.byteLength(content) > MAX_TEXT) fail("workspace file exceeds 1 MiB", "VALIDATION_FAILED");
    return this.#serialize(async () => {
      const target = join(this.#openClawWorkspaceRoot(), filename);
      const backup = await this.#runtimeBackup(target, "openclaw-workspace");
      await atomicWrite(target, content);
      await this.#audit("ccswitch.workspace_written", { filename, target, backup });
      return { filename, target, backup, bytes: Buffer.byteLength(content) };
    });
  }

  async listDailyMemoryFiles() {
    const root = join(this.#openClawWorkspaceRoot(), "memory");
    const entries = await readdir(root, { withFileTypes: true }).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
    const items = [];
    for (const entry of entries) {
      if (!entry.isFile() || !DAILY_MEMORY_PATTERN.test(entry.name)) continue;
      const target = join(root, entry.name);
      const [info, content] = await Promise.all([stat(target), readFile(target, "utf8")]);
      items.push({ filename: entry.name, date: entry.name.slice(0, 10), size: info.size, modifiedAt: info.mtime.toISOString(), preview: content.slice(0, 200) });
    }
    return items.sort((left, right) => right.filename.localeCompare(left.filename));
  }

  async readDailyMemoryFile(filenameValue) {
    const filename = this.#dailyMemoryFilename(filenameValue);
    const target = join(this.#openClawWorkspaceRoot(), "memory", filename);
    const content = await readFile(target, "utf8").catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    return { filename, content, target };
  }

  writeDailyMemoryFile(filenameValue, contentValue) {
    const filename = this.#dailyMemoryFilename(filenameValue);
    const content = String(contentValue ?? "");
    if (Buffer.byteLength(content) > MAX_TEXT) fail("daily memory file exceeds 1 MiB", "VALIDATION_FAILED");
    return this.#serialize(async () => {
      const target = join(this.#openClawWorkspaceRoot(), "memory", filename);
      const backup = await this.#runtimeBackup(target, "openclaw-daily-memory");
      await atomicWrite(target, content);
      await this.#audit("ccswitch.daily_memory_written", { filename, target, backup });
      return { filename, target, backup, bytes: Buffer.byteLength(content) };
    });
  }

  deleteDailyMemoryFile(filenameValue, { confirmed = false } = {}) {
    if (confirmed !== true) fail("daily memory deletion requires confirmed: true", "CONFIRMATION_REQUIRED", 409);
    const filename = this.#dailyMemoryFilename(filenameValue);
    return this.#serialize(async () => {
      const target = join(this.#openClawWorkspaceRoot(), "memory", filename);
      const backup = await this.#runtimeBackup(target, "openclaw-daily-memory");
      if (!backup) fail(`daily memory file not found: ${filename}`, "SOURCE_NOT_FOUND", 404);
      await rm(target);
      await this.#audit("ccswitch.daily_memory_deleted", { filename, target, backup });
      return { filename, deleted: true, backup };
    });
  }

  async searchDailyMemoryFiles(queryValue) {
    const query = cleanText(queryValue, "memory query", 200, { required: true }).toLocaleLowerCase();
    const results = [];
    for (const item of await this.listDailyMemoryFiles()) {
      const { content } = await this.readDailyMemoryFile(item.filename);
      const lower = String(content ?? "").toLocaleLowerCase();
      const positions = [...lower.matchAll(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))].map((match) => match.index);
      if (!positions.length && !item.date.toLocaleLowerCase().includes(query)) continue;
      const first = positions[0] ?? 0;
      results.push({ ...item, matchCount: positions.length, snippet: String(content ?? "").slice(Math.max(0, first - 50), first + query.length + 70) });
    }
    return results;
  }

  #hermesMemoryKind(value) {
    const kind = cleanText(value, "Hermes memory kind", 16, { required: true });
    if (!HERMES_MEMORY_FILES[kind]) fail("Hermes memory kind must be memory or user", "VALIDATION_FAILED");
    return kind;
  }

  async readHermesMemory(kindValue) {
    const kind = this.#hermesMemoryKind(kindValue);
    const target = join(this.#hermesRoot(), "memories", HERMES_MEMORY_FILES[kind]);
    const content = await readFile(target, "utf8").catch((error) => error?.code === "ENOENT" ? "" : Promise.reject(error));
    return { kind, content, target };
  }

  writeHermesMemory(kindValue, contentValue) {
    const kind = this.#hermesMemoryKind(kindValue);
    const content = String(contentValue ?? "");
    if (Buffer.byteLength(content) > MAX_TEXT) fail("Hermes memory exceeds 1 MiB", "VALIDATION_FAILED");
    return this.#serialize(async () => {
      const target = join(this.#hermesRoot(), "memories", HERMES_MEMORY_FILES[kind]);
      const backup = await this.#runtimeBackup(target, "hermes-memory");
      await atomicWrite(target, content);
      await this.#audit("ccswitch.hermes_memory_written", { kind, target, backup });
      return { kind, target, backup, bytes: Buffer.byteLength(content) };
    });
  }

  async hermesMemoryLimits() {
    const config = await readObject(join(this.#hermesRoot(), "config.yaml"), { yaml: true });
    const memory = config.memory && typeof config.memory === "object" && !Array.isArray(config.memory) ? config.memory : {};
    return {
      memory: Number.isInteger(memory.memory_char_limit) && memory.memory_char_limit > 0 ? memory.memory_char_limit : 2200,
      user: Number.isInteger(memory.user_char_limit) && memory.user_char_limit > 0 ? memory.user_char_limit : 1375,
      memoryEnabled: memory.memory_enabled !== false,
      userEnabled: memory.user_profile_enabled !== false,
    };
  }

  setHermesMemoryEnabled(kindValue, enabledValue) {
    const kind = this.#hermesMemoryKind(kindValue);
    return this.#serialize(async () => {
      const target = join(this.#hermesRoot(), "config.yaml");
      const config = await readObject(target, { yaml: true });
      if (!config.memory || typeof config.memory !== "object" || Array.isArray(config.memory)) config.memory = {};
      config.memory[kind === "memory" ? "memory_enabled" : "user_profile_enabled"] = Boolean(enabledValue);
      const backup = await this.#runtimeBackup(target, "hermes-config");
      await atomicWrite(target, stringifyYaml(config, { lineWidth: 0 }));
      await this.#audit("ccswitch.hermes_memory_toggled", { kind, enabled: Boolean(enabledValue), target, backup });
      return { kind, enabled: Boolean(enabledValue), target, backup };
    });
  }

  async envConflicts(app = null) {
    if (typeof this.envAdapter.inspect === "function") {
      const inspected = await this.envAdapter.inspect(CCSWITCH_ENVIRONMENT_WATCH);
      const conflicts = inspected.map((item) => ({
        app: item.app,
        name: item.name,
        scope: item.scope,
        source: item.source,
        valueMasked: mask(item.value),
      }));
      return {
        conflicts: app ? conflicts.filter((item) => item.app === app) : conflicts,
        checked: CCSWITCH_ENVIRONMENT_WATCH.length * (process.platform === "win32" ? 3 : 1),
      };
    }
    const result = this.providerStore.envConflicts();
    const conflicts = (Array.isArray(result) ? result : result?.conflicts ?? []).map((item) => ({
      ...item,
      name: item.name ?? item.key,
      scope: item.scope ?? "Process",
      source: item.source ?? "process.env",
    }));
    return { conflicts: app ? conflicts.filter((item) => item.app === app) : conflicts, checked: result?.checked ?? conflicts.length };
  }

  deleteEnv(items, { confirmed = false } = {}) {
    if (confirmed !== true) fail("environment deletion requires confirmed: true", "CONFIRMATION_REQUIRED", 409);
    if (!Array.isArray(items) || !items.length) fail("environment items are required", "VALIDATION_FAILED");
    const names = [...new Set(items.map((item) => typeof item === "string" ? item : item?.name ?? item?.varName))];
    for (const name of names) if (!ENV_PATTERN.test(name)) fail(`invalid environment variable name: ${name}`, "VALIDATION_FAILED");
    return this.#serialize(async () => {
      const backupId = `env-${Date.now()}`;
      const backup = { id: backupId, createdAt: now(), items: [] };
      const inspected = typeof this.envAdapter.inspect === "function"
        ? await this.envAdapter.inspect(CCSWITCH_ENVIRONMENT_WATCH)
        : names.flatMap((name) => process.env[name] === undefined ? [] : [{ name, value: process.env[name], scope: "Process", source: "process.env" }]);
      const selected = [];
      for (const requested of items) {
        const name = typeof requested === "string" ? requested : requested?.name ?? requested?.varName;
        const scope = typeof requested === "string" ? null : requested?.scope ?? null;
        for (const match of inspected.filter((item) => item.name === name && (!scope || item.scope === scope))) {
          const key = `${match.scope}:${match.name}`;
          if (!selected.some((item) => `${item.scope}:${item.name}` === key)) selected.push(match);
        }
      }
      if (!selected.length) fail("selected environment variables no longer exist", "SOURCE_NOT_FOUND", 404);
      for (const item of selected) {
        backup.items.push({ name: item.name, value: item.value, scope: item.scope ?? "Process", source: item.source ?? null, app: item.app ?? null });
        await this.envAdapter.remove(item);
      }
      this.state.envBackups[backupId] = backup;
      await this.#commit();
      await this.#audit("ccswitch.env_deleted", { backupId, names: backup.items.map((item) => item.name) });
      return { id: backupId, createdAt: backup.createdAt, items: backup.items.map((item) => ({ name: item.name, scope: item.scope, valueMasked: mask(item.value) })) };
    });
  }

  restoreEnv(backupIdValue, { confirmed = false } = {}) {
    if (confirmed !== true) fail("environment restore requires confirmed: true", "CONFIRMATION_REQUIRED", 409);
    const backupId = cleanId(backupIdValue, "environment backup id");
    return this.#serialize(async () => {
      const backup = this.state.envBackups[backupId];
      if (!backup) fail(`environment backup not found: ${backupId}`, "SOURCE_NOT_FOUND", 404);
      for (const item of backup.items) await this.envAdapter.set(item);
      await this.#audit("ccswitch.env_restored", { backupId, names: backup.items.map((item) => item.name) });
      return { id: backupId, restored: backup.items.map((item) => item.name) };
    });
  }

  saveSyncSettings(kindValue, input = {}) {
    const kind = kindValue === "webdav" || kindValue === "s3" ? kindValue : fail("sync kind must be webdav or s3", "VALIDATION_FAILED");
    const existing = this.state.settings[kind] ?? {};
    let settings;
    if (kind === "webdav") {
      settings = {
        enabled: Boolean(input.enabled),
        baseUrl: ensureHttpUrl(input.baseUrl, "WebDAV base URL"),
        username: cleanText(input.username, "WebDAV username", 300),
        password: input.passwordTouched === true ? String(input.password ?? "") : String(input.password || existing.password || ""),
        remotePath: safeRelative(input.remotePath || existing.remotePath || "ccswitch/backup.json", "WebDAV remote path"),
        status: existing.status ?? {},
      };
    } else {
      settings = {
        enabled: Boolean(input.enabled),
        endpoint: input.endpoint ? ensureHttpUrl(input.endpoint, "S3 endpoint") : "",
        region: cleanText(input.region || existing.region || "us-east-1", "S3 region", 100, { required: true }),
        bucket: cleanText(input.bucket, "S3 bucket", 255, { required: true }),
        accessKeyId: cleanText(input.accessKeyId, "S3 access key id", 300, { required: true }),
        secretAccessKey: input.secretTouched === true ? String(input.secretAccessKey ?? "") : String(input.secretAccessKey || existing.secretAccessKey || ""),
        sessionToken: input.sessionTokenTouched === true ? String(input.sessionToken ?? "") : String(input.sessionToken || existing.sessionToken || ""),
        key: safeRelative(input.key || existing.key || "ccswitch/backup.json", "S3 object key"),
        forcePathStyle: Boolean(input.forcePathStyle),
        status: existing.status ?? {},
      };
      if (!settings.secretAccessKey) fail("S3 secret access key is required", "VALIDATION_FAILED");
    }
    return this.#serialize(async () => {
      this.state.settings[kind] = settings;
      await this.#commit();
      return publicState(this.state, this.storeStatus).settings[kind];
    });
  }

  #syncSettings(kind, override = null) {
    const saved = this.state.settings[kind];
    const settings = override ? { ...(saved ?? {}), ...override } : saved;
    if (!settings) fail(`${kind} sync is not configured`, "SYNC_NOT_CONFIGURED", 409);
    if (!override && !settings.enabled) fail(`${kind} sync is disabled`, "SYNC_DISABLED", 409);
    return settings;
  }

  async #webdavRequest(settings, method, body = undefined) {
    const base = new URL(ensureHttpUrl(settings.baseUrl, "WebDAV base URL"));
    const url = new URL(safeRelative(settings.remotePath || "ccswitch/backup.json"), base.href.endsWith("/") ? base : `${base.href}/`);
    const headers = { accept: "application/json" };
    if (settings.username || settings.password) headers.authorization = `Basic ${Buffer.from(`${settings.username || ""}:${settings.password || ""}`).toString("base64")}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.fetchImpl(url, { method, headers, body });
    if (!response.ok) fail(`WebDAV returned HTTP ${response.status}`, "WEBDAV_FAILED", 502);
    return response;
  }

  #s3Target(settings, key = settings.key) {
    const objectPath = encodeAwsPath(key);
    if (settings.endpoint) {
      const endpoint = new URL(ensureHttpUrl(settings.endpoint, "S3 endpoint"));
      if (settings.forcePathStyle) endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/${encodeURIComponent(settings.bucket)}${objectPath}`;
      else { endpoint.hostname = `${settings.bucket}.${endpoint.hostname}`; endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}${objectPath}`; }
      return endpoint;
    }
    return new URL(`https://${settings.bucket}.s3.${settings.region}.amazonaws.com${objectPath}`);
  }

  async #s3Request(settings, method, body = Buffer.alloc(0), key = settings.key) {
    const url = this.#s3Target(settings, key);
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
    const payloadHash = sha256(payload);
    const date = awsDate();
    const dateShort = date.slice(0, 8);
    const headers = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": date };
    if (settings.sessionToken) headers["x-amz-security-token"] = settings.sessionToken;
    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers).sort().map((name) => `${name}:${String(headers[name]).trim()}\n`).join("");
    const canonicalRequest = [method, url.pathname, url.searchParams.toString(), canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${dateShort}/${settings.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256(canonicalRequest)].join("\n");
    const dateKey = hmac(`AWS4${settings.secretAccessKey}`, dateShort);
    const regionKey = hmac(dateKey, settings.region);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = hmac(signingKey, stringToSign, "hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${settings.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const response = await this.fetchImpl(url, { method, headers, body: ["GET", "HEAD"].includes(method) ? undefined : payload });
    if (!response.ok) fail(`S3 returned HTTP ${response.status}`, "S3_FAILED", 502);
    return response;
  }

  async testSync(kindValue, override = null) {
    const kind = kindValue === "webdav" || kindValue === "s3" ? kindValue : fail("sync kind must be webdav or s3", "VALIDATION_FAILED");
    const settings = this.#syncSettings(kind, override);
    if (kind === "webdav") {
      const base = new URL(ensureHttpUrl(settings.baseUrl, "WebDAV base URL"));
      const headers = {};
      if (settings.username || settings.password) headers.authorization = `Basic ${Buffer.from(`${settings.username || ""}:${settings.password || ""}`).toString("base64")}`;
      const response = await this.fetchImpl(base, { method: "OPTIONS", headers });
      if (!response.ok) fail(`WebDAV returned HTTP ${response.status}`, "WEBDAV_FAILED", 502);
    } else {
      await this.#s3Request(settings, "HEAD", Buffer.alloc(0), "");
    }
    return { ok: true, kind };
  }

  async syncUpload(kindValue) {
    const kind = kindValue === "webdav" || kindValue === "s3" ? kindValue : fail("sync kind must be webdav or s3", "VALIDATION_FAILED");
    const settings = this.#syncSettings(kind);
    const body = JSON.stringify(this.snapshot());
    try {
      if (kind === "webdav") await this.#webdavRequest(settings, "PUT", body);
      else await this.#s3Request(settings, "PUT", body);
      settings.status = { lastSuccessAt: now(), lastDirection: "upload", lastError: null };
      await this.#serialize(async () => this.#commit());
      return { ok: true, kind, bytes: Buffer.byteLength(body), at: settings.status.lastSuccessAt };
    } catch (error) {
      settings.status = { ...(settings.status ?? {}), lastError: error.message, lastErrorAt: now(), lastDirection: "upload" };
      await this.#serialize(async () => this.#commit()).catch(() => {});
      throw error;
    }
  }

  async syncDownload(kindValue, { syncLive = true, apps = PROVIDER_SCHEME_APPS } = {}) {
    const kind = kindValue === "webdav" || kindValue === "s3" ? kindValue : fail("sync kind must be webdav or s3", "VALIDATION_FAILED");
    const settings = this.#syncSettings(kind);
    try {
      const response = kind === "webdav" ? await this.#webdavRequest(settings, "GET") : await this.#s3Request(settings, "GET");
      const snapshot = JSON.parse(await response.text());
      const result = await this.restoreSnapshot(snapshot, { syncLive, apps });
      this.state.settings[kind].status = { lastSuccessAt: now(), lastDirection: "download", lastError: null };
      await this.#serialize(async () => this.#commit());
      return { ok: true, kind, ...result };
    } catch (error) {
      if (this.state.settings[kind]) this.state.settings[kind].status = { ...(this.state.settings[kind].status ?? {}), lastError: error.message, lastErrorAt: now(), lastDirection: "download" };
      await this.#serialize(async () => this.#commit()).catch(() => {});
      throw error;
    }
  }

  async syncRemoteInfo(kindValue) {
    const kind = kindValue === "webdav" || kindValue === "s3" ? kindValue : fail("sync kind must be webdav or s3", "VALIDATION_FAILED");
    const settings = this.#syncSettings(kind);
    const response = kind === "webdav" ? await this.#webdavRequest(settings, "HEAD") : await this.#s3Request(settings, "HEAD");
    return { kind, etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified"), contentLength: Number(response.headers.get("content-length") || 0) };
  }
}

export const ccswitchDomainInternals = Object.freeze({
  defaultState,
  normalizeState,
  spliceManagedBlock,
  mcpToml,
  parseTomlMcpServers,
  stripTomlMcpTables,
  restoreMaskedSecrets,
  validateMcpConfig,
  encodeAwsPath,
});
