// 动态模型/推理档位发现（2026-07-19 LO：/model 不能是静态死目录，effort 各家有独立档位）：
// 按 CLI 原生发现能力取最新目录，5 分钟缓存，失败如实回退 models.json 静态目录。
// 实证来源：codex → `codex debug models`（JSON：slug/display_name/supported_reasoning_levels）；
// grok → `grok models`（文本清单 + default 标记）；claude → `claude models`（格式不稳定）；
// kimi → `kimi provider list --json`（Provider 模型目录）。解析失败统一回退静态目录。
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./process-runner.mjs";
import { runtimeControlCatalog } from "./adapters/manifest.mjs";

const CACHE_TTL_MS = 5 * 60_000;

/** codex debug models 的 JSON → 统一形态。visibility:"list" 才进目录（内部/隐藏模型不列）。 */
export function parseCodexCatalog(raw) {
  const parsed = JSON.parse(raw);
  const models = (parsed.models ?? [])
    .filter((entry) => entry?.slug && (entry.visibility ?? "list") === "list")
    .map((entry) => ({
      id: entry.slug,
      label: entry.display_name || entry.slug,
      defaultReasoning: entry.default_reasoning_level ?? null,
    }));
  // 推理档位取首个模型的支持集（目录内模型档位集通常一致；差异时以首个为准）
  const effortLevels = (parsed.models?.[0]?.supported_reasoning_levels ?? []).map((level) => level.effort).filter(Boolean);
  const defaultModel = models[0]?.id ?? null;
  return { models, effortLevels, defaultModel };
}

/** grok models 的文本清单 → 统一形态：`* x (default)` / `- y`。 */
export function parseGrokCatalog(raw) {
  const models = [];
  let defaultModel = null;
  for (const line of String(raw).split(/\r?\n/)) {
    const match = /^\s*[*-]\s+([A-Za-z0-9._-]+)(?:\s+\(default\))?\s*$/.exec(line);
    if (!match) continue;
    const id = match[1];
    const isDefault = line.includes("(default)") || line.startsWith("*");
    if (isDefault) defaultModel = id;
    models.push({ id, label: isDefault ? `${id}（默认）` : id });
  }
  return { models, effortLevels: [], defaultModel };
}

/**
 * grok 主配置路径：与 ProviderStore.runtimeHome 同规约（默认 homedir()，
 * 测试/隔离环境走 CONTROL_CENTER_RUNTIME_HOME 覆盖）。
 */
export function grokConfigPath(home = process.env.CONTROL_CENTER_RUNTIME_HOME || homedir()) {
  return join(home, ".grok", "config.toml");
}

/**
 * 只解析 ~/.grok/config.toml 的 [models] 表体内 default / default_reasoning_effort 两个键。
 * 该文件 [model."x"] 段含明文 api_key——切片严格限定在 [models] 表头到下一个表头之间，
 * 绝不读取其他表的任何键；键不存在时为 null。
 */
export function parseGrokDefaults(configToml) {
  const text = String(configToml ?? "");
  const empty = { default: null, defaultEffort: null };
  // 表头行尾允许注释（TOML 规范：`[models] # comment`）——与 cli-config-panel tomlTableBody 同纪律。
  const head = text.match(/^\s*\[models\][^\S\r\n]*(#.*)?$/m);
  if (!head) return empty;
  const rest = text.slice(head.index + head[0].length);
  const end = rest.search(/^\[/m);
  const body = end === -1 ? rest : rest.slice(0, end);
  const quoted = (key) => body.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1] ?? null;
  return { default: quoted("default"), defaultEffort: quoted("default_reasoning_effort") };
}

/** config.toml 内容指纹（纳入缓存签名）；读取失败返回稳定哨兵，不新增失败模式。 */
function grokConfigFingerprint() {
  try {
    const text = readFileSync(grokConfigPath(), "utf8");
    return createHash("sha256").update(text).digest("hex").slice(0, 24);
  } catch {
    return "unreadable";
  }
}

/** claude models 输出（格式随版本漂移）：先试 JSON，再按行抓 claude-* id；全失败返回 null 走回退。 */
export function parseClaudeCatalog(raw) {
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed.models;
    if (Array.isArray(list)) {
      const models = list
        .map((entry) => (typeof entry === "string" ? entry : entry?.id ?? entry?.slug ?? entry?.name))
        .filter(Boolean)
        .map((id) => ({ id, label: id }));
      if (models.length) return { models, effortLevels: [], defaultModel: models[0].id };
    }
  } catch {
    // 非 JSON，按行抓
  }
  const ids = new Set();
  for (const match of String(raw).matchAll(/\b(claude-[a-z0-9][a-z0-9.-]{2,48}|fable|opus|sonnet|haiku)\b/gi)) {
    ids.add(match[1].toLowerCase());
  }
  if (!ids.size) return null;
  return { models: [...ids].map((id) => ({ id, label: id })), effortLevels: [], defaultModel: null };
}

/** Kimi `provider list --json` -> normalized model catalog. */
export function parseKimiCatalog(raw) {
  const parsed = JSON.parse(raw);
  const entries = parsed?.models && typeof parsed.models === "object" && !Array.isArray(parsed.models)
    ? Object.entries(parsed.models)
    : [];
  const models = entries
    .filter(([id]) => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(id))
    .map(([id, entry]) => ({
      id,
      label: String(entry?.displayName || entry?.name || id),
      ...(Number.isFinite(Number(entry?.maxContextSize)) ? { maxContextSize: Number(entry.maxContextSize) } : {}),
      ...(Array.isArray(entry?.supportEfforts) ? { nativeEffortLevels: entry.supportEfforts.map(String) } : {}),
      ...(entry?.defaultEffort ? { nativeDefaultEffort: String(entry.defaultEffort) } : {}),
    }));
  return { models, effortLevels: [], defaultModel: null };
}

/** OpenCode `models` 每行一个 provider/model。 */
export function parseOpencodeCatalog(raw) {
  const ids = [...new Set(String(raw).split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(line)))];
  return { models: ids.map((id) => ({ id, label: id })), effortLevels: [], defaultModel: null };
}

