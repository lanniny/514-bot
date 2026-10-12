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
import { runtimeControlCatalog, resolveAdapterTemplate } from "./adapters/manifest.mjs";
import { fetchProviderModels } from "./provider-net.mjs";

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
      effortLevels: (entry.supported_reasoning_levels ?? []).map((level) => level.effort).filter(Boolean),
    }));
  // 推理档位收集所有模型的支持集总和（包含全量可用档位，随 CLI 动态扩展）
  const allEfforts = new Set();
  for (const model of parsed.models ?? []) {
    for (const level of model.supported_reasoning_levels ?? []) {
      if (level?.effort) allEfforts.add(String(level.effort).trim().toLowerCase());
    }
  }
  const effortLevels = allEfforts.size
    ? [...allEfforts]
    : (parsed.models?.[0]?.supported_reasoning_levels ?? []).map((level) => level.effort).filter(Boolean);
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
  return { models, effortLevels: ["low", "medium", "high", "xhigh"], defaultModel };
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
  const claudeEfforts = ["low", "medium", "high", "xhigh", "max", "ultracode"];
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed.models;
    if (Array.isArray(list)) {
      const models = list
        .map((entry) => (typeof entry === "string" ? entry : entry?.id ?? entry?.slug ?? entry?.name))
        .filter(Boolean)
        .map((id) => ({ id, label: id, effortLevels: claudeEfforts }));
      if (models.length) return { models, effortLevels: claudeEfforts, defaultModel: models[0].id };
    }
  } catch {
    // 非 JSON，按行抓
  }
  const ids = new Set();
  for (const match of String(raw).matchAll(/\b(claude-[a-z0-9][a-z0-9.-]{2,48}|fable|opus|sonnet|haiku)\b/gi)) {
    ids.add(match[1].toLowerCase());
  }
  if (!ids.size) return null;
  return { models: [...ids].map((id) => ({ id, label: id, effortLevels: claudeEfforts })), effortLevels: claudeEfforts, defaultModel: null };
}

/** Kimi `provider list --json` -> normalized model catalog. */
export function parseKimiCatalog(raw) {
  const parsed = JSON.parse(raw);
  const entries = parsed?.models && typeof parsed.models === "object" && !Array.isArray(parsed.models)
    ? Object.entries(parsed.models)
    : [];
  const models = entries
    .filter(([id]) => /^[A-Za-z0-9@][A-Za-z0-9._:/[\]@-]{0,159}$/.test(id))
    .map(([id, entry]) => {
      const entryEfforts = Array.isArray(entry?.supportEfforts)
        ? entry.supportEfforts.map(String).map((e) => e.trim().toLowerCase()).filter(Boolean)
        : [];
      return {
        id,
        label: String(entry?.displayName || entry?.name || id),
        ...(Number.isFinite(Number(entry?.maxContextSize)) ? { maxContextSize: Number(entry.maxContextSize) } : {}),
        ...(entryEfforts.length ? { nativeEffortLevels: entryEfforts, effortLevels: entryEfforts } : {}),
        ...(entry?.defaultEffort ? { nativeDefaultEffort: String(entry.defaultEffort), defaultReasoning: String(entry.defaultEffort) } : {}),
      };
    });
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
    providerStore = null,
    cacheTtlMs = CACHE_TTL_MS,
    runProcessImpl = runProcess,
    fetchProviderModelsImpl = fetchProviderModels,
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
    this.providerStore = providerStore;
    this.cacheTtlMs = cacheTtlMs;
    this.runProcess = runProcessImpl;
    this.fetchProviderModels = fetchProviderModelsImpl;
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

  resolveProviderForProfile(profile) {
    if (!profile) return null;
    // API text seats use their explicit model list without implicit network probes
    // or fallback to a CLI's current provider/authentication.
    if (profile.adapter === "api-chat") return null;
    if (this.providerStore) {
      if (profile.providerId) {
        try {
          const p = this.providerStore.get(profile.providerId);
          if (p?.baseUrl && p?.apiKey) return p;
        } catch {}
      }
      let providerApp = null;
      try {
        const { adapterTemplate } = resolveAdapterTemplate(profile);
        providerApp = adapterTemplate?.providerApp || null;
      } catch {}
      if (providerApp) {
        const currentId = this.providerStore.current?.[providerApp];
        if (currentId) {
          try {
            const p = this.providerStore.get(currentId);
            if (p?.baseUrl && p?.apiKey) return p;
          } catch {}
        }
      }
    }
    // Claude 本地 settings.json 直出（当席位跟随当前连接时，优先认领当前活跃的 CLI 实际连接）
    if (profile.adapter === "claude-stream-json") {
      try {
        const home = this.providerStore?.runtimeHome || homedir();
        const settingsPath = join(home, ".claude", "settings.json");
        const text = readFileSync(settingsPath, "utf8");
        const data = JSON.parse(text);
        const baseUrl = data.env?.ANTHROPIC_BASE_URL;
        const apiKey = data.env?.ANTHROPIC_AUTH_TOKEN || data.env?.ANTHROPIC_API_KEY;
        if (baseUrl && apiKey) {
          const localModels = [
            data.env?.ANTHROPIC_MODEL,
            data.env?.ANTHROPIC_DEFAULT_FABLE_MODEL,
            data.env?.ANTHROPIC_DEFAULT_SONNET_MODEL,
            data.env?.ANTHROPIC_DEFAULT_OPUS_MODEL,
            data.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL,
            data.env?.CLAUDE_CODE_SUBAGENT_MODEL,
          ].filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim());
          const fableModel = data.env?.ANTHROPIC_DEFAULT_FABLE_MODEL?.trim() || null;
          const liveName = (() => { try { return new URL(baseUrl).hostname; } catch { return String(baseUrl); } })();
          return {
            id: "claude-live-settings",
            name: `当前活跃连接（${liveName}）`,
            baseUrl,
            apiKey,
            localModels: [...new Set(localModels)],
            fableModel,
          };
        }
      } catch {}
    }
    // 最后兜底：若本地没有配置反代端点，才检查注册表中同应用的候选 Provider（供单测/仅注册未切换场景使用）
    if (this.providerStore) {
      let providerApp = null;
      try {
        const { adapterTemplate } = resolveAdapterTemplate(profile);
        providerApp = adapterTemplate?.providerApp || null;
      } catch {}
      if (providerApp) {
        try {
          const providers = this.providerStore.list?.()?.providers || [];
          const candidate = providers.find((p) => p.apps?.[providerApp] && p.baseUrl);
          if (candidate) {
            const p = this.providerStore.get(candidate.id);
            if (p?.baseUrl && p?.apiKey) return p;
          }
        } catch {}
      }
    }
    return null;
  }

  async discoverFromProvider(provider, profile) {
    if (!provider?.baseUrl || !provider?.apiKey) return null;
    let templateEfforts = [];
    try {
      templateEfforts = resolveAdapterTemplate(profile).adapterTemplate?.effortLevels || [];
    } catch {}
    const effortLevels = (profile?.effortLevels?.length ? profile.effortLevels : templateEfforts) || [];
    const isFable = profile?.id === "claude-fable" || profile?.role === "primary-coordinator" || String(profile?.id || "").includes("fable");

    let fetched = null;
    try {
      fetched = await this.fetchProviderModels({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        isFullUrl: Boolean(provider.meta?.isFullUrl),
        customUserAgent: String(provider.meta?.proxyOverrides?.userAgent || ""),
      });
    } catch {
      fetched = null;
    }

    const fetchedList = fetched?.models || [];
    const localList = (provider.localModels || []).map((id) => {
      const clean = id.replace(/\[1m\]$/i, "").trim();
      return { id: clean || id, rawId: id, label: id };
    });

    const seen = new Set();
    const merged = [];

    for (const m of localList) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        merged.push({ id: m.id, label: m.label || m.id, ...(effortLevels.length ? { effortLevels } : {}) });
      }
    }

    for (const m of fetchedList) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        merged.push({
          id: m.id,
          label: m.ownedBy ? `${m.id} (${m.ownedBy})` : m.id,
          ...(effortLevels.length ? { effortLevels } : {}),
        });
      }
    }

    if (merged.length) {
      const defaultModel = (isFable && provider.fableModel)
        ? provider.fableModel.replace(/\[1m\]$/i, "").trim()
        : profile?.model || merged[0]?.id || null;
      return {
        models: merged,
        effortLevels,
        defaultModel,
        source: fetchedList.length ? "upstream-provider" : "live-settings",
        modelSource: fetchedList.length ? "upstream-provider" : "live-settings",
        providerId: provider.id,
        providerName: provider.name,
      };
    }
    return null;
  }

  signatureOf(agentId) {
    const profile = this.profileOf(agentId);
    if (!profile) return "missing";
    const parts = [profile.adapter, profile.command, profile.model, profile.modelOptions, profile.effortLevels];
    // grok 默认档位真源在 ~/.grok/config.toml：内容哈希入签名，外改配置后 5 分钟缓存不挡真值
    if (profile.adapter === "grok-build-headless") parts.push(grokConfigFingerprint());
    const provider = this.resolveProviderForProfile(profile);
    if (provider) parts.push(provider.id, provider.baseUrl);
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
          source: result.source || "dynamic",
          modelSource: result.modelSource || result.source || "dynamic",
          effortSource: result.effortLevels?.length ? (result.effortSource || "dynamic") : null,
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
    // 1. 若席位关联了 Provider（显式绑定 providerId、当前激活 current[app]、或已配置有效上游端点），
    // 优先尝试向上游 Provider 接口拉取全量真实模型列表（对应用户上游动态模型需求）
    const provider = this.resolveProviderForProfile(profile);
    if (provider) {
      const upstream = await this.discoverFromProvider(provider, profile);
      if (upstream?.models?.length) return upstream;
    }

    // 2. 尝试 CLI 原生自省发现（针对无独立 Provider 配置或上游离线时的本地 CLI 席位）
    let cliCatalog = null;
    try {
      if (profile.adapter === "codex-app-server" || profile.adapter === "codex-exec-json") {
        const proc = await this.runProcess(profile.command || "codex", ["debug", "models"], { timeoutMs: 15_000, maxOutputBytes: 4 * 1024 * 1024 });
        if (proc.code === 0) cliCatalog = parseCodexCatalog(proc.stdout);
      } else if (profile.adapter === "grok-build-headless") {
        const proc = await this.runProcess(profile.command || "grok", ["models"], { timeoutMs: 15_000, maxOutputBytes: 256 * 1024 });
        if (proc.code === 0) {
          const catalog = parseGrokCatalog(proc.stdout);
          let defaultEffort = null;
          try {
            defaultEffort = parseGrokDefaults(readFileSync(grokConfigPath(), "utf8")).defaultEffort;
          } catch {
            defaultEffort = null;
          }
          cliCatalog = { ...catalog, defaultEffort };
        }
      } else if (profile.adapter === "kimi-headless-resume") {
        const proc = await this.runProcess(profile.command || "kimi", ["provider", "list", "--json"], {
          timeoutMs: 15_000,
          maxOutputBytes: 1024 * 1024,
        });
        if (proc.code === 0) cliCatalog = parseKimiCatalog(proc.stdout);
      } else if (profile.adapter === "opencode-run-json") {
        const proc = await this.runProcess(profile.command || "opencode", ["models"], {
          provider: null,
          env: { OPENCODE_DISABLE_MODELS_FETCH: "1" },
          timeoutMs: 15_000,
          maxOutputBytes: 2 * 1024 * 1024,
        });
        if (proc.code === 0) cliCatalog = parseOpencodeCatalog(proc.stdout);
      } else if (profile.adapter === "pi-rpc") {
        const proc = await this.runProcess(profile.command || "pi", ["--list-models"], {
          provider: null,
          env: { PI_OFFLINE: "1" },
          timeoutMs: 15_000,
          maxOutputBytes: 2 * 1024 * 1024,
        });
        if (proc.code === 0) cliCatalog = parsePiCatalog(proc.stdout);
      }
    } catch {
      cliCatalog = null;
    }

    if (cliCatalog?.models?.length) return cliCatalog;

    return null;
  }
}