/** Pi `--list-models` 表格：provider + model 两列组合为 provider/model。 */
export function parsePiCatalog(raw) {
  const models = [];
  const seen = new Set();
  for (const line of String(raw).split(/\r?\n/)) {
    const match = /^\s*([^\s]+)\s+([^\s]+)\s+/.exec(line);
    if (!match) continue;
    if (match[1].toLowerCase() === "provider" && match[2].toLowerCase() === "model") continue;
    const id = `${match[1]}/${match[2]}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: id });
  }
  return { models, effortLevels: [], defaultModel: null };
}

export class ModelDiscovery {
  constructor({
    profiles = [],
    cacheTtlMs = CACHE_TTL_MS,
    runProcessImpl = runProcess,
    maxConcurrentDiscoveries = 4,
    maxPendingDiscoveries = 32,
  } = {}) {
    if (!Number.isSafeInteger(maxConcurrentDiscoveries) || maxConcurrentDiscoveries < 1 || maxConcurrentDiscoveries > 16) {
      throw new TypeError("model discovery concurrency must be within [1, 16]");
    }
    if (!Number.isSafeInteger(maxPendingDiscoveries) || maxPendingDiscoveries < 1 || maxPendingDiscoveries > 128) {
      throw new TypeError("model discovery pending capacity must be within [1, 128]");
    }
    this.profiles = profiles;
    this.cacheTtlMs = cacheTtlMs;
    this.runProcess = runProcessImpl;
    this.maxConcurrentDiscoveries = maxConcurrentDiscoveries;
    this.maxPendingDiscoveries = maxPendingDiscoveries;
    this.cache = new Map(); // runtimeProfileId → { at, signature, result }
    this.inFlight = new Map(); // runtimeProfileId → { signature, generation, promise }
    this.generations = new Map();
    this.globalGeneration = 0;
    this.activeDiscoveries = 0;
    this.discoveryWaiters = [];
  }

  profileOf(agentId) {
    return this.profiles.find((profile) => profile.id === agentId) ?? null;
  }

  invalidate(agentId = null) {
    if (agentId == null) {
      this.globalGeneration += 1;
      this.cache.clear();
      return;
    }
    const id = String(agentId);
    this.generations.set(id, (this.generations.get(id) || 0) + 1);
    this.cache.delete(id);
  }

  generationOf(agentId) {
    return `${this.globalGeneration}:${this.generations.get(String(agentId)) || 0}`;
  }

  signatureOf(agentId) {
    const profile = this.profileOf(agentId);
    if (!profile) return "missing";
    const parts = [profile.adapter, profile.command, profile.model, profile.modelOptions, profile.effortLevels];
    // grok 默认档位真源在 ~/.grok/config.toml：内容哈希入签名，外改配置后 5 分钟缓存不挡真值
    if (profile.adapter === "grok-build-headless") parts.push(grokConfigFingerprint());
    return JSON.stringify(parts);
  }

  async withDiscoverySlot(operation) {
    if (this.activeDiscoveries >= this.maxConcurrentDiscoveries) {
      if (this.discoveryWaiters.length >= this.maxPendingDiscoveries) {
        throw Object.assign(new Error("model discovery capacity is exhausted"), { code: "MODEL_DISCOVERY_CAPACITY" });
      }
      await new Promise((resolveSlot) => this.discoveryWaiters.push(resolveSlot));
    } else {
      this.activeDiscoveries += 1;
    }
    try {
      return await operation();
    } finally {
      const next = this.discoveryWaiters.shift();
      if (next) next();
      else this.activeDiscoveries -= 1;
    }
  }

  /** 静态回退目录（models.json 的 modelOptions/effortLevels）。 */
  fallback(agentId) {
    const profile = this.profileOf(agentId);
    return {
      models: (profile?.modelOptions ?? []).filter((option) => option.id).map((option) => ({ id: option.id, label: option.label })),
      effortLevels: profile?.effortLevels ?? [],
      defaultModel: profile?.model ?? null,
      source: "fallback",
      modelSource: "fallback",
      effortSource: profile?.effortLevels?.length ? "runtime-profile" : null,
    };
  }

  /** 某 agent 的模型/档位目录：优先 CLI 原生动态发现，失败/为空如实回退。 */
  async forAgent(agentId) {
    const id = String(agentId);
    const profile = this.profileOf(agentId);
    const signature = this.signatureOf(id);
    const generation = this.generationOf(id);
    const cached = this.cache.get(id);
    if (cached && cached.signature === signature && Date.now() - cached.at < this.cacheTtlMs) return cached.result;
    const existing = this.inFlight.get(id);
    if (existing && existing.signature === signature && existing.generation === generation) return existing.promise;

    const record = { signature, generation, promise: null };
    record.promise = (async () => {
      let result = null;
      if (profile) {
        try {
          result = await this.withDiscoverySlot(() => this.discover(profile));
        } catch (error) {
          if (error?.code === "MODEL_DISCOVERY_CAPACITY") throw error;
          result = null; // 发现失败不炸端点——回退目录兜底
        }
      }
      if (!result || !result.models.length) {
        result = this.fallback(id);
      } else {
        result = {
          ...result,
          source: "dynamic",
          modelSource: "dynamic",
          effortSource: result.effortLevels?.length ? "dynamic" : null,
        };
      }
      if (profile) result = runtimeControlCatalog(profile, result);
      if (this.signatureOf(id) === signature && this.generationOf(id) === generation) {
        this.cache.set(id, { at: Date.now(), signature, result });
      }
      return result;
    })().finally(() => {
      if (this.inFlight.get(id) === record) this.inFlight.delete(id);
    });
    this.inFlight.set(id, record);
    return record.promise;
  }

  async discover(profile) {
    if (profile.adapter === "codex-app-server" || profile.adapter === "codex-exec-json") {
      const proc = await this.runProcess(profile.command || "codex", ["debug", "models"], { timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024 });
      if (proc.code !== 0) return null;
      return parseCodexCatalog(proc.stdout);
    }
    if (profile.adapter === "grok-build-headless") {
      const proc = await this.runProcess(profile.command || "grok", ["models"], { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 });
      if (proc.code !== 0) return null;
      const catalog = parseGrokCatalog(proc.stdout);
      // 默认推理档位透出：来自 ~/.grok/config.toml [models].default_reasoning_effort；
      // 文件缺失/无该键 → null，只影响 defaultEffort，不构成新的发现失败模式。
      let defaultEffort = null;
      try {
        defaultEffort = parseGrokDefaults(readFileSync(grokConfigPath(), "utf8")).defaultEffort;
      } catch {
        defaultEffort = null;
      }
      return { ...catalog, defaultEffort };
    }
    if (profile.adapter === "claude-stream-json") {
      const proc = await this.runProcess(profile.command || "claude", ["models"], { timeoutMs: 30_000, maxOutputBytes: 512 * 1024 });
      if (proc.code !== 0) return null;
      return parseClaudeCatalog(proc.stdout);
    }
    if (profile.adapter === "kimi-headless-resume") {
      const proc = await this.runProcess(profile.command || "kimi", ["provider", "list", "--json"], {
        timeoutMs: 30_000,
        maxOutputBytes: 1024 * 1024,
      });
      if (proc.code !== 0) return null;
      return parseKimiCatalog(proc.stdout);
    }
    if (profile.adapter === "opencode-run-json") {
      const proc = await this.runProcess(profile.command || "opencode", ["models"], {
        provider: null,
        env: { OPENCODE_DISABLE_MODELS_FETCH: "1" },
        timeoutMs: 30_000,
        maxOutputBytes: 2 * 1024 * 1024,
      });
      if (proc.code !== 0) return null;
      return parseOpencodeCatalog(proc.stdout);
    }
    if (profile.adapter === "pi-rpc") {
      const proc = await this.runProcess(profile.command || "pi", ["--list-models"], {
        provider: null,
        env: { PI_OFFLINE: "1" },
        timeoutMs: 30_000,
        maxOutputBytes: 2 * 1024 * 1024,
      });
      if (proc.code !== 0) return null;
      return parsePiCatalog(proc.stdout);
    }
    return null;
  }
}
