// cc-switch 配置方式迁移（farion1231/cc-switch，SSOT 模式）：统一供应商档案一处录入（baseUrl+apiKey），
// 按 app 投影到各 CLI 运行时 live 配置——claude → ~/.claude/settings.json env 合并；
// codex → auth.json 合并 + config.toml 标记块外科手术；gemini → ~/.gemini/.env 标记块；
// kimi → ~/.kimi-code/config.toml 顶层 default_model + providers/models 双表标记块。
// 与 cc-switch 的差异（514cc 化）：①存储在 dataRoot/providers.json（0600，不入仓库）②apiKey 永不出服务端
// （list 只回掩码+hasApiKey，update 留空=保留）③每次切换前时间戳备份到 dataRoot/backups/providers/
// ④live 状态回读（外部改了就照实显示，current 指针不做唯一真源）⑤团队绑定扩展（applyTeamBindings）。
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import JSON5 from "json5";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { renameSyncWithRetry, renameWithRetry } from "./atomic-rename.mjs";
import { findSecretCandidates, isSensitiveKeyName, scrub } from "./redaction.mjs";
import { sanitizeStructuredText } from "./structured-redaction.mjs";

export const PROVIDER_APPS = Object.freeze([
  "claude",
  "claude-desktop",
  "codex",
  "gemini",
  "grokbuild",
  "kimi",
  "opencode",
  "openclaw",
  "hermes",
]);
export const PROVIDER_SCHEME_APPS = Object.freeze(PROVIDER_APPS.filter((app) => app !== "claude-desktop"));
export const PROVIDER_APP_LABELS = Object.freeze({
  claude: "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  gemini: "Gemini CLI",
  grokbuild: "Grok Build",
  kimi: "Kimi Code",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  hermes: "Hermes",
});
const APP_LABELS = PROVIDER_APP_LABELS;
const appMap = (factory) => Object.fromEntries(PROVIDER_APPS.map((app) => [app, factory(app)]));
const NAME_MAX = 60;
const URL_MAX = 300;
const KEY_MAX = 300;
const NOTES_MAX = 500;
const MODEL_MAX = 80;
const SCRIPT_MAX = 20000;
const COMMON_CONFIG_MAX = 8000;
const APP_CONFIG_MAX = 50000;
export const CODEX_MANAGED_CATALOG_FILENAME = "514-forge-model-catalog.json";
export const OFFICIAL_PROVIDER_SWITCH_ID = "__official__";
const CODEX_RESERVED_PROVIDER_NAME = "openai official";
const CODEX_LEGACY_OFFICIAL_PROVIDER_NAME = "OpenAI API Key (Legacy)";
const GROK_RESERVED_PROVIDER_NAME = "grok official";
const GROK_LEGACY_OFFICIAL_PROVIDER_NAME = "Grok API Key (Legacy)";
const GROK_API_BACKENDS = new Set(["chat_completions", "responses"]);
const DEFAULT_GROK_API_BACKEND = "responses";
const PROVIDER_ID_PATTERN = /^(?!.*::)(?!.*:$)[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const LEGACY_CODEX_OFFICIAL_FIELDS = new Set([
  "id", "name", "providerType", "baseUrl", "apiKey", "apps", "models", "websiteUrl", "notes",
  "icon", "iconColor", "category", "meta", "sortIndex", "createdAt", "updatedAt",
]);
const LEGACY_CODEX_OFFICIAL_META_FIELDS = new Set(["endpointAutoSelect", "costMultiplier"]);
const LEGACY_GROK_OFFICIAL_FIELDS = new Set([
  "id", "name", "providerType", "baseUrl", "apiKey", "apps", "models", "websiteUrl", "notes",
  "icon", "iconColor", "category", "meta", "sortIndex", "createdAt", "updatedAt",
]);
const LEGACY_GROK_OFFICIAL_META_FIELDS = new Set(["endpointAutoSelect", "costMultiplier", "appConfig"]);
const LEGACY_GROK_OFFICIAL_APPCONFIG_FIELDS = new Set(["profile", "apiBackend", "contextWindow", "official"]);
const TRANSACTION_RENAME_RETRY_DELAYS_MS = Object.freeze([5, 10, 20]);
const TRANSACTION_RENAME_BUDGET_MS = TRANSACTION_RENAME_RETRY_DELAYS_MS.reduce((total, value) => total + value, 0) + 2;

function isReservedCodexProvider(provider) {
  return Boolean(provider?.apps?.codex)
    && String(provider?.name ?? "").trim().toLowerCase() === CODEX_RESERVED_PROVIDER_NAME;
}

function isReservedGrokProvider(provider) {
  return Boolean(provider?.apps?.grokbuild)
    && String(provider?.name ?? "").trim().toLowerCase() === GROK_RESERVED_PROVIDER_NAME;
}

function reservedOfficialNameConflict(provider) {
  if (isReservedCodexProvider(provider)) return "OpenAI Official is a reserved Codex provider name";
  if (isReservedGrokProvider(provider)) return "Grok Official is a reserved Grok Build provider name";
  return "";
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validatePersistedProviderIds(providers) {
  const seen = new Set();
  for (const provider of providers) {
    if (!isPlainRecord(provider) || typeof provider.id !== "string" || !PROVIDER_ID_PATTERN.test(provider.id)) {
      fail("providers.json contains a provider with an invalid id", "PROVIDER_STORE_CORRUPT");
    }
    if (seen.has(provider.id)) {
      fail("providers.json contains duplicate provider ids", "PROVIDER_STORE_CORRUPT");
    }
    seen.add(provider.id);
  }
}

function isSafeLegacyCodexOfficialProvider(provider) {
  if (!isPlainRecord(provider) || !isReservedCodexProvider(provider)) return false;
  if (Object.keys(provider).some((key) => !LEGACY_CODEX_OFFICIAL_FIELDS.has(key))) return false;
  if (typeof provider.id !== "string" || !provider.id.trim()) return false;
  if (provider.category !== "official" || provider.providerType !== "custom") return false;
  if (typeof provider.baseUrl !== "string" || provider.baseUrl.trim()) return false;
  if (typeof provider.apiKey !== "string" || !provider.apiKey.trim() || provider.apiKey.length > KEY_MAX) return false;
  if (!isPlainRecord(provider.apps) || provider.apps.codex !== true) return false;
  if (Object.entries(provider.apps).some(([app, enabled]) => (
    !PROVIDER_APPS.includes(app) || typeof enabled !== "boolean" || (app !== "codex" && enabled)
  ))) return false;
  if (!isPlainRecord(provider.models) || Object.keys(provider.models).length) return false;
  if (!isPlainRecord(provider.meta)
    || Object.keys(provider.meta).some((key) => !LEGACY_CODEX_OFFICIAL_META_FIELDS.has(key))) return false;
  if (Object.hasOwn(provider.meta, "endpointAutoSelect") && typeof provider.meta.endpointAutoSelect !== "boolean") return false;
  if (Object.hasOwn(provider.meta, "costMultiplier")) {
    const multiplier = provider.meta.costMultiplier;
    if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 1000) return false;
  }
  if (String(provider.notes ?? "").trim()) return false;
  if (!["", "https://chatgpt.com/codex", "https://chatgpt.com/codex/"].includes(String(provider.websiteUrl ?? "").trim())) return false;
  if (!["", "openai"].includes(String(provider.icon ?? "").trim().toLowerCase())) return false;
  if (!["", "#00a67e"].includes(String(provider.iconColor ?? "").trim().toLowerCase())) return false;
  if (provider.sortIndex !== undefined && !Number.isInteger(provider.sortIndex)) return false;
  for (const field of ["createdAt", "updatedAt"]) {
    if (provider[field] !== undefined && typeof provider[field] !== "string") return false;
  }
  return true;
}

function isSafeLegacyGrokOfficialProvider(provider) {
  if (!isPlainRecord(provider) || !isReservedGrokProvider(provider)) return false;
  if (Object.keys(provider).some((key) => !LEGACY_GROK_OFFICIAL_FIELDS.has(key))) return false;
  if (typeof provider.id !== "string" || !provider.id.trim()) return false;
  if (provider.category !== "official" || provider.providerType !== "custom") return false;
  if (typeof provider.baseUrl !== "string" || provider.baseUrl.trim()) return false;
  if (typeof provider.apiKey !== "string" || provider.apiKey.length > KEY_MAX) return false;
  if (!isPlainRecord(provider.apps) || provider.apps.grokbuild !== true) return false;
  if (Object.entries(provider.apps).some(([app, enabled]) => (
    !PROVIDER_APPS.includes(app) || typeof enabled !== "boolean" || (app !== "grokbuild" && enabled)
  ))) return false;
  if (!isPlainRecord(provider.models)) return false;
  if (Object.keys(provider.models).some((app) => app !== "grokbuild")) return false;
  if (provider.models.grokbuild && (!isPlainRecord(provider.models.grokbuild)
    || Object.keys(provider.models.grokbuild).some((key) => key !== "model")
    || (provider.models.grokbuild.model !== undefined && typeof provider.models.grokbuild.model !== "string"))) {
    return false;
  }
  if (provider.meta != null) {
    if (!isPlainRecord(provider.meta)
      || Object.keys(provider.meta).some((key) => !LEGACY_GROK_OFFICIAL_META_FIELDS.has(key))) return false;
    if (Object.hasOwn(provider.meta, "endpointAutoSelect") && typeof provider.meta.endpointAutoSelect !== "boolean") return false;
    if (Object.hasOwn(provider.meta, "costMultiplier")) {
      const multiplier = provider.meta.costMultiplier;
      if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 1000) return false;
    }
    if (Object.hasOwn(provider.meta, "appConfig")) {
      if (!isPlainRecord(provider.meta.appConfig)) return false;
      if (Object.keys(provider.meta.appConfig).some((app) => app !== "grokbuild")) return false;
      const grokConfig = provider.meta.appConfig.grokbuild;
      if (grokConfig != null) {
        if (!isPlainRecord(grokConfig)
          || Object.keys(grokConfig).some((key) => !LEGACY_GROK_OFFICIAL_APPCONFIG_FIELDS.has(key))) return false;
        if (Object.hasOwn(grokConfig, "official") && grokConfig.official !== true) return false;
      }
    }
  }
  if (String(provider.notes ?? "").trim()) return false;
  if (!["", "https://x.ai/grok", "https://x.ai/grok/"].includes(String(provider.websiteUrl ?? "").trim())) return false;
  if (!["", "grok"].includes(String(provider.icon ?? "").trim().toLowerCase())) return false;
  if (!["", "currentcolor"].includes(String(provider.iconColor ?? "").trim().toLowerCase())) return false;
  if (provider.sortIndex !== undefined && !Number.isInteger(provider.sortIndex)) return false;
  for (const field of ["createdAt", "updatedAt"]) {
    if (provider[field] !== undefined && typeof provider[field] !== "string") return false;
  }
  return true;
}

/** 官方登录态 = 没有自定义模型表痕迹。允许空文档、注释和 [mcp_servers] 等其它内容。 */
export function isGrokOfficialLiveConfig(configToml) {
  const text = String(configToml ?? "");
  if (!text.trim()) return true;
  if (/# >>> 514-forge-grokbuild-provider/.test(text)) return false;
  return !/^\s*\[models(?:\.|\])/m.test(text) && !/^\s*\[model(?:\.|\])/m.test(text);
}

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** TOML 表体切片：表头行之后到下一个表头（或文件尾）为止。headerLiteral 传表头原文（不含方括号）。 */
function tomlTableBody(text, headerLiteral) {
  const head = String(text).match(new RegExp(`^\\[${escapeRegExp(headerLiteral)}\\][^\\S\\r\\n]*$`, "m"));
  if (!head) return null;
  const rest = String(text).slice(head.index + head[0].length);
  const end = rest.search(/^\[/m);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Grok live 配置回读：以 [models].default 指向的 [model."<档位>"] 表为真源。
 * 不能用"文件里第一个 model =" 猜——存在多张 [model."x"] 表时首匹配会认错档位，
 * 把非生效档位的模型当成 live 值上报（LO 2026-08-13：live 已是 grok-4.6，界面仍显示 4.5 的同类失真面）。
 * [models].default 缺席时退回文件里第一张 [model."x"] 表，仍比全局首匹配可靠。
 */
export function parseGrokLiveConfig(configToml) {
  const text = String(configToml ?? "");
  const empty = { profile: null, model: null, baseUrl: null, name: null, apiBackend: null, contextWindow: null };
  if (!text.trim()) return empty;
  const profile = tomlTableBody(text, "models")?.match(/^\s*default\s*=\s*"([^"]+)"/m)?.[1]
    ?? text.match(/^\s*\[model\."((?:[^"\\]|\\.)+)"\][^\S\r\n]*$/m)?.[1]
    ?? null;
  if (!profile) return empty;
  const body = tomlTableBody(text, `model."${profile}"`);
  if (body == null) return { ...empty, profile };
  const str = (key) => body.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1] ?? null;
  const contextRaw = body.match(/^\s*context_window\s*=\s*(\d+)/m)?.[1] ?? null;
  return {
    profile,
    model: str("model"),
    baseUrl: str("base_url"),
    name: str("name"),
    apiBackend: str("api_backend"),
    contextWindow: contextRaw == null ? null : Number(contextRaw),
  };
}

const normalizeDriftUrl = (value) => String(value).trim().replace(/\/+$/, "");

/**
 * live ↔ 档案 漂移比对字段谱：live 回读到的值与档案存的值不一致时，界面必须照实说出来。
 * stored 取档案的"投影后应得值"（含默认值补齐），这样 live 与档案真一致时不会假报漂移。
 */
const PROVIDER_LIVE_DRIFT_FIELDS = Object.freeze({
  claude: [
    { key: "model", label: "默认模型", stored: (p) => p.models?.claude?.model || null },
    { key: "baseUrl", label: "API 请求地址", stored: (p) => p.baseUrl || null, normalize: normalizeDriftUrl },
  ],
  codex: [
    { key: "model", label: "默认模型", stored: (p) => p.models?.codex?.model || null },
    { key: "baseUrl", label: "API 请求地址", stored: (p) => p.baseUrl || null, normalize: normalizeDriftUrl },
  ],
  gemini: [
    { key: "model", label: "默认模型", stored: (p) => p.models?.gemini?.model || null },
    { key: "baseUrl", label: "API 请求地址", stored: (p) => p.baseUrl || null, normalize: normalizeDriftUrl },
  ],
  grokbuild: [
    // 回落链必须与对话框「客户端模型档位」一致（profile → 模型 → 名称派生 key），
    // 否则通知条的「档案值」会是界面从未显示过的值，「改回档案值」等于凭空塞新内容。
    { key: "profile", label: "客户端模型档位", stored: (p) => p.meta?.appConfig?.grokbuild?.profile || p.models?.grokbuild?.model || providerKeyOf(p, "grokbuild") },
    { key: "model", label: "默认模型", stored: (p) => p.models?.grokbuild?.model || p.models?.claude?.model || "grok-4.5" },
    { key: "apiBackend", label: "API Backend", stored: (p) => p.meta?.appConfig?.grokbuild?.apiBackend || DEFAULT_GROK_API_BACKEND },
    { key: "contextWindow", label: "上下文窗口", stored: (p) => p.meta?.appConfig?.grokbuild?.contextWindow ?? 500000 },
    { key: "baseUrl", label: "API 请求地址", stored: (p) => p.baseUrl || null, normalize: normalizeDriftUrl },
  ],
  kimi: [
    { key: "model", label: "默认模型", stored: (p) => p.models?.kimi?.model || null },
    { key: "baseUrl", label: "API 请求地址", stored: (p) => p.baseUrl || null, normalize: normalizeDriftUrl },
  ],
  opencode: [
    { key: "model", label: "默认模型", stored: (p) => p.models?.opencode?.model || null },
    { key: "baseUrl", label: "API 请求地址", stored: (p) => p.baseUrl || null, normalize: normalizeDriftUrl },
  ],
  openclaw: [
    { key: "model", label: "默认模型", stored: (p) => p.models?.openclaw?.model || null },
    { key: "baseUrl", label: "API 请求地址", stored: (p) => p.baseUrl || null, normalize: normalizeDriftUrl },
  ],
  hermes: [
    { key: "model", label: "默认模型", stored: (p) => p.models?.hermes?.model || null },
    { key: "baseUrl", label: "API 请求地址", stored: (p) => p.baseUrl || null, normalize: normalizeDriftUrl },
  ],
});

/**
 * 单档案的 live 漂移清单。live 侧读不到（null/undefined）的字段一律跳过——
 * 读不到不等于不一致，凭"读不到"报漂移会把界面变成狼来了。
 */
export function providerLiveDrift(app, provider, liveInfo) {
  const spec = PROVIDER_LIVE_DRIFT_FIELDS[app];
  if (!spec || !provider || !isPlainRecord(liveInfo) || liveInfo.official) return [];
  const drift = [];
  for (const field of spec) {
    const live = liveInfo[field.key];
    if (live == null || live === "") continue;
    let stored;
    try {
      stored = field.stored(provider);
    } catch {
      continue;
    }
    if (stored == null || stored === "") continue;
    const shape = field.normalize ?? ((value) => (typeof value === "number" ? value : String(value).trim()));
    if (shape(live) === shape(stored)) continue;
    drift.push({ field: field.key, label: field.label, live, stored });
  }
  return drift;
}

const MODEL_KEYS_BY_APP = Object.freeze({
  claude: new Set([
    "model", "model1m",
    ...["haiku", "sonnet", "opus", "fable", "subagent"].flatMap((role) => [
      `${role}Model`, `${role}Model1m`, `${role}ModelName`,
    ]),
  ]),
  codex: new Set(["model", "reasoningEffort"]),
  gemini: new Set(["model"]),
  "claude-desktop": new Set(["model"]),
  grokbuild: new Set(["model"]),
  kimi: new Set(["model"]),
  opencode: new Set(["model"]),
  openclaw: new Set(["model"]),
  hermes: new Set(["model"]),
});

// cc-switch provider.rs ProviderMeta / category 白名单移植
const PROVIDER_CATEGORIES = new Set(["official", "cn_official", "cloud_provider", "aggregator", "third_party", "custom", "omo", "omo-slim"]);
const API_KEY_FIELDS = new Set(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]);
const USAGE_TEMPLATE_TYPES = new Set(["custom", "general", "new-api"]);
const PROXY_TYPES = new Set(["http", "https", "socks5"]);
const ENDPOINT_MAX = 24;
// cc-switch 3.18 预设目录移植面：apiFormat 决定 codex wire_api（openai_chat→chat，其余→responses）
const API_FORMATS = new Set(["anthropic", "openai_chat", "openai_responses", "gemini_native"]);
// codexTop/codexProviderExtra 键白名单 = cc-switch 3.18 全 66 预设出现键的封闭并集；
// 顶层键必须封闭——投影按此表发 removal（值缺省=摘行），任意键会在切换后残留。
const CODEX_TOP_KEYS = new Set(["review_model", "disable_response_storage", "model_verbosity", "personality"]);
const CODEX_PROVIDER_EXTRA_KEYS = new Set(["env_key", "query_params", "model_context_window", "model_auto_compact_token_limit"]);
// opencode 自定义供应商的 AI SDK 适配器缺省映射（apiFormat → npm 包；预设 settingsConfig 显式给出的优先）
const OPENCODE_NPM_BY_FORMAT = { anthropic: "@ai-sdk/anthropic", openai_chat: "@ai-sdk/openai-compatible", openai_responses: "@ai-sdk/openai-compatible", gemini_native: "@ai-sdk/google" };
// Kimi Code provider type（官方文档 kimi-code-cli/configuration/providers.html 封闭集）；
// 缺省按 meta.apiFormat 映射，第三方兼容服务兜底 openai（OpenAI Chat Completions 是公共分母）。
const KIMI_PROVIDER_TYPES = new Set(["kimi", "anthropic", "openai", "openai_responses", "google-genai", "vertexai"]);
const KIMI_TYPE_BY_API_FORMAT = Object.freeze({ anthropic: "anthropic", openai_chat: "openai", openai_responses: "openai_responses", gemini_native: "google-genai" });
// [models.<alias>] capabilities 可声明标签（官方 config-files.html 封闭集）
const KIMI_MODEL_CAPABILITIES = new Set(["thinking", "always_thinking", "image_in", "video_in", "audio_in", "tool_use"]);
const EXTRA_ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const SETTINGS_KEY = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const SETTINGS_FORBIDDEN = new Set(["env", "__proto__", "constructor", "prototype"]);
// proxyOverrides（本地代理接管时对上游请求的档案级覆盖）：Header 键 = RFC token；
// 认证/协议/传输头禁覆——覆了协议转换必坏，校验期直接拒。
const PROXY_OVERRIDE_HEADER_KEY = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const PROXY_OVERRIDE_FORBIDDEN_HEADERS = new Set(["authorization", "x-api-key", "content-type", "accept", "anthropic-version", "host", "content-length", "connection"]);

const CLAUDE_MANAGED_KEYS = Object.freeze([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
]);

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function cleanText(value, label, max) {
  const text = String(value ?? "").trim();
  if (text.length > max) fail(`${label} exceeds ${max} characters`, "VALIDATION_FAILED");
  return text;
}

function clampInt(value, min, max, fallback, label = "value") {
  if (value === undefined || value === null || value === "") return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) fail(`${label} must be a number within [${min}, ${max}]`, "VALIDATION_FAILED");
  return Math.min(max, Math.max(min, Math.round(num)));
}

function maskKey(key) {
  const text = String(key ?? "");
  if (!text) return "";
  if (text.length <= 4) return "••••";
  return `••••${text.slice(-4)}`;
}

const SAFE_SECRET_REFERENCE = /^(?:\$\{[A-Z0-9_]+\}|\$env:[A-Z0-9_]+|\$[A-Z_][A-Z0-9_]*|%[A-Z0-9_]+%|(?:env|credential):[A-Z0-9_.-]+)$/i;

function isSafeSecretReference(key, value) {
  const text = String(value ?? "");
  if (SAFE_SECRET_REFERENCE.test(text)) return true;
  return key === "apiKeyField" && API_KEY_FIELDS.has(text);
}

function structuredSecretKey(key) {
  const name = String(key ?? "");
  if (/masked$/i.test(name) || /^has(?:[A-Z_]|$)/.test(name)) return false;
  return isSensitiveKeyName(name);
}

function maskStructuredSecrets(value, key = "", inheritedSensitive = false) {
  const sensitive = inheritedSensitive || structuredSecretKey(key);
  if (typeof value === "string") {
    if (sensitive && value && !isSafeSecretReference(key, value)) return "[REDACTED]";
    return scrub(value);
  }
  if (Array.isArray(value)) return value.map((item) => maskStructuredSecrets(item, "", sensitive));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      maskStructuredSecrets(childValue, childKey, sensitive),
    ]),
  );
}

function maskCommonConfig(app, value) {
  const text = String(value ?? "");
  if (!text.trim()) return text;
  const structured = sanitizeStructuredText(text, {
    sanitizeValue: maskStructuredSecrets,
    scrubText: scrub,
    isSensitiveKey: structuredSecretKey,
    serializeJson: (sanitized) => JSON.stringify(sanitized, null, 2),
    serializeYaml: (sanitized) => stringifyYaml(sanitized),
    invalidMarker: "[REDACTED INVALID STRUCTURED CONFIG]",
  });
  if (structured != null) return structured;
  if (text.split(/\r?\n/).some((line) => {
    const match = /^\s*["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*[:=]/.exec(line);
    return match && structuredSecretKey(match[1]);
  })) return "[REDACTED INVALID STRUCTURED CONFIG]";
  return scrub(text);
}

function publicCommonConfig(commonConfig) {
  return Object.fromEntries(PROVIDER_APPS.map((app) => [app, maskCommonConfig(app, commonConfig?.[app])]));
}

/** apiKey 永不出服务端（烛式密钥面）：对外只给掩码 + 有无标记。meta 内的敏感字段同律。 */
function publicView(provider) {
  const fields = [
    "id", "name", "providerType", "baseUrl", "apps", "models", "websiteUrl", "notes",
    "icon", "iconColor", "category", "meta", "sortIndex", "createdAt", "updatedAt",
  ];
  const rest = Object.fromEntries(fields.filter((field) => Object.hasOwn(provider, field)).map((field) => [field, provider[field]]));
  const safe = maskStructuredSecrets({ ...rest, meta: maskMetaSecrets(provider.meta) });
  return {
    ...safe,
    baseUrl: scrub(rest.baseUrl ?? ""),
    websiteUrl: scrub(rest.websiteUrl ?? ""),
    notes: scrub(rest.notes ?? ""),
    hasApiKey: Boolean(provider.apiKey),
    apiKeyMasked: maskKey(provider.apiKey),
  };
}

/** meta.usageScript.apiKey/accessToken、meta.proxyConfig.password 与主 apiKey 同级敏感。 */
function maskMetaSecrets(meta) {
  if (!meta || typeof meta !== "object") return meta ?? null;
  const clone = JSON.parse(JSON.stringify(meta));
  let usageSecrets = null;
  let proxyHasPassword = false;
  if (clone.usageScript && typeof clone.usageScript === "object") {
    const script = clone.usageScript;
    usageSecrets = { apiKey: script.apiKey, accessToken: script.accessToken };
    delete script.apiKey;
    delete script.accessToken;
    if (typeof script.code === "string") script.code = scrub(script.code);
    if (typeof script.baseUrl === "string") script.baseUrl = scrub(script.baseUrl);
  }
  if (clone.proxyConfig && typeof clone.proxyConfig === "object") {
    proxyHasPassword = Boolean(clone.proxyConfig.password);
    delete clone.proxyConfig.password;
  }
  if (clone.customEndpoints && Array.isArray(clone.customEndpoints)) {
    clone.customEndpoints = clone.customEndpoints.map((entry) => ({
      ...entry,
      url: scrub(entry?.url ?? ""),
    }));
  }
  if (clone.proxyOverrides && typeof clone.proxyOverrides === "object") {
    const overrides = clone.proxyOverrides;
    if (typeof overrides.userAgent === "string") overrides.userAgent = scrub(overrides.userAgent);
    if (overrides.headers && typeof overrides.headers === "object") {
      overrides.headers = Object.fromEntries(
        Object.entries(overrides.headers).map(([key, value]) => [key, maskStructuredSecrets(value, key)]),
      );
    }
    if (overrides.body && typeof overrides.body === "object") {
      overrides.body = maskStructuredSecrets(overrides.body);
    }
  }
  if (clone.appConfig && typeof clone.appConfig === "object") {
    clone.appConfig = maskStructuredSecrets(clone.appConfig);
  }
  for (const field of ["extraEnv", "extraSettings", "codexTop", "codexProviderExtra"]) {
    if (clone[field] && typeof clone[field] === "object") clone[field] = maskStructuredSecrets(clone[field]);
  }
  // rawConfig 手改原文含完整配置（可能带密钥）：不出服务端，只回「哪些应用哪些文件被手改」
  if (clone.rawConfig && typeof clone.rawConfig === "object") {
    clone.rawConfigPaths = Object.fromEntries(
      Object.entries(clone.rawConfig).map(([app, files]) => [app, Object.keys(files ?? {})]),
    );
    delete clone.rawConfig;
  }
  const safe = maskStructuredSecrets(clone);
  if (safe.usageScript && usageSecrets) {
    safe.usageScript.hasApiKey = Boolean(usageSecrets.apiKey);
    safe.usageScript.apiKeyMasked = maskKey(usageSecrets.apiKey);
    safe.usageScript.hasAccessToken = Boolean(usageSecrets.accessToken);
    safe.usageScript.accessTokenMasked = maskKey(usageSecrets.accessToken);
  }
  if (safe.proxyConfig) safe.proxyConfig.hasPassword = proxyHasPassword;
  return safe;
}

/** 配置预览回显的密钥面：完整文件内容可出，但疑似密钥值一律掩码（••••last4）。
    覆盖 JSON "k":"v"、TOML/env k=v、YAML k: v 三种行形态；sk-/ace_ 明文长串无论落点横扫。 */
const SECRET_KEY_RE = /(token|secret|password|api[-_]?key|apikey|auth[-_]?token|authorization)/i;

function looksSecretValue(value) {
  const text = String(value ?? "").trim();
  if (text.length < 8) return false;
  if (/^(true|false|null|bearer|basic)$/i.test(text)) return false;
  if (/^\d+(\.\d+)?$/.test(text)) return false;
  if (/^[A-Z][A-Z0-9_]*$/.test(text)) return false; // env_key = "OPENAI_API_KEY" 这类变量名不是密钥
  if (text === "<redacted>") return false;
  return true;
}

function maskPlainConfigSecrets(content) {
  const masked = String(content ?? "")
    // JSON / YAML 引号对："key": "value"
    .replace(/("(?:[^"\\]|\\.)*"\s*:\s*)"([^"\\]*)"/g, (all, head, value) => {
      const key = head.slice(head.indexOf('"') + 1, head.lastIndexOf('"'));
      return SECRET_KEY_RE.test(key) && looksSecretValue(value) ? `${head}"${maskKey(value)}"` : all;
    })
    // TOML / dotenv：key = "value" | key = 'value' | KEY=value（行首键）
    .replace(/^(\s*[A-Za-z_][A-Za-z0-9_.\-]*\s*=\s*)("([^"]*)"|'([^']*)'|([^\s#]+))/gm, (all, prefix, raw, dq, sq, bare) => {
      const key = prefix.replace(/=\s*$/, "").trim();
      const value = dq ?? sq ?? bare ?? "";
      if (!SECRET_KEY_RE.test(key) || !looksSecretValue(value)) return all;
      if (dq != null) return `${prefix}"${maskKey(value)}"`;
      if (sq != null) return `${prefix}'${maskKey(value)}'`;
      return `${prefix}${maskKey(value)}`;
    })
    // YAML 无引号：key: value
    .replace(/^(\s*-?\s*[A-Za-z_][A-Za-z0-9_.\-]*:\s*)(?!["'{[])([^\s#][^#]*?)\s*$/gm, (all, prefix, value) => {
      const key = prefix.replace(/:\s*$/, "").replace(/^-?\s*/, "").trim();
      return SECRET_KEY_RE.test(key) && looksSecretValue(value) ? `${prefix}${maskKey(value)}` : all;
    });
  // 明文横扫：sk-/ace_ 开头的长串无论落点一律掩码（数组元素、注释残留等）
  return masked.replace(/\b(?:sk-[A-Za-z0-9_\-]{12,}|ace_[A-Za-z0-9]{16,})\b/g, (all) => maskKey(all));
}

function maskStructuredPreviewSecrets(value, key = "", inheritedSensitive = false) {
  const sensitive = inheritedSensitive || structuredSecretKey(key);
  if (typeof value === "string") {
    if (sensitive && value && !isSafeSecretReference(key, value)) return maskKey(value);
    return scrub(value);
  }
  if (Array.isArray(value)) return value.map((item) => maskStructuredPreviewSecrets(item, "", sensitive));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
    childKey,
    maskStructuredPreviewSecrets(childValue, childKey, sensitive),
  ]));
}

function hasMultilineSensitiveAssignment(content) {
  return String(content ?? "").split(/\r?\n/).some((line) => {
    const match = /^\s*["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*=\s*(.*)$/.exec(line);
    if (!match || !structuredSecretKey(match[1])) return false;
    const value = match[2].trim();
    return value === "" || value === "[" || value === "{";
  });
}

export function maskConfigSecrets(content) {
  const text = String(content ?? "");
  if (hasMultilineSensitiveAssignment(text)) return "[REDACTED SENSITIVE CONFIG BLOCK]";
  const structured = sanitizeStructuredText(text, {
    sanitizeValue: maskStructuredPreviewSecrets,
    scrubText: maskPlainConfigSecrets,
    isSensitiveKey: structuredSecretKey,
    serializeJson: (sanitized, source) => /\r|\n/.test(source)
      ? JSON.stringify(sanitized, null, 2)
      : JSON.stringify(sanitized),
    serializeYaml: (sanitized) => stringifyYaml(sanitized),
    invalidMarker: "[REDACTED INVALID STRUCTURED CONFIG]",
  });
  return structured ?? maskPlainConfigSecrets(text);
}

/** rawConfig（配置预览手改原文）：路径白名单（~ 相对 runtimeHome 或绝对路径）与单文件体积上限。 */
const RAW_CONFIG_PATH = /^(~\/.+|[A-Za-z]:[\\/].+|\/.+)$/;
const RAW_CONFIG_MAX = 100_000;

/** rawConfig 补丁合并：字符串=覆盖/新增，null=删除路径/整应用，未提及保留。create/update/preview 三处同律。
    validate=false（预览干跑）：只做合并不做内容校验——用户正在键入的半成品不能打断预览。 */
function mergeRawConfigPatch(existing, patch, { validate = true } = {}) {
  const merged = {};
  for (const [app, files] of Object.entries(existing ?? {})) merged[app] = { ...files };
  for (const [app, files] of Object.entries(patch ?? {})) {
    if (!PROVIDER_APPS.includes(app)) fail(`meta.rawConfig has unknown app: ${app}`, "VALIDATION_FAILED");
    if (files === null) { delete merged[app]; continue; }
    if (typeof files !== "object" || Array.isArray(files)) fail(`meta.rawConfig.${app} must be an object`, "VALIDATION_FAILED");
    merged[app] = merged[app] ?? {};
    for (const [path, text] of Object.entries(files)) {
      if (text === null) { delete merged[app][path]; continue; }
      if (!RAW_CONFIG_PATH.test(path) || path.length > 300) fail(`meta.rawConfig path not allowed: ${path}`, "VALIDATION_FAILED");
      const body = String(text ?? "");
      if (!body.trim()) {
        if (validate) fail(`meta.rawConfig.${app}.${path} must be non-empty (use null to remove)`, "VALIDATION_FAILED");
        delete merged[app][path];
        continue;
      }
      if (validate) {
        if (body.length > RAW_CONFIG_MAX) fail(`meta.rawConfig.${app}.${path} exceeds ${RAW_CONFIG_MAX} characters`, "VALIDATION_FAILED");
        if (/\0/.test(body)) fail(`meta.rawConfig.${app}.${path} contains NUL`, "VALIDATION_FAILED");
        if (/\.json5?$/i.test(path)) {
          try { JSON5.parse(body); } catch { fail(`meta.rawConfig.${app}.${path} is not valid JSON`, "INVALID_RAW_JSON"); }
        }
      }
      merged[app][path] = body;
    }
    if (!Object.keys(merged[app]).length) delete merged[app];
  }
  return Object.keys(merged).length ? merged : null;
}

function cloneBoundedAppConfig(value, path = "appConfig", depth = 0) {
  if (depth > 8) fail(`${path} exceeds maximum nesting depth`, "VALIDATION_FAILED");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${path} must contain finite numbers`, "VALIDATION_FAILED");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 8000) fail(`${path} string exceeds 8000 characters`, "VALIDATION_FAILED");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 200) fail(`${path} exceeds 200 array entries`, "VALIDATION_FAILED");
    return value.map((item, index) => cloneBoundedAppConfig(item, `${path}[${index}]`, depth + 1));
  }
  if (!value || typeof value !== "object") fail(`${path} contains an unsupported value`, "VALIDATION_FAILED");
  const entries = Object.entries(value);
  if (entries.length > 200) fail(`${path} exceeds 200 keys`, "VALIDATION_FAILED");
  const clone = {};
  for (const [key, item] of entries) {
    if (!key || key.length > 100 || ["__proto__", "constructor", "prototype"].includes(key)) {
      fail(`${path} contains a forbidden key`, "VALIDATION_FAILED");
    }
    if (/^(api[_-]?key|token|password|secret|client_secret|access_token|refresh_token)$/i.test(key) && typeof item === "string" && item) {
      const placeholder = /^\$\{[^}]+\}$|^\{\{[^}]+\}\}$/.test(item);
      if (!placeholder) fail(`${path}.${key} must use the provider apiKey field instead of embedding a secret`, "VALIDATION_FAILED");
    }
    clone[key] = cloneBoundedAppConfig(item, `${path}.${key}`, depth + 1);
  }
  return clone;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(target, source) {
  const output = isPlainObject(target) ? { ...target } : {};
  if (!isPlainObject(source)) return output;
  for (const [key, value] of Object.entries(source)) {
    output[key] = isPlainObject(value) ? deepMerge(output[key], value) : JSON.parse(JSON.stringify(value));
  }
  return output;
}

function providerKeyOf(provider, app) {
  const configured = provider.meta?.appConfig?.[app]?.providerKey;
  const raw = String(configured || provider.name || provider.id).trim().toLowerCase();
  const normalized = raw.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return normalized || provider.id.slice(0, 80);
}

function replaceProviderPlaceholders(value, provider) {
  if (Array.isArray(value)) return value.map((entry) => replaceProviderPlaceholders(entry, provider));
  if (!isPlainObject(value)) return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/^(apiKey|api_key)$/i.test(key) && (entry === "" || entry === "<redacted>")) result[key] = provider.apiKey || "";
    else if (/^(baseUrl|baseURL|base_url)$/i.test(key) && entry === "") result[key] = provider.baseUrl || "";
    else result[key] = replaceProviderPlaceholders(entry, provider);
  }
  return result;
}

function spliceManagedBlock(original, app, blockId, lines) {
  const start = `# >>> 514-forge-${app}-provider`;
  const end = `# <<< 514-forge-${app}-provider <<<`;
  const kept = [];
  let skipping = false;
  for (const line of String(original ?? "").split(/\r?\n/)) {
    if (line.startsWith(start)) {
      skipping = true;
      continue;
    }
    if (skipping && line.trim() === end) {
      skipping = false;
      continue;
    }
    if (!skipping) kept.push(line);
  }
  const trimmed = kept.join("\n").replace(/\s+$/g, "");
  if (!lines.length) return `${trimmed}${trimmed ? "\n" : ""}`;
  const block = [`${start} (${blockId}) >>>`, ...lines, end].join("\n");
  return `${trimmed ? `${trimmed}\n\n` : ""}${block}\n`;
}

/**
 * Grok config.toml 里 Console 拥有的表命名空间：[models] 与 [model."*"]。
 * 投影时块外的同命名空间表必须先摘掉——不摘就会和管理块内的表构成 TOML 重复表定义（规范里非法），
 * 或让块外旧表遮盖新投影，表现为"点了启用不生效"。
 * 其余表（features / plugins / compat.* / ui / marketplace / mcp_servers…）一概不动。
 */
export function stripGrokModelTables(text) {
  const kept = [];
  let dropping = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    // 表头行决定归属；管理块标记是注释，不参与归属判断
    if (/^\s*\[/.test(line)) dropping = /^\s*\[models?(?:\]|\.)/.test(line);
    if (!dropping) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/g, "");
}

/** cc-switch proxyConfig → 代理 URL（投影到 claude env.HTTPS_PROXY / gemini .env）。 */
export function proxyUrlOf(proxy) {
  if (!proxy?.enabled || !proxy.host) return "";
  const scheme = PROXY_TYPES.has(proxy.proxyType) ? proxy.proxyType : "http";
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}${proxy.password ? `:${encodeURIComponent(proxy.password)}` : ""}@`
    : "";
  const port = Number(proxy.port) || (scheme === "socks5" ? 1080 : 8080);
  return `${scheme}://${auth}${proxy.host}:${port}`;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").slice(0, 15);
}

/** cc-switch to_codex_provider 的 base_url 规则移植：纯 origin 补 /v1；已带路径/版本的不强行补。 */
export function codexBaseUrl(baseUrl) {
  const trimmed = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.endsWith("/v1")) return trimmed;
  const rest = trimmed.split("://")[1] ?? trimmed;
  return rest.includes("/") ? trimmed : `${trimmed}/v1`;
}

function codexCatalogPointer(configText) {
  const lines = String(configText ?? "").split(/\r?\n/);
  const topEnd = lines.findIndex((line) => /^\s*\[/.test(line));
  const top = lines.slice(0, topEnd === -1 ? lines.length : topEnd);
  const line = top.find((entry) => /^\s*model_catalog_json\s*=/.test(entry));
  if (!line) return null;
  const match = /^\s*model_catalog_json\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
  if (!match) fail("existing Codex model_catalog_json is not a supported quoted path", "CODEX_MODEL_CATALOG_CONFLICT");
  return match[1] ?? match[2] ?? "";
}

function isManagedCodexCatalogPointer(value) {
  return String(value ?? "").split(/[\\/]/).at(-1) === CODEX_MANAGED_CATALOG_FILENAME;
}

const CODEX_REASONING_LEVELS = Object.freeze(["none", "low", "medium", "high", "xhigh", "max", "ultra"]);
const CODEX_CATALOG_BASE_INSTRUCTIONS = "You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user's goals.";

function codexContextWindow(value, fallback = 128000) {
  const parsed = Number(String(value ?? "").replace(/^['"]|['"]$/g, ""));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Codex >= 0.144.5 external-catalog parser requires a complete ModelInfo shape. */
export function buildCodexModelCatalog(modelCatalog = [], { reasoningEffort = "high", defaultContextWindow = 128000 } = {}) {
  const defaultEffort = CODEX_REASONING_LEVELS.includes(reasoningEffort) ? reasoningEffort : "high";
  const seen = new Set();
  const models = [];
  for (const [index, row] of modelCatalog.entries()) {
    const slug = String(row?.model ?? "").trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const displayName = String(row?.displayName ?? "").trim() || slug;
    const contextWindow = codexContextWindow(row?.contextWindow, codexContextWindow(defaultContextWindow));
    models.push({
      slug,
      display_name: displayName,
      description: displayName,
      base_instructions: CODEX_CATALOG_BASE_INSTRUCTIONS,
      default_reasoning_level: defaultEffort,
      supported_reasoning_levels: CODEX_REASONING_LEVELS.map((effort) => ({ effort, description: effort === "none" ? "Disable reasoning" : `${effort} reasoning` })),
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: 1000 + index,
      additional_speed_tiers: [],
      service_tiers: [],
      availability_nux: null,
      upgrade: null,
      supports_reasoning_summaries: true,
      default_reasoning_summary: "none",
      support_verbosity: false,
      truncation_policy: { mode: "bytes", limit: 10000 },
      supports_parallel_tool_calls: false,
      supports_image_detail_original: false,
      context_window: contextWindow,
      max_context_window: contextWindow,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ["text", "image"],
      supports_search_tool: false,
    });
  }
  return { models };
}

function hasCodexOauthTokenMaterial(auth) {
  if (auth?.auth_mode !== "chatgpt") return false;
  const containers = [auth, auth.tokens, auth.chatgpt_tokens].filter((value) => isPlainObject(value));
  return containers.some((container) => ["access_token", "refresh_token", "id_token"]
    .some((key) => typeof container[key] === "string" && Boolean(container[key].trim())));
}

/** Only returns a redacted classification; auth material never leaves the runtime home. */
export async function codexAuthStatus(runtimeHome) {
  try {
    const auth = JSON.parse(await readFile(join(runtimeHome, ".codex", "auth.json"), "utf8"));
    if (!isPlainObject(auth)) return { mode: "none", authenticated: false, officialCredentialAvailable: false, authModeLabel: "未登录" };
    const hasApiKey = typeof auth.OPENAI_API_KEY === "string" && Boolean(auth.OPENAI_API_KEY.trim());
    const hasOauth = hasCodexOauthTokenMaterial(auth);
    const mode = hasApiKey ? "api-key" : hasOauth ? "oauth" : "none";
    return {
      mode,
      authenticated: mode !== "none",
      officialCredentialAvailable: hasOauth,
      authModeLabel: mode === "oauth" ? "ChatGPT OAuth" : mode === "api-key" ? "API Key" : "未登录",
    };
  } catch {
    return { mode: "none", authenticated: false, officialCredentialAvailable: false, authModeLabel: "未登录" };
  }
}

/** Claude 投影（to_claude_provider 移植）：空值键不写——key 缺省=不动现有认证（官方订阅登录场景）。
    cc-switch apiKeyField 变体：官方 API Key 场景写 ANTHROPIC_API_KEY，默认 ANTHROPIC_AUTH_TOKEN。
    proxyConfig.enabled 时投影 HTTPS_PROXY。
    模型映射（cc-switch 高级选项同款）：角色缺省回落主模型（Subagent 不回落——未设置则不写）；
    「1M 声明」给该角色实际模型值加 [1m] 后缀；显示名称写 _MODEL_NAME（只影响 /model 菜单）。 */
export function claudeEnvProjection(provider) {
  const models = provider.models?.claude ?? {};
  const model = models.model || "";
  // 预设附带固定 env（如 CLAUDE_CODE_MAX_CONTEXT_TOKENS）先铺底，投影键优先于同名 extra 键
  const env = { ...(provider.meta?.extraEnv?.claude ?? {}) };
  if (provider.baseUrl) env.ANTHROPIC_BASE_URL = provider.baseUrl;
  const keyField = provider.meta?.apiKeyField === "ANTHROPIC_API_KEY" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN";
  if (provider.apiKey) env[keyField] = provider.apiKey;
  if (model) {
    const with1m = (value, flag) => (value && flag === "1" && !value.endsWith("[1m]") ? `${value}[1m]` : value);
    env.ANTHROPIC_MODEL = with1m(model, models.model1m);
    for (const [role, envName, fallbackToMain] of [
      ["haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL", true],
      ["sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL", true],
      ["opus", "ANTHROPIC_DEFAULT_OPUS_MODEL", true],
      ["fable", "ANTHROPIC_DEFAULT_FABLE_MODEL", true],
      ["subagent", "ANTHROPIC_DEFAULT_SUBAGENT_MODEL", false],
    ]) {
      const actual = models[`${role}Model`] || (fallbackToMain ? model : "");
      if (!actual) continue;
      env[envName] = with1m(actual, models[`${role}Model1m`]);
      const display = models[`${role}ModelName`];
      if (display) env[`${envName}_NAME`] = display;
    }
  }
  const proxyUrl = proxyUrlOf(provider.meta?.proxyConfig);
  if (proxyUrl) env.HTTPS_PROXY = proxyUrl;
  return env;
}

export function codexConfigProjection(provider) {
  const models = provider.models?.codex ?? {};
  const modelCatalog = provider.meta?.modelCatalog ?? [];
  return {
    apiKey: provider.apiKey || "",
    model: models.model || modelCatalog[0]?.model || "",
    reasoningEffort: models.reasoningEffort || "",
    baseUrl: provider.meta?.isFullUrl ? String(provider.baseUrl ?? "").trim() : codexBaseUrl(provider.baseUrl),
    // cc-switch apiFormat → codex wire_api：openai_chat 走 Chat Completions，其余按 Responses
    wireApi: provider.meta?.apiFormat === "openai_chat" ? "chat" : "responses",
    codexTop: provider.meta?.codexTop ?? {},
    codexProviderExtra: provider.meta?.codexProviderExtra ?? {},
    modelCatalog,
  };
}

export function geminiEnvProjection(provider) {
  const env = { ...(provider.meta?.extraEnv?.gemini ?? {}) };
  if (provider.baseUrl) env.GOOGLE_GEMINI_BASE_URL = provider.baseUrl;
  if (provider.apiKey) env.GEMINI_API_KEY = provider.apiKey;
  if (provider.models?.gemini?.model) env.GEMINI_MODEL = provider.models.gemini.model;
  const proxyUrl = proxyUrlOf(provider.meta?.proxyConfig);
  if (proxyUrl) env.HTTPS_PROXY = proxyUrl;
  return env;
}

/** config.toml 标记块外科手术：顶层键只动 model_provider/model/model_reasoning_effort（首个 [section] 前），
    供应商块整段走 >>> 514-forge-provider >>> 标记（旧块先摘后追加），其余用户内容一字不动。 */
export function spliceToml(original, { blockId, topKeys, sectionName, sectionBody, sections = null }) {
  const lines = String(original ?? "").split(/\r?\n/);
  const begin = `# >>> 514-forge-provider (${blockId}) >>>`;
  const end = `# <<< 514-forge-provider <<<`;
  const kept = [];
  let inManaged = false;
  for (const line of lines) {
    if (line.startsWith("# >>> 514-forge-provider")) { inManaged = true; continue; }
    if (line.startsWith("# <<< 514-forge-provider")) { inManaged = false; continue; }
    if (!inManaged) kept.push(line);
  }
  // 顶层键区 = 首个 [section] 之前
  const firstSection = kept.findIndex((line) => /^\s*\[/.test(line));
  const topEnd = firstSection === -1 ? kept.length : firstSection;
  const top = kept.slice(0, topEnd);
  const rest = kept.slice(topEnd);
  for (const [key, value] of Object.entries(topKeys).reverse()) {
    const pattern = new RegExp(`^\\s*${key}\\s*=`);
    const index = top.findIndex((line) => pattern.test(line));
    // 值为 { raw } 时按 TOML 原文 RHS 落笔（布尔/数字/已带引号串），字符串值走 JSON 引号
    const raw = value !== null && typeof value === "object" ? String(value.raw ?? "") : null;
    const empty = raw !== null ? raw === "" : value === "";
    const rendered = raw !== null ? `${key} = ${raw}` : `${key} = ${JSON.stringify(value)}`;
    if (empty) {
      if (index !== -1) top.splice(index, 1); // 空值=摘除（回官方默认语义）
    } else if (index !== -1) {
      top[index] = rendered;
    } else {
      top.unshift(rendered); // reverse 迭代保证落笔顺序=声明顺序
    }
  }
  // 多 section 形态（kimi：providers + models 两表）；旧单 section 入参等价转换
  const sectionList = sections ?? (sectionName ? [{ name: sectionName, body: sectionBody }] : []);
  const block = sectionList.length
    ? [begin, ...sectionList.flatMap(({ name, body }, index) => [...(index ? [""] : []), `[${name}]`, ...body]), end]
    : [];
  return [...top, ...rest, "", ...block, ""].join("\n").replace(/\n{3,}/g, "\n\n");
}

/** .env 标记块：同理，KEY=VALUE 行对在标记内，块外行原样保留。 */
export function spliceEnv(original, blockId, entries) {
  const lines = String(original ?? "").split(/\r?\n/);
  const kept = [];
  let inManaged = false;
  for (const line of lines) {
    if (line.startsWith("# >>> 514-forge-provider")) { inManaged = true; continue; }
    if (line.startsWith("# <<< 514-forge-provider")) { inManaged = false; continue; }
    if (!inManaged) kept.push(line);
  }
  const block = [
    `# >>> 514-forge-provider (${blockId}) >>>`,
    ...Object.entries(entries).map(([key, value]) => `${key}=${value}`),
    `# <<< 514-forge-provider <<<`,
  ];
  const trimmed = kept.join("\n").replace(/\s+$/g, "");
  return `${trimmed ? `${trimmed}\n\n` : ""}${block.join("\n")}\n`;
}

export class ProviderStore {
  /** runtimeHome：live 配置写入根（默认 homedir()，测试/隔离用 CONTROL_CENTER_RUNTIME_HOME 覆盖）。 */
  constructor({
    dataRoot,
    runtimeHome = null,
    eventStore = null,
    storeReadFile = readFile,
    storeWriteFile = writeFile,
    storeRename = rename,
    liveRenameSync = renameSync,
    liveRemoveSync = rmSync,
    referencesForProvider = null,
    beforeLiveConfigPublish = null,
    beforeLiveConfigPlanCommit = null,
  }) {
    this.dataRoot = dataRoot;
    this.runtimeHome = runtimeHome || process.env.CONTROL_CENTER_RUNTIME_HOME || homedir();
    this.eventStore = eventStore;
    this.path = join(dataRoot, "providers.json");
    this.storeReadFile = storeReadFile;
    this.storeWriteFile = storeWriteFile;
    this.storeRename = storeRename;
    this.liveRenameSync = liveRenameSync;
    this.liveRemoveSync = liveRemoveSync;
    this.referencesForProvider = referencesForProvider;
    this.beforeLiveConfigPublish = typeof beforeLiveConfigPublish === "function" ? beforeLiveConfigPublish : null;
    this.beforeLiveConfigPlanCommit = typeof beforeLiveConfigPlanCommit === "function" ? beforeLiveConfigPlanCommit : null;
    this.storeStatus = { state: "missing", code: null, message: null };
    this.backupDir = join(dataRoot, "backups", "providers");
    this.providers = new Map();
    this.current = appMap(() => null);
    // cc-switch failover：per-app 有序队列（首项=P1）+ per-app 自动转移开关；关闭不清队列
    this.failoverQueue = appMap(() => []);
    this.autoFailover = appMap(() => false);
    // cc-switch common config snippet：per-app 通用片段，切换时并入 live 写入
    this.commonConfig = appMap(() => "");
    this.appOrder = appMap(() => []);
    this.proxyRuntime = {
      origin: "http://127.0.0.1:15721",
      token: "514cc-local-proxy",
      takeover: new Set(),
    };
    this.#queue = Promise.resolve();
  }

  #queue;

  #projectionQueues = new Map();

  #projectionContext = new AsyncLocalStorage();

  #proxyTakeoverRevisions = appMap(() => 0);

  #withProjectionLock(app, task, { queueIfHeld = false } = {}) {
    const heldApps = this.#projectionContext.getStore();
    if (heldApps?.has(app) && !queueIfHeld) {
      fail(`provider projection for ${app} cannot re-enter the same app`, "PROJECTION_REENTRANT");
    }
    const previous = this.#projectionQueues.get(app) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolveGate) => { release = resolveGate; });
    const queued = previous.catch(() => {}).then(() => gate);
    this.#projectionQueues.set(app, queued);
    return this.#projectionContext.run(new Set([...(heldApps ?? []), app]), async () => {
      await previous.catch(() => {});
      try {
        return await task();
      } finally {
        release();
        if (this.#projectionQueues.get(app) === queued) this.#projectionQueues.delete(app);
      }
    });
  }

  /** 配置预览干跑：非 null 时所有写盘助手改为收集「目标路径 → 最终内容」，不落盘不备份。 */
  #dryRunFiles = null;

  /** 远端投影干跑的原文件基底：键为 #shownPath()，只在串行 previewSwitch 临界段内可见。 */
  #dryRunBaseFiles = null;

  /** 代理 takeover 可由上层生命周期取消；检查必须贴近原子发布，不能只放在调用入口。 */
  #publishSignal = null;

  /** takeover 先异步准备完整写集，再在一个同步临界段发布或回滚。 */
  #publishPlan = null;

  /** 数字或动态 getter；close/stop 可把绝对 deadline 注入已经开始的事务。 */
  #publishDeadline = Infinity;

  #publishDeadlineValue() {
    const configured = Number(typeof this.#publishDeadline === "function"
      ? this.#publishDeadline()
      : this.#publishDeadline);
    const reasonDeadline = Number(this.#publishSignal?.reason?.deadline);
    const candidates = [configured, reasonDeadline].filter(Number.isFinite);
    return candidates.length ? Math.min(...candidates) : Infinity;
  }

  #assertPublishable(signal = this.#publishSignal) {
    if (signal?.aborted) {
      if (signal.reason instanceof Error) throw signal.reason;
      throw Object.assign(new Error("provider live-config publication was cancelled"), {
        name: "AbortError",
        code: "ABORTED",
      });
    }
    if (Date.now() < this.#publishDeadlineValue()) return;
    throw Object.assign(new Error("provider live-config publication deadline expired"), {
      name: "AbortError",
      code: "PROXY_CLOSE_TIMEOUT",
    });
  }

  async #capturePublishSnapshot(target) {
    const plan = this.#publishPlan;
    if (!plan) return null;
    if (plan.snapshots.has(target)) return plan.snapshots.get(target);
    this.#assertPublishable();
    let snapshot;
    try {
      snapshot = { target, existed: true, content: await readFile(target, "utf8") };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      snapshot = { target, existed: false, content: null };
    }
    this.#assertPublishable();
    plan.snapshots.set(target, snapshot);
    return snapshot;
  }

  async #publishPlanText(target) {
    const planned = this.#publishPlan?.entries.get(target);
    if (planned) return planned.operation === "write" ? planned.content : null;
    const snapshot = await this.#capturePublishSnapshot(target);
    return snapshot?.existed ? snapshot.content : null;
  }

  async #readConfigText(target) {
    if (this.#publishPlan) return await this.#publishPlanText(target) ?? "";
    if (this.#dryRunBaseFiles) {
      const shown = this.#shownPath(target);
      return this.#dryRunBaseFiles.has(shown) ? String(this.#dryRunBaseFiles.get(shown) ?? "") : "";
    }
    try {
      return await readFile(target, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return "";
      throw error;
    }
  }

  async #stageSidecarWrites(writes) {
    if (!this.#publishPlan) {
      if (writes?.length) fail("sidecar writes require a cancellable publish transaction", "VALIDATION_FAILED");
      return;
    }
    for (const entry of writes ?? []) {
      const target = String(entry?.target ?? "");
      if (!target) fail("sidecar write target is required", "VALIDATION_FAILED");
      if (this.#publishPlan.entries.has(target)) {
        fail(`sidecar write target conflicts with a live config target: ${target}`, "VALIDATION_FAILED");
      }
      await this.#capturePublishSnapshot(target);
      this.#assertPublishable();
      this.#publishPlan.entries.set(target, {
        operation: "write",
        content: String(entry?.content ?? ""),
        sidecar: true,
      });
    }
  }

  #renameTransactionSync(source, target, deadline, { beforeAttempt = null } = {}) {
    renameSyncWithRetry(source, target, {
      renameFile: this.liveRenameSync,
      deadline,
      beforeAttempt,
      ...(Number.isFinite(Number(typeof deadline === "function" ? deadline() : deadline))
        ? { retryDelaysMs: TRANSACTION_RENAME_RETRY_DELAYS_MS }
        : {}),
    });
  }

  #assertTransactionDeadline(deadline) {
    const absoluteDeadline = Number(typeof deadline === "function" ? deadline() : deadline);
    if (!Number.isFinite(absoluteDeadline) || Date.now() < absoluteDeadline) return;
    throw Object.assign(new Error("provider live-config transaction deadline expired"), {
      name: "AbortError",
      code: "PROXY_CLOSE_TIMEOUT",
    });
  }

  #assertTargetSnapshotSync(plan, target) {
    const snapshot = plan.snapshots.get(target);
    if (!snapshot) {
      fail(`prepared live-config snapshot is missing: ${target}`, "PUBLISH_SNAPSHOT_MISSING");
    }
    let current;
    try {
      current = { existed: true, content: readFileSync(target, "utf8") };
    } catch (error) {
      if (error?.code === "ENOENT") current = { existed: false, content: null };
      else {
        throw Object.assign(new Error(`live config changed while takeover was being prepared: ${target}`), {
          code: "LIVE_CONFIG_CHANGED",
          target,
          cause: error,
        });
      }
    }
    if (current.existed !== snapshot.existed || current.content !== snapshot.content) {
      fail(`live config changed while takeover was being prepared: ${target}`, "LIVE_CONFIG_CHANGED");
    }
  }

  #assertPublishedValueSync(plan, target) {
    const entry = plan.entries.get(target);
    if (!entry) {
      fail(`published live-config entry is missing: ${target}`, "PUBLISH_ENTRY_MISSING");
    }
    let current;
    try {
      current = { existed: true, content: readFileSync(target, "utf8") };
    } catch (error) {
      if (error?.code === "ENOENT") current = { existed: false, content: null };
      else {
        throw Object.assign(new Error(`published live config changed before rollback: ${target}`), {
          code: "ROLLBACK_TARGET_CHANGED",
          target,
          cause: error,
        });
      }
    }
    const expected = entry.operation === "remove"
      ? { existed: false, content: null }
      : { existed: true, content: entry.content };
    if (current.existed !== expected.existed || current.content !== expected.content) {
      fail(`published live config changed before rollback: ${target}`, "ROLLBACK_TARGET_CHANGED");
    }
  }

  #publishPreparedTextSync(plan, target, content, deadline, onPublicationCommitted) {
    this.#assertPublishable();
    this.#assertTransactionDeadline(deadline);
    mkdirSync(dirname(target), { recursive: true });
    this.#assertPublishable();
    this.#assertTransactionDeadline(deadline);
    const temp = join(dirname(target), `.514forge.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
      this.beforeLiveConfigPublish?.({ operation: "rename", target, temp });
      this.#assertPublishable();
      this.#assertTransactionDeadline(deadline);
      try {
        this.#renameTransactionSync(temp, target, deadline, {
          beforeAttempt: () => this.#assertTargetSnapshotSync(plan, target),
        });
        onPublicationCommitted();
      } catch (error) {
        if (error?.renameCommitted) onPublicationCommitted();
        throw error;
      }
    } finally {
      try { rmSync(temp, { force: true }); } catch {}
    }
  }

  #publishPreparedRemoveSync(plan, target, deadline, onPublicationCommitted) {
    this.#assertPublishable();
    this.#assertTransactionDeadline(deadline);
    this.beforeLiveConfigPublish?.({ operation: "remove", target, temp: null });
    this.#assertPublishable();
    this.#assertTransactionDeadline(deadline);
    this.#assertTargetSnapshotSync(plan, target);
    this.liveRemoveSync(target, { force: true });
    onPublicationCommitted();
    this.#assertTransactionDeadline(deadline);
  }

  #rollbackPublishedSync(plan, published, originalError, rollbackDeadline) {
    const rollbackErrors = [];
    for (const target of [...published].reverse()) {
      const snapshot = plan.snapshots.get(target);
      if (!snapshot) continue;
      try {
        this.#assertPublishedValueSync(plan, target);
        if (!snapshot.existed) {
          this.liveRemoveSync(target, { force: true });
          continue;
        }
        const temp = plan.rollbackTemps.get(target);
        if (!temp) throw Object.assign(new Error(`prepared rollback snapshot is missing: ${target}`), {
          code: "ROLLBACK_SNAPSHOT_MISSING",
        });
        try {
          this.#renameTransactionSync(temp, target, rollbackDeadline, {
            beforeAttempt: () => this.#assertPublishedValueSync(plan, target),
          });
        } catch (rollbackError) {
          if (!rollbackError?.renameCommitted) throw rollbackError;
          originalError.rollbackDeadlineExceeded = true;
        }
        plan.rollbackTemps.delete(target);
      } catch (rollbackError) {
        rollbackErrors.push(`${target}: ${rollbackError.message}`);
      }
    }
    if (rollbackErrors.length) {
      originalError.rollbackErrors = rollbackErrors;
      if (this.#publishSignal?.reason instanceof Error) {
        this.#publishSignal.reason.rollbackErrors = rollbackErrors;
      }
    }
  }

  #commitPublishPlanSync(plan, onCommitted = null) {
    this.#assertPublishable();
    const overallDeadline = this.#publishDeadlineValue();
    const transactionSize = plan.entries.size;
    const rollbackReserveMs = Number.isFinite(overallDeadline)
      ? transactionSize * TRANSACTION_RENAME_BUDGET_MS
      : 0;
    const publishDeadline = Number.isFinite(overallDeadline)
      ? overallDeadline - rollbackReserveMs
      : Infinity;
    if (Number.isFinite(overallDeadline)) {
      const publishBudgetMs = transactionSize * TRANSACTION_RENAME_BUDGET_MS;
      if (Date.now() + publishBudgetMs >= publishDeadline) {
        throw Object.assign(new Error("insufficient deadline budget for atomic live-config publication and rollback"), {
          name: "AbortError",
          code: "PROXY_CLOSE_TIMEOUT",
        });
      }
    }
    const published = [];
    try {
      for (const [target] of plan.entries) this.#assertTargetSnapshotSync(plan, target);

      for (const [target, backupPath] of plan.backups) {
        if (!backupPath) continue;
        this.#assertPublishable();
        mkdirSync(this.backupDir, { recursive: true });
        copyFileSync(target, backupPath);
        this.#writeBackupManifestSync(backupPath, target);
        this.#assertPublishable();
      }

      // Rollback snapshots are materialized before the first live rename. Once publication starts,
      // compensation performs only rename/remove operations; an overrun gets a fresh bounded retry window.
      for (const [target] of plan.entries) {
        const snapshot = plan.snapshots.get(target);
        if (!snapshot?.existed) continue;
        this.#assertPublishable();
        this.#assertTransactionDeadline(publishDeadline);
        const temp = join(dirname(target), `.514forge-rollback.${randomUUID()}.tmp`);
        try {
          writeFileSync(temp, snapshot.content, { encoding: "utf8", mode: 0o600 });
          this.#assertPublishable();
          this.#assertTransactionDeadline(publishDeadline);
          plan.rollbackTemps.set(target, temp);
        } catch (error) {
          try { rmSync(temp, { force: true }); } catch {}
          throw error;
        }
      }

      for (const [target, entry] of plan.entries) {
        let attempted = false;
        const markPublicationCommitted = () => {
          if (attempted) return;
          attempted = true;
          published.push(target);
        };
        if (entry.operation === "remove") {
          this.#publishPreparedRemoveSync(plan, target, publishDeadline, markPublicationCommitted);
        } else {
          this.#publishPreparedTextSync(plan, target, entry.content, publishDeadline, markPublicationCommitted);
        }
      }
      onCommitted?.();
    } catch (error) {
      if (published.length) {
        const rollbackRetryWindowMs = Math.max(
          TRANSACTION_RENAME_BUDGET_MS,
          published.length * TRANSACTION_RENAME_BUDGET_MS,
        );
        const rollbackDeadline = Number.isFinite(overallDeadline) && Date.now() >= overallDeadline
          ? Date.now() + rollbackRetryWindowMs
          : overallDeadline;
        this.#rollbackPublishedSync(plan, published, error, rollbackDeadline);
      }
      throw error;
    } finally {
      for (const temp of plan.rollbackTemps.values()) {
        try { rmSync(temp, { force: true }); } catch {}
      }
      plan.rollbackTemps.clear();
    }
  }

  #assertWritable() {
    if (this.storeStatus.state !== "blocked") return;
    fail(
      `provider store is blocked because the existing file could not be read safely: ${this.storeStatus.message}`,
      this.storeStatus.code || "PROVIDER_STORE_BLOCKED",
    );
  }

  #serialize(task) {
    const guarded = () => {
      this.#assertWritable();
      return task();
    };
    const next = this.#queue.then(guarded, guarded);
    this.#queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async #references(providerId, action) {
    if (typeof this.referencesForProvider !== "function") return [];
    let references;
    try {
      references = await this.referencesForProvider(providerId);
    } catch (error) {
      throw Object.assign(new Error(`provider reference check failed; ${action} was blocked`), {
        code: "PROVIDER_REFERENCE_CHECK_FAILED",
        providerId,
        causeCode: error?.code ?? null,
        cause: error,
      });
    }
    if (!Array.isArray(references)) {
      throw Object.assign(new Error(`provider reference check returned an ambiguous result; ${action} was blocked`), {
        code: "PROVIDER_REFERENCE_CHECK_FAILED",
        providerId,
      });
    }
    return references;
  }

  async init() {
    let parsed;
    try {
      const raw = await this.storeReadFile(this.path, "utf8");
      parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.providers)) {
        fail("providers.json must contain an object with a providers array", "PROVIDER_STORE_CORRUPT");
      }
      validatePersistedProviderIds(parsed.providers);
      const migratedLegacyIds = new Set();
      const providers = parsed.providers.map((provider) => {
        if (isReservedCodexProvider(provider)) {
          if (!isSafeLegacyCodexOfficialProvider(provider)) {
            fail("providers.json contains the reserved Codex provider name OpenAI Official", "PROVIDER_STORE_CORRUPT");
          }
          migratedLegacyIds.add(provider.id);
          return { ...provider, name: CODEX_LEGACY_OFFICIAL_PROVIDER_NAME };
        }
        if (isReservedGrokProvider(provider)) {
          if (!isSafeLegacyGrokOfficialProvider(provider)) {
            fail("providers.json contains the reserved Grok Build provider name Grok Official", "PROVIDER_STORE_CORRUPT");
          }
          migratedLegacyIds.add(provider.id);
          return { ...provider, name: GROK_LEGACY_OFFICIAL_PROVIDER_NAME };
        }
        return provider;
      });
      // 旧版曾把 OpenAI API Key 档案命名为内置登录项。只迁移身份字段；
      // current/failover 属执行状态，不能因兼容迁移而被静默恢复。
      this.storeStatus = { state: "ready", code: null, message: null };
      for (const provider of providers) {
        if (provider?.id) this.providers.set(provider.id, provider);
      }
      for (const app of PROVIDER_APPS) {
        const id = parsed.current?.[app];
        if (id && !migratedLegacyIds.has(id) && this.providers.has(id)) this.current[app] = id;
        const queue = Array.isArray(parsed.failoverQueue?.[app]) ? parsed.failoverQueue[app] : [];
        const droppedLegacyExecutionRef = migratedLegacyIds.has(id) || queue.some((qid) => migratedLegacyIds.has(qid));
        this.failoverQueue[app] = queue.filter((qid) => !migratedLegacyIds.has(qid) && this.providers.has(qid));
        this.autoFailover[app] = !droppedLegacyExecutionRef && Boolean(parsed.autoFailover?.[app]);
        this.commonConfig[app] = typeof parsed.commonConfig?.[app] === "string"
          ? parsed.commonConfig[app].slice(0, COMMON_CONFIG_MAX)
          : "";
        const order = Array.isArray(parsed.appOrder?.[app]) ? parsed.appOrder[app] : [];
        const valid = order.filter((qid) => this.providers.get(qid)?.apps?.[app]);
        const missing = this.#sortedProviders().filter((provider) => provider.apps?.[app] && !valid.includes(provider.id)).map((provider) => provider.id);
        this.appOrder[app] = [...valid, ...missing];
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.storeStatus = { state: "missing", code: null, message: null };
      } else {
        // 损坏、权限错误、瞬时 I/O 错误都必须冻结写入。否则下一次 create/update
        // 会把原字节覆盖成空库，令一个可恢复的读取故障变成不可逆数据丢失。
        this.providers.clear();
        this.storeStatus = {
          state: "blocked",
          code: error?.code === "PROVIDER_STORE_CORRUPT" ? error.code : "PROVIDER_STORE_UNREADABLE",
          message: String(error?.message || error).slice(0, 300),
        };
      }
    }
    return this;
  }

  #snapshotState() {
    return {
      providers: new Map([...this.providers].map(([id, provider]) => [id, structuredClone(provider)])),
      current: { ...this.current },
      failoverQueue: appMap((app) => [...this.failoverQueue[app]]),
      autoFailover: { ...this.autoFailover },
      commonConfig: { ...this.commonConfig },
      appOrder: appMap((app) => [...this.appOrder[app]]),
    };
  }

  #stateContent(state) {
    return `${JSON.stringify({
      providers: [...state.providers.values()],
      current: state.current,
      failoverQueue: state.failoverQueue,
      autoFailover: state.autoFailover,
      commonConfig: state.commonConfig,
      appOrder: state.appOrder,
    }, null, 2)}\n`;
  }

  #installState(state) {
    this.providers = state.providers;
    this.current = state.current;
    this.failoverQueue = state.failoverQueue;
    this.autoFailover = state.autoFailover;
    this.commonConfig = state.commonConfig;
    this.appOrder = state.appOrder;
  }

  async #commitState(state) {
    this.#assertWritable();
    await mkdir(this.dataRoot, { recursive: true });
    const temp = join(this.dataRoot, `.providers.${randomUUID()}.tmp`);
    try {
      await this.storeWriteFile(temp, this.#stateContent(state), { encoding: "utf8", mode: 0o600 });
      await renameWithRetry(temp, this.path, { renameFile: this.storeRename });
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
    this.#installState(state);
  }

  #validate(input, { existing = null } = {}) {
    const name = cleanText(input.name, "provider name", NAME_MAX);
    if (!name) fail("provider name is required", "VALIDATION_FAILED");
    const baseUrl = cleanText(input.baseUrl, "base url", URL_MAX);
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) fail("base url must start with http(s)://", "VALIDATION_FAILED");
    // apiKey：留空=保留原值（update）/无 key（create，官方登录场景）；绝不回显
    let apiKey = existing?.apiKey ?? "";
    if (typeof input.apiKey === "string" && input.apiKey.trim()) {
      apiKey = cleanText(input.apiKey, "api key", KEY_MAX);
    }
    const websiteUrl = cleanText(input.websiteUrl, "website url", URL_MAX);
    if (websiteUrl && !/^https?:\/\//i.test(websiteUrl)) fail("website url must start with http(s)://", "VALIDATION_FAILED");
    const apps = {};
    for (const app of PROVIDER_APPS) apps[app] = Boolean(input.apps?.[app]);
    if (!PROVIDER_APPS.some((app) => apps[app])) fail(`at least one app (${PROVIDER_APPS.join("/")}) must be enabled`, "VALIDATION_FAILED");
    const reservedName = reservedOfficialNameConflict({ name, apps });
    if (reservedName) fail(reservedName, "PROVIDER_RESERVED_NAME");
    const models = {};
    for (const app of PROVIDER_APPS) {
      const source = input.models?.[app];
      if (!source || typeof source !== "object") continue;
      const entry = {};
      for (const [key, value] of Object.entries(source)) {
        if (!MODEL_KEYS_BY_APP[app].has(key)) fail(`models.${app} has unknown field: ${key}`, "VALIDATION_FAILED");
        const text = cleanText(value, `models.${app}.${key}`, MODEL_MAX);
        if (text) entry[key] = text;
      }
      if (Object.keys(entry).length) models[app] = entry;
    }
    const iconColor = cleanText(input.iconColor, "icon color", 16);
    if (iconColor && !/^#[0-9a-fA-F]{6}$/.test(iconColor)) fail("icon color must be #rrggbb", "VALIDATION_FAILED");
    const category = input.category ?? existing?.category ?? "custom";
    if (!PROVIDER_CATEGORIES.has(category)) fail(`category must be one of ${[...PROVIDER_CATEGORIES].join("/")}`, "VALIDATION_FAILED");
    return {
      name,
      providerType: cleanText(input.providerType, "provider type", 40) || "custom",
      baseUrl,
      apiKey,
      apps,
      models,
      websiteUrl,
      notes: cleanText(input.notes, "notes", NOTES_MAX),
      icon: cleanText(input.icon, "icon", 40),
      iconColor,
      category,
      meta: this.#validateMeta(input.meta, { existing: existing?.meta }),
    };
  }

  /** cc-switch ProviderMeta 白名单校验：未提交的分区保留原值；敏感字段（usageScript.apiKey/
      accessToken、proxyConfig.password）与主 apiKey 同律——留空=保留，绝不回显。 */
  #validateMeta(input, { existing = null } = {}) {
    if (input === undefined) return existing ?? null;
    if (input === null) return null; // 显式 null = 清空 meta
    if (typeof input !== "object" || Array.isArray(input)) fail("meta must be an object", "VALIDATION_FAILED");
    const meta = {};

    // customEndpoints（cc-switch endpoints.rs：trim + 去尾斜杠 normalize + 去重）
    if (input.customEndpoints !== undefined) {
      if (!Array.isArray(input.customEndpoints)) fail("meta.customEndpoints must be an array", "VALIDATION_FAILED");
      if (input.customEndpoints.length > ENDPOINT_MAX) fail(`custom endpoints exceed ${ENDPOINT_MAX}`, "VALIDATION_FAILED");
      const seen = new Set();
      meta.customEndpoints = [];
      for (const entry of input.customEndpoints) {
        const url = String(entry?.url ?? "").trim().replace(/\/+$/, "");
        if (!url) continue;
        if (!/^https?:\/\//i.test(url)) fail("endpoint url must start with http(s)://", "VALIDATION_FAILED");
        if (url.length > URL_MAX) fail(`endpoint url exceeds ${URL_MAX} characters`, "VALIDATION_FAILED");
        if (seen.has(url)) continue;
        seen.add(url);
        meta.customEndpoints.push({
          url,
          addedAt: cleanText(entry?.addedAt, "endpoint addedAt", 40) || new Date().toISOString(),
          lastUsed: cleanText(entry?.lastUsed, "endpoint lastUsed", 40) || null,
        });
      }
    } else if (existing?.customEndpoints) meta.customEndpoints = existing.customEndpoints;

    // usageScript（cc-switch UsageScript：timeout clamp 2-30、autoQueryInterval ≤1440）
    if (input.usageScript !== undefined) {
      const source = input.usageScript ?? {};
      if (typeof source !== "object" || Array.isArray(source)) fail("meta.usageScript must be an object", "VALIDATION_FAILED");
      const prev = existing?.usageScript ?? {};
      const script = {
        enabled: Boolean(source.enabled),
        code: cleanText(source.code, "usage script code", SCRIPT_MAX),
        timeout: clampInt(source.timeout, 2, 30, prev.timeout ?? 10, "usage timeout"),
        templateType: USAGE_TEMPLATE_TYPES.has(source.templateType) ? source.templateType : prev.templateType ?? "custom",
        baseUrl: cleanText(source.baseUrl, "usage base url", URL_MAX),
        userId: cleanText(source.userId, "usage user id", 120),
        autoQueryInterval: clampInt(source.autoQueryInterval, 0, 1440, prev.autoQueryInterval ?? 0, "auto query interval"),
        apiKey: prev.apiKey ?? "",
        accessToken: prev.accessToken ?? "",
      };
      if (typeof source.apiKey === "string" && source.apiKey.trim()) script.apiKey = cleanText(source.apiKey, "usage api key", KEY_MAX);
      if (typeof source.accessToken === "string" && source.accessToken.trim()) script.accessToken = cleanText(source.accessToken, "usage access token", KEY_MAX);
      if (script.baseUrl && !/^https?:\/\//i.test(script.baseUrl)) fail("usage base url must start with http(s)://", "VALIDATION_FAILED");
      if (script.enabled && !script.code) fail("usage script code is required when enabled", "VALIDATION_FAILED");
      meta.usageScript = script;
    } else if (existing?.usageScript) meta.usageScript = existing.usageScript;

    // testConfig（cc-switch stream_check 默认：8s 超时 / 1 次重试 / 6000ms 降级阈值）
    if (input.testConfig !== undefined) {
      const source = input.testConfig ?? {};
      if (typeof source !== "object" || Array.isArray(source)) fail("meta.testConfig must be an object", "VALIDATION_FAILED");
      const prev = existing?.testConfig ?? {};
      meta.testConfig = {
        testModel: cleanText(source.testModel ?? prev.testModel, "test model", MODEL_MAX),
        testPrompt: cleanText(source.testPrompt ?? prev.testPrompt, "test prompt", 200),
        timeoutSecs: clampInt(source.timeoutSecs, 2, 30, prev.timeoutSecs ?? 8, "test timeout"),
        maxRetries: clampInt(source.maxRetries, 0, 5, prev.maxRetries ?? 1, "max retries"),
        degradedThresholdMs: clampInt(source.degradedThresholdMs, 100, 60000, prev.degradedThresholdMs ?? 6000, "degraded threshold"),
      };
    } else if (existing?.testConfig) meta.testConfig = existing.testConfig;

    // proxyConfig（password 留空=保留；enabled 必须有 host）
    if (input.proxyConfig !== undefined) {
      const source = input.proxyConfig ?? {};
      if (typeof source !== "object" || Array.isArray(source)) fail("meta.proxyConfig must be an object", "VALIDATION_FAILED");
      const prev = existing?.proxyConfig ?? {};
      const proxy = {
        enabled: Boolean(source.enabled),
        proxyType: PROXY_TYPES.has(source.proxyType) ? source.proxyType : prev.proxyType ?? "http",
        host: cleanText(source.host ?? prev.host, "proxy host", 200),
        port: clampInt(source.port, 1, 65535, prev.port ?? 0, "proxy port"),
        username: cleanText(source.username ?? prev.username, "proxy username", 120),
        password: prev.password ?? "",
      };
      if (typeof source.password === "string" && source.password.trim()) proxy.password = cleanText(source.password, "proxy password", KEY_MAX);
      if (proxy.enabled && !proxy.host) fail("proxy host is required when proxy is enabled", "VALIDATION_FAILED");
      meta.proxyConfig = proxy;
    } else if (existing?.proxyConfig) meta.proxyConfig = existing.proxyConfig;

    // endpointAutoSelect：测速后自动切到最快端点
    meta.endpointAutoSelect = input.endpointAutoSelect !== undefined
      ? Boolean(input.endpointAutoSelect)
      : Boolean(existing?.endpointAutoSelect);

    if (input.costMultiplier !== undefined || existing?.costMultiplier != null) {
      const value = Number(input.costMultiplier ?? existing?.costMultiplier ?? 1);
      if (!Number.isFinite(value) || value <= 0 || value > 1000) fail("cost multiplier must be within (0, 1000]", "VALIDATION_FAILED");
      meta.costMultiplier = value;
    }
    for (const key of ["limitDailyUsd", "limitMonthlyUsd"]) {
      if (input[key] !== undefined || existing?.[key] != null) {
        if (input[key] === null || input[key] === "") continue; // 显式 null/空 = 清除限额
        const value = Number(input[key] ?? existing?.[key]);
        if (!Number.isFinite(value) || value < 0 || value > 1000000) fail(`${key} must be within [0, 1000000]`, "VALIDATION_FAILED");
        meta[key] = value;
      }
    }
    const keyField = input.apiKeyField ?? existing?.apiKeyField;
    if (keyField) {
      if (!API_KEY_FIELDS.has(keyField)) fail("apiKeyField must be ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY", "VALIDATION_FAILED");
      meta.apiKeyField = keyField;
    }

    // apiFormat（cc-switch 预设目录字段：决定 codex wire_api 与 UI 徽标）
    const apiFormat = input.apiFormat ?? existing?.apiFormat;
    if (apiFormat) {
      if (!API_FORMATS.has(apiFormat)) fail("apiFormat must be anthropic/openai_chat/openai_responses/gemini_native", "VALIDATION_FAILED");
      meta.apiFormat = apiFormat;
    }
    meta.isFullUrl = input.isFullUrl !== undefined
      ? Boolean(input.isFullUrl)
      : Boolean(existing?.isFullUrl);

    // extraEnv（预设附带固定 env，如 CLAUDE_CODE_MAX_CONTEXT_TOKENS）：投影铺底、投影键优先
    if (input.extraEnv !== undefined) {
      if (input.extraEnv === null) {
        // 显式清空
      } else {
        if (typeof input.extraEnv !== "object" || Array.isArray(input.extraEnv)) fail("meta.extraEnv must be an object", "VALIDATION_FAILED");
        const extraEnv = isPlainRecord(existing?.extraEnv) ? { ...existing.extraEnv } : {};
        for (const app of ["claude", "gemini"]) {
          const table = input.extraEnv[app];
          if (table === undefined) continue;
          if (table === null) {
            delete extraEnv[app];
            continue;
          }
          if (typeof table !== "object" || Array.isArray(table)) fail(`meta.extraEnv.${app} must be an object`, "VALIDATION_FAILED");
          const entries = Object.entries(table);
          if (entries.length > 20) fail(`meta.extraEnv.${app} exceeds 20 keys`, "VALIDATION_FAILED");
          extraEnv[app] = {};
          for (const [key, value] of entries) {
            if (!EXTRA_ENV_KEY.test(key) || key.length > 64) fail(`meta.extraEnv.${app} key must be UPPER_SNAKE within 64 chars`, "VALIDATION_FAILED");
            extraEnv[app][key] = cleanText(value, `extraEnv ${key}`, 500);
          }
        }
        if (Object.keys(extraEnv).length) meta.extraEnv = extraEnv;
      }
    } else if (existing?.extraEnv) meta.extraEnv = existing.extraEnv;

    // extraSettings（claude settings.json 顶层片段，如 effortLevel/includeCoAuthoredBy）
    if (input.extraSettings !== undefined) {
      if (input.extraSettings === null) {
        // 显式清空
      } else {
        if (typeof input.extraSettings !== "object" || Array.isArray(input.extraSettings)) fail("meta.extraSettings must be an object", "VALIDATION_FAILED");
        const keys = Object.keys(input.extraSettings);
        if (keys.length > 20) fail("meta.extraSettings exceeds 20 keys", "VALIDATION_FAILED");
        for (const key of keys) {
          if (!SETTINGS_KEY.test(key) || SETTINGS_FORBIDDEN.has(key)) fail(`meta.extraSettings key not allowed: ${key}`, "VALIDATION_FAILED");
        }
        const serialized = JSON.stringify(input.extraSettings);
        if (serialized.length > 4000) fail("meta.extraSettings exceeds 4000 characters", "VALIDATION_FAILED");
        meta.extraSettings = JSON.parse(serialized); // 深拷贝脱引用
      }
    } else if (existing?.extraSettings) meta.extraSettings = existing.extraSettings;

    // codexTop / codexProviderExtra（预设 TOML 附加键，raw RHS 原文存储；键白名单封闭——见常量区注释）
    for (const [field, whitelist, valueMax] of [
      ["codexTop", CODEX_TOP_KEYS, 200],
      ["codexProviderExtra", CODEX_PROVIDER_EXTRA_KEYS, 300],
    ]) {
      if (input[field] !== undefined) {
        if (input[field] === null) {
          // 显式清空
        } else {
          if (typeof input[field] !== "object" || Array.isArray(input[field])) fail(`meta.${field} must be an object`, "VALIDATION_FAILED");
          const table = {};
          for (const [key, value] of Object.entries(input[field])) {
            if (!whitelist.has(key)) fail(`meta.${field} key not allowed: ${key}`, "VALIDATION_FAILED");
            const raw = String(value ?? "").trim();
            if (!raw) continue;
            if (raw.length > valueMax || /[\r\n]/.test(raw)) fail(`meta.${field}.${key} must be a single line within ${valueMax} chars`, "VALIDATION_FAILED");
            table[key] = raw;
          }
          if (Object.keys(table).length) meta[field] = table;
        }
      } else if (existing?.[field]) meta[field] = existing[field];
    }

    // modelCatalog（cc-switch 模型目录：前端模型下拉候选）
    if (input.modelCatalog !== undefined) {
      if (!Array.isArray(input.modelCatalog)) fail("meta.modelCatalog must be an array", "VALIDATION_FAILED");
      if (input.modelCatalog.length > 50) fail("meta.modelCatalog exceeds 50 entries", "VALIDATION_FAILED");
      meta.modelCatalog = input.modelCatalog
        .map((entry) => ({
          model: cleanText(entry?.model, "catalog model", MODEL_MAX),
          displayName: cleanText(entry?.displayName, "catalog display name", 120),
          contextWindow: clampInt(entry?.contextWindow, 1, 100000000, 0, "catalog context window") || undefined,
        }))
        .filter((entry) => entry.model);
    } else if (existing?.modelCatalog) meta.modelCatalog = existing.modelCatalog;

    // 五类专用应用的原始配置模板。仅接受有界 JSON 值；真实凭据必须统一走
    // provider.apiKey，避免 appConfig 形成第二个无法掩码/轮换的 secret 真源。
    if (input.appConfig !== undefined) {
      if (input.appConfig === null) {
        // 显式清空
      } else {
        if (typeof input.appConfig !== "object" || Array.isArray(input.appConfig)) fail("meta.appConfig must be an object", "VALIDATION_FAILED");
        const appConfig = isPlainRecord(existing?.appConfig) ? { ...existing.appConfig } : {};
        for (const [app, config] of Object.entries(input.appConfig)) {
          if (!PROVIDER_APPS.includes(app)) fail(`meta.appConfig has unknown app: ${app}`, "VALIDATION_FAILED");
          if (config === null) {
            delete appConfig[app];
            continue;
          }
          const cloned = cloneBoundedAppConfig(config, `meta.appConfig.${app}`);
          if (app === "grokbuild") {
            if (!isPlainRecord(cloned)) fail("meta.appConfig.grokbuild must be an object", "VALIDATION_FAILED");
            const apiBackend = String(cloned.apiBackend || DEFAULT_GROK_API_BACKEND).trim().toLowerCase();
            if (!GROK_API_BACKENDS.has(apiBackend)) {
              fail("meta.appConfig.grokbuild.apiBackend must be chat_completions or responses", "VALIDATION_FAILED");
            }
            cloned.apiBackend = apiBackend;
            if (cloned.contextWindow !== undefined) {
              cloned.contextWindow = clampInt(cloned.contextWindow, 1, 10_000_000, 500_000, "Grok context window");
            }
          }
          appConfig[app] = cloned;
        }
        if (JSON.stringify(appConfig).length > APP_CONFIG_MAX) fail(`meta.appConfig exceeds ${APP_CONFIG_MAX} characters`, "VALIDATION_FAILED");
        if (Object.keys(appConfig).length) meta.appConfig = appConfig;
      }
    } else if (existing?.appConfig) meta.appConfig = existing.appConfig;

    // proxyOverrides（本地代理接管时对上游请求的覆盖：User-Agent / Header / Body 浅合并）
    if (input.proxyOverrides !== undefined) {
      if (input.proxyOverrides === null) {
        // 显式清空
      } else {
        if (typeof input.proxyOverrides !== "object" || Array.isArray(input.proxyOverrides)) fail("meta.proxyOverrides must be an object", "VALIDATION_FAILED");
        const overrides = {};
        const userAgent = String(input.proxyOverrides.userAgent ?? "").trim();
        if (userAgent) {
          if (userAgent.length > 200 || /[\r\n]/.test(userAgent)) fail("meta.proxyOverrides.userAgent must be a single line within 200 chars", "VALIDATION_FAILED");
          overrides.userAgent = userAgent;
        }
        if (input.proxyOverrides.headers !== undefined && input.proxyOverrides.headers !== null) {
          if (typeof input.proxyOverrides.headers !== "object" || Array.isArray(input.proxyOverrides.headers)) fail("meta.proxyOverrides.headers must be an object", "VALIDATION_FAILED");
          const entries = Object.entries(input.proxyOverrides.headers);
          if (entries.length > 20) fail("meta.proxyOverrides.headers exceeds 20 keys", "VALIDATION_FAILED");
          const headers = {};
          for (const [key, value] of entries) {
            if (!PROXY_OVERRIDE_HEADER_KEY.test(key)) fail(`meta.proxyOverrides.headers key not allowed: ${key}`, "VALIDATION_FAILED");
            if (PROXY_OVERRIDE_FORBIDDEN_HEADERS.has(key.toLowerCase())) fail(`meta.proxyOverrides.headers key reserved: ${key}`, "VALIDATION_FAILED");
            const text = String(value ?? "").trim();
            if (!text) continue;
            if (text.length > 500 || /[\r\n]/.test(text)) fail(`meta.proxyOverrides.headers.${key} must be a single line within 500 chars`, "VALIDATION_FAILED");
            headers[key.toLowerCase()] = text;
          }
          if (Object.keys(headers).length) overrides.headers = headers;
        }
        if (input.proxyOverrides.body !== undefined && input.proxyOverrides.body !== null) {
          if (typeof input.proxyOverrides.body !== "object" || Array.isArray(input.proxyOverrides.body)) fail("meta.proxyOverrides.body must be an object", "VALIDATION_FAILED");
          const entries = Object.entries(input.proxyOverrides.body);
          if (entries.length > 20) fail("meta.proxyOverrides.body exceeds 20 keys", "VALIDATION_FAILED");
          const body = {};
          for (const [key, value] of entries) {
            if (!SETTINGS_KEY.test(key) || SETTINGS_FORBIDDEN.has(key)) fail(`meta.proxyOverrides.body key not allowed: ${key}`, "VALIDATION_FAILED");
            if (value !== null && !["string", "number", "boolean"].includes(typeof value)) fail(`meta.proxyOverrides.body.${key} must be a scalar`, "VALIDATION_FAILED");
            if (typeof value === "string" && value.length > 500) fail(`meta.proxyOverrides.body.${key} exceeds 500 chars`, "VALIDATION_FAILED");
            body[key] = value;
          }
          if (Object.keys(body).length) overrides.body = body;
        }
        if (Object.keys(overrides).length) meta.proxyOverrides = overrides;
      }
    } else if (existing?.proxyOverrides) meta.proxyOverrides = existing.proxyOverrides;

    // rawConfig（配置预览手改原文补丁：字符串=覆盖，null=删除，未提及保留；启用时按原文写入，盖过投影）
    if (input.rawConfig !== undefined) {
      if (input.rawConfig === null) {
        // 显式清空全部
      } else {
        const mergedRaw = mergeRawConfigPatch(existing?.rawConfig, input.rawConfig);
        if (mergedRaw) meta.rawConfig = mergedRaw;
      }
    } else if (existing?.rawConfig) meta.rawConfig = existing.rawConfig;

    return Object.keys(meta).length ? meta : null;
  }

  /** cc-switch sortIndex 语义：列表按 sortIndex 升序（缺省视为末尾），同序按创建时间稳定。 */
  #sortedProviders(providers = this.providers) {
    return [...providers.values()].sort((a, b) => {
      const ai = Number.isFinite(a.sortIndex) ? a.sortIndex : Number.MAX_SAFE_INTEGER;
      const bi = Number.isFinite(b.sortIndex) ? b.sortIndex : Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""));
    });
  }

  list() {
    return {
      providers: this.#sortedProviders().map(publicView),
      current: { ...this.current },
      failoverQueue: Object.fromEntries(PROVIDER_APPS.map((app) => [app, [...this.failoverQueue[app]]])),
      appOrder: Object.fromEntries(PROVIDER_APPS.map((app) => [app, [...this.appOrder[app]]])),
      autoFailover: { ...this.autoFailover },
      commonConfig: publicCommonConfig(this.commonConfig),
      storeStatus: { ...this.storeStatus },
    };
  }

  get(id) {
    const provider = this.providers.get(id);
    if (!provider) fail("provider not found", "SOURCE_NOT_FOUND");
    return provider;
  }

  view(id, { includeSecrets = false } = {}) {
    const provider = this.get(id);
    return includeSecrets ? JSON.parse(JSON.stringify(provider)) : publicView(provider);
  }

  commonConfigView({ includeSecrets = false } = {}) {
    return {
      includeSecrets,
      commonConfig: includeSecrets
        ? JSON.parse(JSON.stringify(this.commonConfig))
        : publicCommonConfig(this.commonConfig),
    };
  }

  configureLocalProxy({ origin, token } = {}) {
    if (origin) this.proxyRuntime.origin = String(origin).replace(/\/+$/, "");
    if (token) this.proxyRuntime.token = String(token);
    return { origin: this.proxyRuntime.origin, takeover: [...this.proxyRuntime.takeover] };
  }

  #projectedProvider(app, provider, takeover = this.proxyRuntime.takeover.has(app)) {
    if (!takeover) return provider;
    const suffix = app === "claude" || app === "claude-desktop" || app === "gemini"
      ? app
      : `${app}/v1`;
    return {
      ...provider,
      baseUrl: `${this.proxyRuntime.origin}/${suffix}`,
      apiKey: this.proxyRuntime.token,
      meta: {
        ...(provider.meta ?? {}),
        appConfig: {
          ...(provider.meta?.appConfig ?? {}),
          ...(app === "claude-desktop"
            ? { "claude-desktop": { ...(provider.meta?.appConfig?.["claude-desktop"] ?? {}), mode: "direct" } }
            : {}),
        },
      },
    };
  }

  create(input = {}) {
    return this.#serialize(async () => {
      const fields = this.#validate(input);
      const now = new Date().toISOString();
      const maxIndex = Math.max(0, ...[...this.providers.values()].map((p) => Number(p.sortIndex) || 0));
      const provider = {
        id: `provider-${randomUUID()}`,
        ...fields,
        sortIndex: Number.isInteger(input.sortIndex) ? input.sortIndex : maxIndex + 1,
        createdAt: now,
        updatedAt: now,
      };
      const candidate = this.#snapshotState();
      candidate.providers.set(provider.id, provider);
      for (const app of PROVIDER_APPS) if (provider.apps[app]) candidate.appOrder[app].push(provider.id);
      await this.#commitState(candidate);
      return publicView(provider);
    });
  }

  update(id, input = {}) {
    return this.#serialize(async () => {
      const existing = this.get(id);
      // PUT 接受前端的分区补丁：未提交的顶层字段沿用现值；meta 仍由
      // #validateMeta 逐分区合并，因此显式 null 可以清除，undefined 才是保留。
      const merged = { ...existing, ...input };
      if (input.apps && typeof input.apps === "object" && !Array.isArray(input.apps)) {
        merged.apps = { ...existing.apps, ...input.apps };
      }
      if (input.models && typeof input.models === "object" && !Array.isArray(input.models)) {
        merged.models = { ...existing.models, ...input.models };
      }
      if (!Object.prototype.hasOwnProperty.call(input, "meta")) merged.meta = undefined;
      const fields = this.#validate(merged, { existing });
      const next = { ...existing, ...fields, updatedAt: new Date().toISOString() };
      const disabledActiveApps = PROVIDER_APPS.filter((app) =>
        existing.apps?.[app] === true
        && next.apps?.[app] !== true
        && this.current[app] === id);
      if (disabledActiveApps.length) {
        fail(
          `provider is active for ${disabledActiveApps.map((app) => APP_LABELS[app]).join(", ")}; switch those apps before disabling them`,
          "PROVIDER_ACTIVE",
        );
      }
      if (typeof this.referencesForProvider === "function") {
        const references = await this.#references(id, "update");
        const incompatible = references.filter((reference) => reference?.providerApp && next.apps?.[reference.providerApp] !== true);
        if (incompatible.length) {
          fail(`provider is required by runtime seats: ${incompatible.map((item) => item.seatId).join(", ")}`, "PROVIDER_IN_USE");
        }
      }
      const candidate = this.#snapshotState();
      candidate.providers.set(id, next);
      for (const app of PROVIDER_APPS) {
        const had = Boolean(existing.apps?.[app]);
        const has = Boolean(next.apps?.[app]);
        if (!had && has && !candidate.appOrder[app].includes(id)) candidate.appOrder[app].push(id);
        if (had && !has) candidate.appOrder[app] = candidate.appOrder[app].filter((qid) => qid !== id);
      }
      await this.#commitState(candidate);
      return publicView(next);
    });
  }

  duplicate(id) {
    const existing = this.get(id);
    if (isReservedCodexProvider(existing) || isReservedGrokProvider(existing)) {
      fail("official login providers cannot be duplicated", "PROVIDER_RESERVED_NAME");
    }
    const used = new Set([...this.providers.values()].map((provider) => provider.name));
    const base = String(existing.name ?? "").replace(/ 副本(?: \d+)?$/, "").trim() || "供应商";
    let name = `${base} 副本`;
    let suffix = 2;
    while (used.has(name) || name.length > NAME_MAX) {
      const next = `${base} 副本 ${suffix}`;
      if (next.length > NAME_MAX) {
        const trimmed = base.slice(0, Math.max(1, NAME_MAX - ` 副本 ${suffix}`.length));
        name = `${trimmed} 副本 ${suffix}`;
      } else {
        name = next;
      }
      suffix += 1;
      if (suffix > 99) fail("could not allocate a unique copy name", "VALIDATION_FAILED");
    }
    return this.create({
      ...existing,
      name,
      sortIndex: undefined,
      createdAt: undefined,
      updatedAt: undefined,
    });
  }

  remove(id) {
    return this.#serialize(async () => {
      this.get(id); // 不存在则 404
      if (typeof this.referencesForProvider === "function") {
        const references = await this.#references(id, "deletion");
        if (references.length) {
          throw Object.assign(new Error(`provider is referenced by runtime seats: ${references.map((item) => item.seatId || item).join(", ")}`), {
            code: "PROVIDER_IN_USE", providerId: id, references,
          });
        }
      }
      const activeApps = PROVIDER_APPS.filter((app) => this.current[app] === id);
      if (activeApps.length) {
        fail(
          `provider is active for ${activeApps.map((app) => APP_LABELS[app]).join(", ")}; switch those apps before deleting it`,
          "PROVIDER_ACTIVE",
        );
      }
      const candidate = this.#snapshotState();
      candidate.providers.delete(id);
      for (const app of PROVIDER_APPS) {
        candidate.failoverQueue[app] = candidate.failoverQueue[app].filter((qid) => qid !== id);
        candidate.appOrder[app] = candidate.appOrder[app].filter((qid) => qid !== id);
      }
      await this.#commitState(candidate);
      let staleReferences = [];
      let referenceRecheck = { status: "ok" };
      if (typeof this.referencesForProvider === "function") {
        try {
          staleReferences = await this.#references(id, "deletion-recheck");
          if (staleReferences.length) {
            referenceRecheck = { status: "race", staleReferences };
            await this.eventStore?.emit?.("provider.reference_race", {
              providerId: id,
              action: "remove",
              references: staleReferences,
            }).catch(() => {});
          }
        } catch (error) {
          referenceRecheck = { status: "check_failed", code: error?.code ?? null };
        }
      }
      return { removed: id, staleReferences, referenceRecheck };
    });
  }

  /** cc-switch update_providers_sort_order：按给定 id 顺序重写 sortIndex（未提及的排末尾）。 */
  sort(orderedIds, { app = null } = {}) {
    return this.#serialize(async () => {
      if (!Array.isArray(orderedIds)) fail("orderedIds must be an array", "VALIDATION_FAILED");
      const candidate = this.#snapshotState();
      if (app !== null) {
        if (!PROVIDER_APPS.includes(app)) fail(`unknown app: ${app}`, "VALIDATION_FAILED");
        const eligible = this.#sortedProviders().filter((provider) => provider.apps?.[app]).map((provider) => provider.id);
        const next = [];
        for (const id of orderedIds) {
          if (!eligible.includes(id)) fail(`provider is not enabled for ${app}: ${id}`, "VALIDATION_FAILED");
          if (!next.includes(id)) next.push(id);
        }
        for (const id of eligible) if (!next.includes(id)) next.push(id);
        candidate.appOrder[app] = next;
        await this.#commitState(candidate);
        return { app, sorted: next.length, orderedIds: [...next] };
      }
      const seen = new Set();
      orderedIds.forEach((id, index) => {
        if (candidate.providers.has(id) && !seen.has(id)) {
          candidate.providers.get(id).sortIndex = index;
          seen.add(id);
        }
      });
      let tail = orderedIds.length;
      for (const provider of this.#sortedProviders(candidate.providers)) {
        if (!seen.has(provider.id)) provider.sortIndex = tail++;
      }
      await this.#commitState(candidate);
      return { sorted: seen.size };
    });
  }

  /** cc-switch failover queue 读取（含队列成员档案）。 */
  getFailover(app) {
    if (!PROVIDER_APPS.includes(app)) fail(`unknown app: ${app}`, "VALIDATION_FAILED");
    return {
      app,
      queue: this.failoverQueue[app].map((id, index) => ({ providerId: id, priority: index + 1, provider: publicView(this.providers.get(id)) })),
      autoFailover: this.autoFailover[app],
    };
  }

  /** cc-switch failover 开关语义移植：开启时队列为空→当前供应商自动补位 P1；关闭不清队列。 */
  setFailover(app, { queue = null, autoFailover = null } = {}) {
    if (!PROVIDER_APPS.includes(app)) fail(`unknown app: ${app}`, "VALIDATION_FAILED");
    return this.#serialize(async () => {
      const candidate = this.#snapshotState();
      if (queue !== null) {
        if (!Array.isArray(queue)) fail("queue must be an array of provider ids", "VALIDATION_FAILED");
        const next = [];
        for (const id of queue) {
          const provider = candidate.providers.get(id);
          if (!provider) fail(`provider not found in queue: ${id}`, "SOURCE_NOT_FOUND");
          if (!provider.apps[app]) fail(`provider "${provider.name}" is not enabled for ${APP_LABELS[app]}`, "VALIDATION_FAILED");
          if (!next.includes(id)) next.push(id);
        }
        candidate.failoverQueue[app] = next;
      }
      if (autoFailover !== null) {
        const enable = Boolean(autoFailover);
        if (enable && candidate.failoverQueue[app].length === 0) {
          const currentId = candidate.current[app];
          if (!currentId) fail("failover queue is empty and no current provider to seed P1", "VALIDATION_FAILED");
          candidate.failoverQueue[app] = [currentId];
        }
        candidate.autoFailover[app] = enable;
      }
      await this.#commitState(candidate);
      return this.getFailover(app);
    });
  }

  /** 自动故障转移驱动点（514cc 化）：健康检查失败时调用——沿队列找下一个可用项切过去。
      cc-switch 由常驻代理被动驱动；我们没有代理面，驱动点=健康检查/切换失败。 */
  async failoverNext(app, failedProviderId) {
    if (!this.autoFailover[app]) return { switched: false, reason: "autoFailover disabled" };
    const queue = this.failoverQueue[app];
    if (!queue.length) return { switched: false, reason: "queue empty" };
    const failedIndex = queue.indexOf(failedProviderId);
    const candidates = [...queue.slice(failedIndex + 1), ...queue.slice(0, Math.max(0, failedIndex))];
    const targetId = candidates[0] ?? null;
    if (!targetId) return { switched: false, reason: "no alternative in queue" };
    const result = await this.switchTo(app, targetId);
    await this.eventStore?.emit("provider.failover", { app, from: failedProviderId, to: targetId }).catch(() => {});
    return { switched: true, from: failedProviderId, to: targetId, result };
  }

  setCommonConfig(app, text) {
    if (!PROVIDER_APPS.includes(app)) fail(`unknown app: ${app}`, "VALIDATION_FAILED");
    const value = String(text ?? "");
    if (value.length > COMMON_CONFIG_MAX) fail(`common config exceeds ${COMMON_CONFIG_MAX} characters`, "VALIDATION_FAILED");
    if (["claude", "opencode", "openclaw"].includes(app) && value.trim()) {
      try {
        const parsed = app === "claude" ? JSON.parse(value) : JSON5.parse(value);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      } catch {
        fail(`${app} common config must be a JSON object`, "VALIDATION_FAILED");
      }
    }
    if (app === "hermes" && value.trim()) {
      try {
        const parsed = parseYaml(value);
        if (!isPlainObject(parsed)) throw new Error("not an object");
      } catch {
        fail("hermes common config must be a YAML object", "VALIDATION_FAILED");
      }
    }
    return this.#serialize(async () => {
      const candidate = this.#snapshotState();
      candidate.commonConfig[app] = value;
      await this.#commitState(candidate);
      return { app, commonConfig: maskCommonConfig(app, value), hasCommonConfig: Boolean(value.trim()) };
    });
  }

  /** cc-switch export/import config 移植。默认掩码导出（密钥面铁律）；includeSecrets 显式才带明文。
      队列/开关/片段全部深拷贝——活引用会让 replace 导入的清空步骤反向抹掉 payload 自身。 */
  exportProviders({ includeSecrets = false } = {}) {
    const providers = this.#sortedProviders().map((provider) =>
      includeSecrets ? JSON.parse(JSON.stringify(provider)) : publicView(provider));
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      includeSecrets,
      providers,
      current: { ...this.current },
      failoverQueue: JSON.parse(JSON.stringify(this.failoverQueue)),
      autoFailover: { ...this.autoFailover },
      commonConfig: includeSecrets
        ? JSON.parse(JSON.stringify(this.commonConfig))
        : publicCommonConfig(this.commonConfig),
      appOrder: JSON.parse(JSON.stringify(this.appOrder)),
    };
  }

  importProviders(payload, { mode = "merge" } = {}) {
    const list = Array.isArray(payload?.providers) ? payload.providers : null;
    if (!list) fail("import payload must contain providers array", "VALIDATION_FAILED");
    if (!["merge", "replace"].includes(mode)) fail("mode must be merge or replace", "VALIDATION_FAILED");
    return this.#serialize(async () => {
      // Import 在局部候选图中完成全部解析、引用校验后才交换实例状态。
      // 这样任一坏条目、引用冲突或写盘失败都不会留下半套内存配置。
      const providers = mode === "replace" ? new Map() : new Map(this.providers);
      const current = mode === "replace" ? appMap(() => null) : { ...this.current };
      const failoverQueue = mode === "replace"
        ? appMap(() => [])
        : appMap((app) => [...this.failoverQueue[app]]);
      const autoFailover = mode === "replace" ? appMap(() => false) : { ...this.autoFailover };
      const commonConfig = { ...this.commonConfig };
      const appOrder = mode === "replace"
        ? appMap(() => [])
        : appMap((app) => [...this.appOrder[app]]);
      let added = 0;
      let updated = 0;
      const idMap = new Map(); // 旧 id → 新 id（merge 冲突重生成时映射 current/queue）
      for (const raw of list) {
        if (!raw || typeof raw !== "object") continue;
        if (raw.id !== undefined && (typeof raw.id !== "string" || !PROVIDER_ID_PATTERN.test(raw.id))) {
          fail('provider id must be 1-160 characters using letters, numbers, dot, underscore, colon or hyphen; "::" and a trailing colon are reserved', "VALIDATION_FAILED");
        }
        const existing = raw.id && mode === "merge" ? providers.get(raw.id) : null;
        // 导入即信任 payload 内密钥（用户自己的备份）；走 #validate 白名单过滤未知字段
        const fields = this.#validate({ ...raw, apiKey: raw.apiKey ?? "" }, { existing });
        const now = new Date().toISOString();
        let id = raw.id;
        if (!existing) {
          id = providers.has(id) ? `provider-${randomUUID()}` : id || `provider-${randomUUID()}`;
          if (raw.id && id !== raw.id) idMap.set(raw.id, id);
          const maxIndex = Math.max(0, ...[...providers.values()].map((p) => Number(p.sortIndex) || 0));
          providers.set(id, {
            ...fields,
            id,
            sortIndex: Number.isInteger(raw.sortIndex) ? raw.sortIndex : maxIndex + 1,
            createdAt: raw.createdAt || now,
            updatedAt: now,
          });
          added += 1;
        } else {
          providers.set(id, { ...existing, ...fields, updatedAt: now });
          updated += 1;
        }
      }
      if (mode === "replace") {
        for (const app of PROVIDER_APPS) {
          const id = payload.current?.[app];
          if (id && providers.has(id)) current[app] = id;
          const queue = Array.isArray(payload.failoverQueue?.[app]) ? payload.failoverQueue[app] : [];
          failoverQueue[app] = queue.filter((qid) => providers.has(qid));
          autoFailover[app] = Boolean(payload.autoFailover?.[app]);
          if (typeof payload.commonConfig?.[app] === "string") {
            commonConfig[app] = payload.commonConfig[app].slice(0, COMMON_CONFIG_MAX);
          }
          const order = Array.isArray(payload.appOrder?.[app]) ? payload.appOrder[app] : [];
          appOrder[app] = order.filter((qid) => providers.get(qid)?.apps?.[app]);
        }
      } else {
        for (const app of PROVIDER_APPS) {
          if (idMap.has(current[app])) current[app] = idMap.get(current[app]);
          failoverQueue[app] = failoverQueue[app]
            .map((qid) => idMap.get(qid) ?? qid)
            .filter((qid) => providers.has(qid));
          appOrder[app] = appOrder[app]
            .map((qid) => idMap.get(qid) ?? qid)
            .filter((qid) => providers.get(qid)?.apps?.[app]);
        }
      }

      const sorted = [...providers.values()].sort((a, b) => {
        const sortDelta = (Number(a.sortIndex) || 0) - (Number(b.sortIndex) || 0);
        return sortDelta || String(a.name).localeCompare(String(b.name));
      });
      for (const app of PROVIDER_APPS) {
        appOrder[app] = [...new Set(appOrder[app])]
          .filter((qid) => providers.get(qid)?.apps?.[app]);
        for (const provider of sorted) {
          if (provider.apps?.[app] && !appOrder[app].includes(provider.id)) appOrder[app].push(provider.id);
        }
      }

      if (typeof this.referencesForProvider === "function") {
        for (const providerId of this.providers.keys()) {
          const references = await this.#references(providerId, "import");
          const candidate = providers.get(providerId);
          const incompatible = references.filter((reference) => (
            !candidate || (reference?.providerApp && candidate.apps?.[reference.providerApp] !== true)
          ));
          if (incompatible.length) {
            throw Object.assign(new Error(`provider is required by runtime seats: ${incompatible.map((item) => item.seatId || item).join(", ")}`), {
              code: "PROVIDER_IN_USE",
              providerId,
              references: incompatible,
            });
          }
        }
      }

      await this.#commitState({
        providers,
        current,
        failoverQueue,
        autoFailover,
        commonConfig,
        appOrder,
      });
      return { added, updated, total: providers.size };
    });
  }

  /** cc-switch env 冲突检查（514cc 化）：系统环境变量与 live 配置键撞车会覆盖/误导运行时。 */
  envConflicts() {
    const watched = {
      claude: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"],
      codex: ["OPENAI_API_KEY"],
      gemini: ["GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL", "GEMINI_MODEL"],
      // KIMI_MODEL_* 家族会在内存里合成临时 provider，优先级压过 config.toml 的
      // default_model 投影（官方 env-vars.html）——凭据类 KIMI_API_KEY 反而不会被 shell 读取。
      kimi: ["KIMI_MODEL_NAME", "KIMI_MODEL_API_KEY", "KIMI_MODEL_BASE_URL", "KIMI_MODEL_PROVIDER_TYPE"],
    };
    const conflicts = [];
    for (const [app, keys] of Object.entries(watched)) {
      for (const key of keys) {
        const value = process.env[key];
        if (value) conflicts.push({ app, key, valueMasked: maskKey(value) });
      }
    }
    return { conflicts, checked: Object.values(watched).flat().length };
  }

  /**
   * live 配置回退登记表：备份**只能**恢复到表内路径——与远程 `remote-graph.mjs` 的
   * GRAPH_CONFIG_FILES 同纪律（客户端永不提交任意路径）。credential=true 的文件是凭据载体，
   * 内容不出服务端（可恢复、不可预览），与远程 `contentPolicy:"hidden"` 对齐。
   */
  liveConfigTargets() {
    const desktop = this.#claudeDesktopPaths();
    const hermesRoot = this.runtimeHome === homedir() && process.platform === "win32"
      ? join(this.#localAppData(), "hermes")
      : join(this.runtimeHome, ".hermes");
    return [
      { app: "claude", label: "Claude settings.json", path: join(this.runtimeHome, ".claude", "settings.json") },
      { app: "codex", label: "Codex config.toml", path: join(this.runtimeHome, ".codex", "config.toml") },
      { app: "codex", label: "Codex auth.json", path: join(this.runtimeHome, ".codex", "auth.json"), credential: true },
      { app: "codex", label: "Codex 514cc 模型目录", path: join(this.runtimeHome, ".codex", CODEX_MANAGED_CATALOG_FILENAME) },
      { app: "gemini", label: "Gemini .env", path: join(this.runtimeHome, ".gemini", ".env"), credential: true },
      { app: "claude-desktop", label: "Claude Desktop 配置", path: desktop.normal },
      { app: "claude-desktop", label: "Claude Desktop 3p 配置", path: desktop.threep },
      { app: "claude-desktop", label: "Claude Desktop profile", path: desktop.profile },
      { app: "claude-desktop", label: "Claude Desktop _meta.json", path: desktop.meta },
      { app: "grokbuild", label: "Grok config.toml", path: join(this.runtimeHome, ".grok", "config.toml") },
      { app: "kimi", label: "Kimi config.toml", path: join(this.runtimeHome, ".kimi-code", "config.toml") },
      { app: "opencode", label: "OpenCode opencode.json", path: join(this.runtimeHome, ".config", "opencode", "opencode.json") },
      { app: "openclaw", label: "OpenClaw openclaw.json", path: join(this.runtimeHome, ".openclaw", "openclaw.json") },
      { app: "hermes", label: "Hermes config.yaml", path: join(hermesRoot, "config.yaml") },
    ];
  }

  #liveTargetFor(path) {
    return this.liveConfigTargets().find((entry) => entry.path === path) ?? null;
  }

  /** 无清单的历史备份靠 basename 归属：唯一命中才可恢复，同名多目标（settings.json）如实标为不可自动恢复。 */
  #liveTargetsByBasename(name) {
    return this.liveConfigTargets().filter((entry) => basename(entry.path) === name);
  }

  /** 备份归属上下文：switchTo / applyTeamBindings / setCommonConfig 入口登记，#backup 落进清单。 */
  #backupContext = null;

  #backupManifestPath(backupPath) {
    return `${backupPath}.manifest.json`;
  }

  #backupManifestContent(backupPath, target) {
    const context = this.#backupContext ?? {};
    return `${JSON.stringify({
      schema: "514cc.provider-backup/v1",
      backup: basename(backupPath),
      target,
      app: context.app ?? this.#liveTargetFor(target)?.app ?? null,
      providerId: context.providerId ?? null,
      providerName: context.providerName ?? null,
      reason: context.reason ?? "publish",
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`;
  }

  /** 清单写失败绝不掀掉发布事务：备份本体已在，退化为「无清单历史备份」（basename 归属）。 */
  #writeBackupManifestSync(backupPath, target) {
    try {
      writeFileSync(this.#backupManifestPath(backupPath), this.#backupManifestContent(backupPath, target), { encoding: "utf8", mode: 0o600 });
    } catch {}
  }

  async #writeBackupManifest(backupPath, target) {
    try {
      await writeFile(this.#backupManifestPath(backupPath), this.#backupManifestContent(backupPath, target), { encoding: "utf8", mode: 0o600 });
    } catch {}
  }

  /**
   * 备份台账：每份备份 = 备份本体 + 可选清单 sidecar。清单缺席（历史备份）时按 basename 归属，
   * 同名多目标即如实 restorable:false，绝不猜一个路径写回去。
   */
  async listBackups({ app = null } = {}) {
    let entries;
    try {
      entries = await readdir(this.backupDir);
    } catch (error) {
      if (error?.code === "ENOENT") return { backups: [], targets: this.liveConfigTargets().map((entry) => ({ app: entry.app, label: entry.label, displayPath: this.#shownPath(entry.path), credential: entry.credential === true })) };
      throw error;
    }
    const backups = [];
    for (const name of entries) {
      if (name.endsWith(".manifest.json")) continue;
      const backupPath = join(this.backupDir, name);
      let info;
      try {
        info = await stat(backupPath);
      } catch { continue; }
      if (!info.isFile()) continue;
      let manifest = null;
      try {
        manifest = JSON.parse(await readFile(this.#backupManifestPath(backupPath), "utf8"));
      } catch {}
      const manifestTarget = typeof manifest?.target === "string" ? this.#liveTargetFor(manifest.target) : null;
      // 清单里的 target 也必须落在登记表内，否则等同无清单（防手改清单越权写盘）
      const candidates = manifestTarget ? [manifestTarget] : this.#liveTargetsByBasename(name.replace(/^\d{8}-\d{6}-(?:[0-9a-fA-F-]{36}-)?/, ""));
      const target = candidates.length === 1 ? candidates[0] : null;
      const unresolved = candidates.length === 0 ? "no-target" : candidates.length > 1 ? "ambiguous" : null;
      const entry = {
        name,
        app: target?.app ?? (typeof manifest?.app === "string" ? manifest.app : null),
        label: target?.label ?? null,
        targetPath: target ? this.#shownPath(target.path) : null,
        credential: target?.credential === true,
        providerId: typeof manifest?.providerId === "string" ? manifest.providerId : null,
        providerName: typeof manifest?.providerName === "string" ? manifest.providerName : null,
        reason: typeof manifest?.reason === "string" ? manifest.reason : null,
        createdAt: (typeof manifest?.createdAt === "string" ? manifest.createdAt : null) ?? info.mtime.toISOString(),
        size: info.size,
        hasManifest: Boolean(manifest),
        restorable: Boolean(target),
        unresolved,
      };
      if (!app || entry.app === app) backups.push(entry);
    }
    backups.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    return {
      backups,
      targets: this.liveConfigTargets().map((entry) => ({ app: entry.app, label: entry.label, displayPath: this.#shownPath(entry.path), credential: entry.credential === true })),
    };
  }

  #assertBackupName(name) {
    const value = String(name ?? "");
    if (!value || value.includes("/") || value.includes("\\") || value.includes("..") || value.endsWith(".manifest.json")) {
      fail(`invalid backup name: ${value}`, "BACKUP_NAME_INVALID");
    }
    return value;
  }

  async #resolveBackup(name) {
    const safeName = this.#assertBackupName(name);
    const { backups } = await this.listBackups();
    const entry = backups.find((item) => item.name === safeName);
    if (!entry) fail(`backup not found: ${safeName}`, "BACKUP_NOT_FOUND");
    return { entry, backupPath: join(this.backupDir, safeName) };
  }

  /**
   * 备份内容预览：凭据载体不出服务端（credential/命中密钥即脱敏或隐藏），与远程 readBackup 同口径。
   * 恢复不依赖这里的返回值——原文在服务端从备份直接写回，脱敏文本永不回流磁盘。
   */
  async readBackup(name) {
    const { entry, backupPath } = await this.#resolveBackup(name);
    const raw = await readFile(backupPath, "utf8");
    const digest = createHash("sha256").update(raw).digest("hex");
    const currentDigest = await this.#currentDigest(entry);
    if (entry.credential) {
      return { ...entry, contentHidden: true, content: "", current: "", redacted: true, digest, currentDigest };
    }
    const view = (text) => {
      const scrubbed = scrub(text);
      return { content: scrubbed, redacted: scrubbed !== text || findSecretCandidates(text).length > 0 };
    };
    const backupView = view(raw);
    // 当前 live 文本同policy脱敏一并回传：前端才能画出「恢复会产生的变更」差异（与远程备份时间线同形态）
    const currentView = view(await this.#currentLiveText(entry));
    return {
      ...entry,
      contentHidden: false,
      content: backupView.content,
      current: currentView.content,
      redacted: backupView.redacted || currentView.redacted,
      digest,
      currentDigest,
    };
  }

  async #currentLiveText(entry) {
    const target = entry.targetPath ? this.liveConfigTargets().find((item) => this.#shownPath(item.path) === entry.targetPath) : null;
    if (!target) return "";
    try {
      return await readFile(target.path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return "";
      throw error;
    }
  }

  /** 当前 live 内容摘要（用于恢复前 CAS 比对；文件不存在返回 "missing"）。 */
  async #currentDigest(entry) {
    const target = entry.targetPath ? this.liveConfigTargets().find((item) => this.#shownPath(item.path) === entry.targetPath) : null;
    if (!target) return null;
    try {
      return createHash("sha256").update(await readFile(target.path, "utf8")).digest("hex");
    } catch (error) {
      if (error?.code === "ENOENT") return "missing";
      throw error;
    }
  }

  /**
   * 一键回退：把备份原文写回登记表内的 live 目标。恢复本身**也先备份当前内容**（reason=restore），
   * 所以回退可以再回退。expectedDigest 命中不上即 409 如实拒绝，绝不覆盖别人刚改的文件。
   */
  restoreBackup(name, { expectedDigest = null } = {}) {
    return this.#serialize(async () => {
      const { entry, backupPath } = await this.#resolveBackup(name);
      if (!entry.restorable) {
        fail(
          entry.unresolved === "ambiguous"
            ? `backup "${entry.name}" matches more than one live config target; restore it manually`
            : `backup "${entry.name}" has no registered live config target`,
          "BACKUP_TARGET_UNRESOLVED",
        );
      }
      const target = this.liveConfigTargets().find((item) => this.#shownPath(item.path) === entry.targetPath);
      if (!target) fail(`backup "${entry.name}" has no registered live config target`, "BACKUP_TARGET_UNRESOLVED");
      const currentDigest = await this.#currentDigest(entry);
      if (expectedDigest && currentDigest !== expectedDigest) {
        fail(`live config changed since the backup list was read: ${entry.targetPath}`, "BACKUP_TARGET_CHANGED");
      }
      const content = await readFile(backupPath, "utf8");
      const previousContext = this.#backupContext;
      this.#backupContext = { app: target.app, providerId: entry.providerId, providerName: entry.providerName, reason: "restore" };
      let undoBackup = null;
      try {
        undoBackup = await this.#writeText(target.path, content);
      } finally {
        this.#backupContext = previousContext;
      }
      await this.eventStore?.emit("provider.backup_restore", {
        app: target.app,
        backup: entry.name,
        target: entry.targetPath,
        undoBackup: undoBackup ? basename(undoBackup) : null,
      }).catch(() => {});
      return {
        app: target.app,
        backup: entry.name,
        target: entry.targetPath,
        bytes: Buffer.byteLength(content),
        undoBackup: undoBackup ? basename(undoBackup) : null,
      };
    });
  }

  /** 备份删除：只删登记目录内的单份备份与它的清单，不接任意路径。 */
  async removeBackup(name) {
    const { entry, backupPath } = await this.#resolveBackup(name);
    await rm(backupPath, { force: true });
    await rm(this.#backupManifestPath(backupPath), { force: true });
    return { removed: entry.name };
  }

  /** 切换前时间戳备份（514cc 运行时写入铁律：先备份再落笔）。目标不存在则无备份可留。 */
  async #backup(target) {
    if (this.#dryRunFiles) return null; // 干跑：无写入即无备份
    if (this.#publishPlan) {
      const snapshot = await this.#capturePublishSnapshot(target);
      if (!snapshot.existed) return null;
      if (!this.#publishPlan.backups.has(target)) {
        this.#publishPlan.backups.set(
          target,
          join(this.backupDir, `${nowStamp()}-${randomUUID()}-${target.replace(/.*[\\/]/, "")}`),
        );
      }
      return this.#publishPlan.backups.get(target);
    }
    this.#assertPublishable();
    try {
      if (this.#publishSignal) {
        mkdirSync(this.backupDir, { recursive: true });
        this.#assertPublishable();
        const backupPath = join(this.backupDir, `${nowStamp()}-${target.replace(/.*[\\/]/, "")}`);
        copyFileSync(target, backupPath);
        this.#writeBackupManifestSync(backupPath, target);
        this.#assertPublishable();
        return backupPath;
      }
      await mkdir(this.backupDir, { recursive: true });
      this.#assertPublishable();
      const backupPath = join(this.backupDir, `${nowStamp()}-${target.replace(/.*[\\/]/, "")}`);
      await copyFile(target, backupPath);
      await this.#writeBackupManifest(backupPath, target);
      this.#assertPublishable();
      return backupPath;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async #writeJson(target, mutate) {
    this.#assertPublishable();
    let data = {};
    const raw = await this.#readConfigText(target);
    if (raw.trim()) {
      try {
        data = JSON.parse(raw);
      } catch {
        // 用户的 live 文件坏了——照实报错拒绝覆盖，绝不静默 clobber（先人工处理）
        fail(`live config is not valid JSON: ${target}`, "INVALID_LIVE_JSON");
      }
    }
    this.#assertPublishable();
    if (typeof data !== "object" || data === null || Array.isArray(data)) data = {};
    mutate(data);
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    if (this.#dryRunFiles) {
      this.#dryRunFiles.set(target, { content: serialized });
      return null;
    }
    const backup = await this.#backup(target);
    this.#assertPublishable();
    if (this.#publishPlan) {
      this.#publishPlan.entries.set(target, { operation: "write", content: serialized });
      return backup;
    }
    if (this.#publishSignal) {
      mkdirSync(dirname(target), { recursive: true });
      this.#assertPublishable();
      const temp = join(dirname(target), `.514forge.${randomUUID()}.tmp`);
      try {
        writeFileSync(temp, serialized, { encoding: "utf8", mode: 0o600 });
        this.beforeLiveConfigPublish?.({ operation: "rename", target, temp });
        this.#assertPublishable();
        renameSyncWithRetry(temp, target);
        return backup;
      } finally {
        try { rmSync(temp, { force: true }); } catch {}
      }
    }
    await mkdir(dirname(target), { recursive: true });
    this.#assertPublishable();
    const temp = join(dirname(target), `.514forge.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, serialized, { encoding: "utf8", mode: 0o600 });
      this.#assertPublishable();
      await rename(temp, target);
      return backup;
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async #writeText(target, content) {
    if (this.#dryRunFiles) {
      this.#dryRunFiles.set(target, { content: String(content) });
      return null;
    }
    this.#assertPublishable();
    const backup = await this.#backup(target);
    this.#assertPublishable();
    if (this.#publishPlan) {
      this.#publishPlan.entries.set(target, { operation: "write", content: String(content) });
      return backup;
    }
    if (this.#publishSignal) {
      mkdirSync(dirname(target), { recursive: true });
      this.#assertPublishable();
      const temp = join(dirname(target), `.514forge.${randomUUID()}.tmp`);
      try {
        writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
        this.beforeLiveConfigPublish?.({ operation: "rename", target, temp });
        this.#assertPublishable();
        renameSyncWithRetry(temp, target);
        return backup;
      } finally {
        try { rmSync(temp, { force: true }); } catch {}
      }
    }
    await mkdir(dirname(target), { recursive: true });
    this.#assertPublishable();
    const temp = join(dirname(target), `.514forge.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
      this.#assertPublishable();
      await rename(temp, target);
      return backup;
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  /** 文件删除（claude-desktop 官方回切 profile）：干跑记录移除标记，不动真文件。 */
  async #removeFile(target) {
    if (this.#dryRunFiles) {
      this.#dryRunFiles.set(target, { removed: true });
      return;
    }
    this.#assertPublishable();
    if (this.#publishPlan) {
      await this.#capturePublishSnapshot(target);
      this.#assertPublishable();
      this.#publishPlan.entries.set(target, { operation: "remove", content: null });
      return;
    }
    if (this.#publishSignal) {
      this.beforeLiveConfigPublish?.({ operation: "remove", target, temp: null });
      this.#assertPublishable();
      rmSync(target, { force: true });
      return;
    }
    await rm(target, { force: true });
  }

  async #withFileRollback(targets, operation) {
    if (this.#publishPlan) return operation();
    const snapshots = [];
    for (const target of [...new Set(targets)]) {
      try {
        snapshots.push({ target, existed: true, content: await readFile(target, "utf8") });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        snapshots.push({ target, existed: false, content: null });
      }
    }
    try {
      return await operation();
    } catch (error) {
      const rollbackErrors = [];
      for (const snapshot of snapshots.reverse()) {
        try {
          if (this.#publishSignal) {
            if (!snapshot.existed) {
              rmSync(snapshot.target, { force: true });
              continue;
            }
            mkdirSync(dirname(snapshot.target), { recursive: true });
            const temp = join(dirname(snapshot.target), `.514forge-rollback.${randomUUID()}.tmp`);
            try {
              writeFileSync(temp, snapshot.content, { encoding: "utf8", mode: 0o600 });
              renameSyncWithRetry(temp, snapshot.target, { deadline: () => this.#publishDeadlineValue() });
            } finally {
              try { rmSync(temp, { force: true }); } catch {}
            }
            continue;
          }
          if (!snapshot.existed) {
            await rm(snapshot.target, { force: true });
            continue;
          }
          await mkdir(dirname(snapshot.target), { recursive: true });
          const temp = join(dirname(snapshot.target), `.514forge-rollback.${randomUUID()}.tmp`);
          try {
            await writeFile(temp, snapshot.content, { encoding: "utf8", mode: 0o600 });
            await rename(temp, snapshot.target);
          } finally {
            await rm(temp, { force: true }).catch(() => {});
          }
        } catch (rollbackError) {
          rollbackErrors.push(`${snapshot.target}: ${rollbackError.message}`);
        }
      }
      if (rollbackErrors.length) error.rollbackErrors = rollbackErrors;
      throw error;
    }
  }

  async #writeJson5(target, mutate, fallback = {}) {
    let data = JSON.parse(JSON.stringify(fallback));
    try {
      const raw = await this.#readConfigText(target);
      if (raw.trim()) data = JSON5.parse(raw);
    } catch (error) {
      if (error instanceof SyntaxError || error?.name === "SyntaxError") {
        fail(`live config is not valid JSON5: ${target}`, "INVALID_LIVE_JSON5");
      }
      throw error;
    }
    if (!isPlainObject(data)) fail(`live config root must be an object: ${target}`, "INVALID_LIVE_CONFIG");
    mutate(data);
    const backup = await this.#writeText(target, `${JSON.stringify(data, null, 2)}\n`);
    return backup;
  }

  async #writeYaml(target, mutate) {
    let data = {};
    try {
      const raw = await this.#readConfigText(target);
      if (raw.trim()) data = parseYaml(raw);
    } catch (error) {
      if (error instanceof SyntaxError || /yaml/i.test(error?.name ?? "")) {
        fail(`live config is not valid YAML: ${target}`, "INVALID_LIVE_YAML");
      }
      throw error;
    }
    if (!isPlainObject(data)) fail(`live YAML root must be an object: ${target}`, "INVALID_LIVE_CONFIG");
    mutate(data);
    const backup = await this.#writeText(target, stringifyYaml(data, { lineWidth: 0 }));
    return backup;
  }

  #localAppData() {
    if (this.runtimeHome === homedir() && process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
    return join(this.runtimeHome, "AppData", "Local");
  }

  /** 目标路径的展示形态（~ 相对 runtimeHome；外部绝对路径原样）——rawConfig 的键与预览页签同形。 */
  #shownPath(target) {
    const rel = relative(this.runtimeHome, target);
    return rel.startsWith("..") || rel === target ? target : `~/${rel.replace(/\\/g, "/")}`;
  }

  /** rawConfig 手改原文：命中即返回文本（启用按原文写入，盖过投影）；未命中 null。 */
  #rawOverride(provider, app, target) {
    const text = provider.meta?.rawConfig?.[app]?.[this.#shownPath(target)];
    return typeof text === "string" && text.trim() ? text : null;
  }

  /** raw 原文写入（统一走 #writeText：干跑收集/真写备份同路径）；保证尾部换行。 */
  async #writeRaw(target, text) {
    return this.#writeText(target, text.endsWith("\n") ? text : `${text}\n`);
  }

  async #applyClaude(provider) {
    const target = join(this.runtimeHome, ".claude", "settings.json");
    const raw = this.#rawOverride(provider, "claude", target);
    if (raw != null) {
      const backup = await this.#writeRaw(target, raw);
      return { target, backup, keys: ["rawConfig"] };
    }
    const env = claudeEnvProjection(provider);
    // cc-switch common config snippet：通用 JSON 片段并入顶层；provider extraSettings（预设附带
    // settings.json 片段如 effortLevel/includeCoAuthoredBy）盖 common 同位键；env 三层合并——
    // common env 铺底 → provider 投影 env 盖顶（五开关场景：attribution 顶层 + env 四键都要进）
    const common = this.commonConfig.claude.trim() ? JSON.parse(this.commonConfig.claude) : null;
    const extraSettings = provider.meta?.extraSettings ?? {};
    const backup = await this.#writeJson(target, (data) => {
      if (common) {
        for (const [key, value] of Object.entries(common)) {
          if (key === "env") continue; // env 走下方三层合并
          data[key] = value;
        }
      }
      for (const [key, value] of Object.entries(extraSettings)) data[key] = value;
      if (typeof data.env !== "object" || data.env === null || Array.isArray(data.env)) data.env = {};
      if (common?.env && typeof common.env === "object" && !Array.isArray(common.env)) {
        for (const [key, value] of Object.entries(common.env)) data.env[key] = value;
      }
      for (const [key, value] of Object.entries(env)) data.env[key] = value;
    });
    return { target, backup, keys: Object.keys(env) };
  }

  async #applyCodex(provider) {
    const projection = codexConfigProjection(provider);
    const authPath = join(this.runtimeHome, ".codex", "auth.json");
    const tomlPath = join(this.runtimeHome, ".codex", "config.toml");
    const catalogPath = join(this.runtimeHome, ".codex", CODEX_MANAGED_CATALOG_FILENAME);
    const rawAuth = this.#rawOverride(provider, "codex", authPath);
    const rawToml = this.#rawOverride(provider, "codex", tomlPath);
    return this.#withFileRollback([authPath, tomlPath, catalogPath], async () => {
      const results = [];
      const catalog = buildCodexModelCatalog(projection.modelCatalog, {
        reasoningEffort: projection.reasoningEffort,
        defaultContextWindow: projection.codexProviderExtra.model_context_window,
      });
      const rawCatalogPointer = rawToml == null ? null : codexCatalogPointer(rawToml);
      if (isManagedCodexCatalogPointer(rawCatalogPointer) && !catalog.models.length) {
        fail("raw Codex config references the 514cc model catalog but no model mapping is configured", "CODEX_MODEL_CATALOG_REQUIRED");
      }
      if (rawAuth != null) {
        const backup = await this.#writeRaw(authPath, rawAuth);
        results.push({ target: authPath, backup, keys: ["rawConfig"] });
      } else if (projection.apiKey) {
        const backup = await this.#writeJson(authPath, (data) => {
          data.OPENAI_API_KEY = projection.apiKey;
        });
        results.push({ target: authPath, backup, keys: ["OPENAI_API_KEY"] });
      }
      if (rawToml != null) {
        const backup = await this.#writeRaw(tomlPath, rawToml);
        results.push({ target: tomlPath, backup, keys: ["rawConfig"] });
        if (isManagedCodexCatalogPointer(rawCatalogPointer)) {
          const catalogBackup = await this.#writeText(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
          results.push({ target: catalogPath, backup: catalogBackup, keys: ["models"] });
        } else {
          const catalogBackup = await this.#backup(catalogPath);
          await this.#removeFile(catalogPath);
          results.push({ target: catalogPath, backup: catalogBackup, removed: true, keys: [] });
        }
        return results;
      }
      let original = "";
      original = await this.#readConfigText(tomlPath);
      const catalogPointer = codexCatalogPointer(original);
      if (catalog.models.length && catalogPointer && !isManagedCodexCatalogPointer(catalogPointer)) {
        fail("existing Codex model_catalog_json is user-managed; remove it explicitly before enabling a 514cc model mapping", "CODEX_MODEL_CATALOG_CONFLICT");
      }
      // 段落布局与 cc-switch generateThirdPartyConfig 对齐：name/base_url/wire_api/requires_openai_auth
      // + 预设 section 附加键（env_key/query_params 等）+ common TOML 片段，随标记块整体摘换
      const sectionBody = [`name = ${JSON.stringify(provider.name)}`];
      if (projection.baseUrl) sectionBody.push(`base_url = ${JSON.stringify(projection.baseUrl)}`);
      sectionBody.push(`wire_api = ${JSON.stringify(projection.wireApi)}`);
      sectionBody.push("requires_openai_auth = true");
      for (const [key, raw] of Object.entries(projection.codexProviderExtra)) sectionBody.push(`${key} = ${raw}`);
      const commonToml = this.commonConfig.codex.trim();
      if (commonToml) sectionBody.push(...commonToml.split(/\r?\n/));
      // codexTop 白名单键全量发声：有值写 raw RHS，缺省发 "" 摘除——切换不残留
      const topKeys = {
        model_provider: projection.baseUrl ? "forge" : "",
        model: projection.model,
        model_reasoning_effort: projection.reasoningEffort,
      };
      if (catalog.models.length) topKeys.model_catalog_json = CODEX_MANAGED_CATALOG_FILENAME;
      else if (isManagedCodexCatalogPointer(catalogPointer)) topKeys.model_catalog_json = "";
      for (const key of CODEX_TOP_KEYS) topKeys[key] = { raw: projection.codexTop[key] ?? "" };
      const content = spliceToml(original, {
        blockId: provider.id,
        topKeys,
        sectionName: projection.baseUrl ? "model_providers.forge" : null,
        sectionBody,
      });
      const backup = await this.#writeText(tomlPath, content);
      results.push({ target: tomlPath, backup, keys: ["model_provider", "model", "model_reasoning_effort"] });
      if (catalog.models.length) {
        const catalogBackup = await this.#writeText(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
        results.push({ target: catalogPath, backup: catalogBackup, keys: ["models"] });
      } else if (isManagedCodexCatalogPointer(catalogPointer)) {
        const catalogBackup = await this.#backup(catalogPath);
        await this.#removeFile(catalogPath);
        results.push({ target: catalogPath, backup: catalogBackup, removed: true, keys: [] });
      }
      return results;
    });
  }

  async #applyGemini(provider) {
    const target = join(this.runtimeHome, ".gemini", ".env");
    const raw = this.#rawOverride(provider, "gemini", target);
    if (raw != null) {
      const backup = await this.#writeRaw(target, raw);
      return { target, backup, keys: ["rawConfig"] };
    }
    const env = geminiEnvProjection(provider);
    const original = await this.#readConfigText(target);
    // common config（KEY=VALUE 行）：并入块内，provider 投影键优先（common 在前，投影覆盖同名）
    const merged = {};
    for (const line of this.commonConfig.gemini.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (match) merged[match[1]] = match[2].trim();
    }
    Object.assign(merged, env);
    const backup = await this.#writeText(target, spliceEnv(original, provider.id, merged));
    return { target, backup, keys: Object.keys(env) };
  }

  #claudeDesktopPaths() {
    const localAppData = this.#localAppData();
    const normal = join(localAppData, "Claude", "claude_desktop_config.json");
    const threepRoot = join(localAppData, "Claude-3p");
    const threep = join(threepRoot, "claude_desktop_config.json");
    const library = join(threepRoot, "configLibrary");
    return {
      normal,
      threep,
      profile: join(library, "00000000-0000-4000-8000-000000157210.json"),
      meta: join(library, "_meta.json"),
    };
  }

  async #applyClaudeDesktop(provider) {
    const paths = this.#claudeDesktopPaths();
    const targets = [paths.normal, paths.threep, paths.profile, paths.meta];
    const config = provider.meta?.appConfig?.["claude-desktop"] ?? {};
    return this.#withFileRollback(targets, async () => {
      const results = [];
      const official = provider.category === "official" && !provider.baseUrl;
      for (const target of [paths.normal, paths.threep]) {
        const raw = this.#rawOverride(provider, "claude-desktop", target);
        if (raw != null) {
          const backup = await this.#writeRaw(target, raw);
          results.push({ target, backup, keys: ["rawConfig"] });
          continue;
        }
        const backup = await this.#writeJson(target, (data) => {
          data.deploymentMode = official ? "1p" : "3p";
          if (official && isPlainObject(data.enterpriseConfig)) {
            for (const key of [
              "disableDeploymentModeChooser",
              "inferenceGatewayApiKey",
              "inferenceGatewayAuthScheme",
              "inferenceGatewayBaseUrl",
              "inferenceProvider",
            ]) delete data.enterpriseConfig[key];
            if (!Object.keys(data.enterpriseConfig).length) delete data.enterpriseConfig;
          }
        });
        results.push({ target, backup, keys: ["deploymentMode"] });
      }

      if (official) {
        const rawProfile = this.#rawOverride(provider, "claude-desktop", paths.profile);
        if (rawProfile != null) {
          const profileRawBackup = await this.#writeRaw(paths.profile, rawProfile);
          results.push({ target: paths.profile, backup: profileRawBackup, keys: ["rawConfig"] });
        } else {
          const backup = await this.#backup(paths.profile);
          await this.#removeFile(paths.profile);
          results.push({ target: paths.profile, backup, removed: true });
        }
        const rawMeta = this.#rawOverride(provider, "claude-desktop", paths.meta);
        const metaBackup = rawMeta != null
          ? await this.#writeRaw(paths.meta, rawMeta)
          : await this.#writeJson(paths.meta, (data) => {
            const entries = Array.isArray(data.entries) ? data.entries : [];
            data.entries = entries.filter((entry) => entry?.id !== "00000000-0000-4000-8000-000000157210");
            if (data.appliedId === "00000000-0000-4000-8000-000000157210") {
              if (data.entries[0]?.id) data.appliedId = data.entries[0].id;
              else delete data.appliedId;
            }
          });
        results.push({ target: paths.meta, backup: metaBackup, keys: rawMeta != null ? ["rawConfig"] : ["entries", "appliedId"] });
        return results;
      }

      if (!provider.baseUrl || !provider.apiKey) {
        fail("Claude Desktop provider requires both baseUrl and apiKey", "VALIDATION_FAILED");
      }
      const mode = config.mode === "proxy" ? "proxy" : "direct";
      const proxyOrigin = this.proxyRuntime.origin || process.env.CONTROL_CENTER_PROXY_ORIGIN || "http://127.0.0.1:15721";
      const baseUrl = mode === "proxy" ? `${proxyOrigin.replace(/\/+$/, "")}/claude-desktop` : provider.baseUrl;
      const apiKey = mode === "proxy" ? (this.proxyRuntime.token || process.env.CONTROL_CENTER_PROXY_TOKEN || "514cc-local-proxy") : provider.apiKey;
      const routes = Array.isArray(config.modelRoutes) ? config.modelRoutes : [];
      const inferenceModels = routes
        .map((route) => ({
          name: String(route.routeId ?? "").trim(),
          ...(route.labelOverride ? { labelOverride: String(route.labelOverride) } : {}),
          supports1m: Boolean(route.supports1m),
        }))
        .filter((route) => route.name);
      const profile = {
        coworkEgressAllowedHosts: ["*"],
        disableDeploymentModeChooser: true,
        inferenceGatewayApiKey: apiKey,
        inferenceGatewayAuthScheme: "bearer",
        inferenceGatewayBaseUrl: baseUrl,
        inferenceProvider: "gateway",
        ...(inferenceModels.length ? { inferenceModels } : {}),
      };
      const rawProfile = this.#rawOverride(provider, "claude-desktop", paths.profile);
      const profileBackup = rawProfile != null
        ? await this.#writeRaw(paths.profile, rawProfile)
        : await this.#writeJson(paths.profile, (data) => {
          for (const key of Object.keys(data)) delete data[key];
          Object.assign(data, profile);
        });
      results.push({ target: paths.profile, backup: profileBackup, keys: rawProfile != null ? ["rawConfig"] : Object.keys(profile) });
      const rawMeta = this.#rawOverride(provider, "claude-desktop", paths.meta);
      const metaBackup = rawMeta != null
        ? await this.#writeRaw(paths.meta, rawMeta)
        : await this.#writeJson(paths.meta, (data) => {
          const entries = Array.isArray(data.entries) ? data.entries : [];
          data.entries = entries.filter((entry) => entry?.id !== "00000000-0000-4000-8000-000000157210");
          data.entries.push({ id: "00000000-0000-4000-8000-000000157210", name: "CC Switch" });
          data.appliedId = "00000000-0000-4000-8000-000000157210";
        });
      results.push({ target: paths.meta, backup: metaBackup, keys: rawMeta != null ? ["rawConfig"] : ["entries", "appliedId"] });
      return results;
    });
  }

  async #applyGrokBuild(provider) {
    const target = join(this.runtimeHome, ".grok", "config.toml");
    const raw = this.#rawOverride(provider, "grokbuild", target);
    if (raw != null) {
      const backup = await this.#writeRaw(target, raw);
      return { target, backup, keys: ["rawConfig"] };
    }
    const original = await this.#readConfigText(target);
    const config = provider.meta?.appConfig?.grokbuild ?? {};
    const official = Boolean(config.official) || (provider.category === "official" && !provider.baseUrl);
    const profile = String(config.profile || providerKeyOf(provider, "grokbuild"));
    const model = provider.models?.grokbuild?.model || provider.models?.claude?.model || "grok-4.5";
    const lines = official ? [] : [
      "[models]",
      `default = ${JSON.stringify(profile)}`,
      "",
      `[model.${JSON.stringify(profile)}]`,
      `model = ${JSON.stringify(model)}`,
      `base_url = ${JSON.stringify(provider.baseUrl)}`,
      `name = ${JSON.stringify(provider.name)}`,
      `api_key = ${JSON.stringify(provider.apiKey)}`,
      `api_backend = ${JSON.stringify(config.apiBackend || DEFAULT_GROK_API_BACKEND)}`,
      `context_window = ${clampInt(config.contextWindow, 1, 10_000_000, 500_000, "Grok context window")}`,
      ...((this.commonConfig.grokbuild || "").trim() ? ["", ...this.commonConfig.grokbuild.trim().split(/\r?\n/)] : []),
    ];
    if (!official && (!provider.baseUrl || !provider.apiKey)) fail("Grok Build provider requires both baseUrl and apiKey", "VALIDATION_FAILED");
    // 先摘旧管理块 → 再清掉块外的 [models]/[model."*"]（外部工具或手改留下的同命名空间表，
    // 不清就是重复表定义 / 旧表遮盖）→ 最后写入新块。LO 自有的其它表全程不动。
    const base = stripGrokModelTables(spliceManagedBlock(original, "grokbuild", provider.id, []));
    const backup = await this.#writeText(target, spliceManagedBlock(base, "grokbuild", provider.id, lines));
    return { target, backup, keys: official ? [] : ["models.default", `model.${profile}`] };
  }

  // Kimi Code → ~/.kimi-code/config.toml：顶层 default_model + 标记块内
  // [providers."514cc:<key>"] / [models."514cc:<key>/<model>"] 两表（官方文档封闭字段）。
  // 块外用户自有 providers/models/services 一律不动；切换即整块摘换，不残留。
  async #applyKimi(provider) {
    const target = join(this.runtimeHome, ".kimi-code", "config.toml");
    const raw = this.#rawOverride(provider, "kimi", target);
    if (raw != null) {
      const backup = await this.#writeRaw(target, raw);
      return { target, backup, keys: ["rawConfig"] };
    }
    const original = await this.#readConfigText(target);
    const config = provider.meta?.appConfig?.kimi ?? {};
    const providerKey = `514cc:${providerKeyOf(provider, "kimi")}`;
    const model = String(provider.models?.kimi?.model || "").trim();
    if (!model) fail("Kimi Code 供应商需要填写默认模型——config.toml 的 default_model 必须指向已声明的 [models] 别名", "VALIDATION_FAILED");
    const type = String(config.providerType || KIMI_TYPE_BY_API_FORMAT[provider.meta?.apiFormat] || "openai").trim();
    if (!KIMI_PROVIDER_TYPES.has(type)) fail(`kimi providerType not supported: ${type}`, "VALIDATION_FAILED");
    const alias = `${providerKey}/${model}`;
    const maxContext = clampInt(config.maxContextSize, 1, 100_000_000, 262144, "Kimi max context size");
    const capabilities = Array.isArray(config.capabilities) && config.capabilities.length
      ? config.capabilities.map((entry) => String(entry).trim()).filter(Boolean)
      // 第三方模型名前缀自动识别常落空；thinking/image_in 对齐官方 KIMI_MODEL_CAPABILITIES 缺省，
      // tool_use 是协作台 agentic 调用的硬需求。均可经 meta.appConfig.kimi.capabilities 显式收窄。
      : ["thinking", "image_in", "tool_use"];
    for (const capability of capabilities) {
      if (!KIMI_MODEL_CAPABILITIES.has(capability)) fail(`kimi model capability not supported: ${capability}`, "VALIDATION_FAILED");
    }
    const supportEfforts = Array.isArray(config.supportEfforts)
      ? config.supportEfforts.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean)
      : [];
    const providerBody = [`type = ${JSON.stringify(type)}`];
    if (provider.baseUrl) providerBody.push(`base_url = ${JSON.stringify(provider.baseUrl)}`);
    if (provider.apiKey) providerBody.push(`api_key = ${JSON.stringify(provider.apiKey)}`);
    const commonToml = (this.commonConfig.kimi || "").trim();
    if (commonToml) providerBody.push(...commonToml.split(/\r?\n/));
    const modelBody = [
      `provider = ${JSON.stringify(providerKey)}`,
      `model = ${JSON.stringify(model)}`,
      `max_context_size = ${maxContext}`,
      `capabilities = [${capabilities.map((entry) => JSON.stringify(entry)).join(", ")}]`,
      `display_name = ${JSON.stringify(provider.name)}`,
    ];
    if (supportEfforts.length) modelBody.push(`support_efforts = [${supportEfforts.map((entry) => JSON.stringify(entry)).join(", ")}]`);
    if (String(config.defaultEffort ?? "").trim()) modelBody.push(`default_effort = ${JSON.stringify(String(config.defaultEffort).trim().toLowerCase())}`);
    const content = spliceToml(original, {
      blockId: provider.id,
      topKeys: { default_model: alias },
      sections: [
        { name: `providers.${JSON.stringify(providerKey)}`, body: providerBody },
        { name: `models.${JSON.stringify(alias)}`, body: modelBody },
      ],
    });
    const backup = await this.#writeText(target, content);
    return { target, backup, keys: ["default_model", `providers.${providerKey}`, `models.${alias}`] };
  }

  async #applyOpenCode(provider) {
    const target = join(this.runtimeHome, ".config", "opencode", "opencode.json");
    const raw = this.#rawOverride(provider, "opencode", target);
    if (raw != null) {
      const backup = await this.#writeRaw(target, raw);
      return { target, backup, keys: ["rawConfig"] };
    }
    const config = provider.meta?.appConfig?.opencode ?? {};
    const providerKey = providerKeyOf(provider, "opencode");
    const backup = await this.#writeJson5(target, (data) => {
      if ((this.commonConfig.opencode || "").trim()) {
        const common = JSON5.parse(this.commonConfig.opencode);
        Object.assign(data, deepMerge(data, common));
      }
      if (provider.category === "omo" || provider.category === "omo-slim") {
        const standard = ["oh-my-openagent", "oh-my-opencode"];
        const slim = ["oh-my-opencode-slim"];
        const blocked = provider.category === "omo" ? [...standard, ...slim] : [...standard, ...slim];
        const plugins = Array.isArray(data.plugin) ? data.plugin.filter((item) => !blocked.some((prefix) => item === prefix || String(item).startsWith(`${prefix}@`))) : [];
        plugins.push(provider.category === "omo" ? "oh-my-openagent" : "oh-my-opencode-slim");
        data.plugin = [...new Set(plugins)];
        return;
      }
      if (!isPlainObject(data.provider)) data.provider = {};
      if (!provider.baseUrl) fail("OpenCode 供应商需要填写请求地址（Base URL）——空地址写出的配置 CLI 不可用", "VALIDATION_FAILED");
      let settings = replaceProviderPlaceholders(config.settingsConfig ?? {}, provider);
      if (!isPlainObject(settings.options)) settings.options = {};
      if (provider.baseUrl) settings.options.baseURL = provider.baseUrl;
      if (provider.apiKey) settings.options.apiKey = provider.apiKey;
      if (!settings.name) settings.name = provider.name;
      // 缺省 AI SDK 适配器与模型表——没有 npm 的自定义供应商 opencode 根本加载不了
      if (!settings.npm) settings.npm = OPENCODE_NPM_BY_FORMAT[provider.meta?.apiFormat] ?? "@ai-sdk/openai-compatible";
      const model = provider.models?.opencode?.model || "";
      if (!isPlainObject(settings.models)) settings.models = {};
      const existingModels = isPlainObject(data.provider?.[providerKey]?.models)
        ? data.provider[providerKey].models
        : {};
      settings.models = { ...existingModels, ...settings.models };
      // 顶层 model 指针必须能在模型表里找到——只改指针、表里还是另一档，headless `opencode run` 会打空
      if (model && !settings.models[model]) settings.models[model] = { name: model };
      data.provider[providerKey] = settings;
      // 顶层 model 指针：没有它 CLI 仍停在默认/上次供应商——「启用了但没生效」的根因
      if (model) data.model = `${providerKey}/${model}`;
    }, { $schema: "https://opencode.ai/config.json" });
    return { target, backup, keys: provider.category === "omo" || provider.category === "omo-slim" ? ["plugin"] : [`provider.${providerKey}`] };
  }

  async #applyOpenClaw(provider) {
    const target = join(this.runtimeHome, ".openclaw", "openclaw.json");
    const raw = this.#rawOverride(provider, "openclaw", target);
    if (raw != null) {
      const backup = await this.#writeRaw(target, raw);
      return { target, backup, keys: ["rawConfig"] };
    }
    const config = provider.meta?.appConfig?.openclaw ?? {};
    const providerKey = providerKeyOf(provider, "openclaw");
    const backup = await this.#writeJson5(target, (data) => {
      if ((this.commonConfig.openclaw || "").trim()) {
        Object.assign(data, deepMerge(data, JSON5.parse(this.commonConfig.openclaw)));
      }
      if (!isPlainObject(data.models)) data.models = { mode: "merge", providers: {} };
      data.models.mode = data.models.mode || "merge";
      if (!isPlainObject(data.models.providers)) data.models.providers = {};
      const settings = replaceProviderPlaceholders(config.settingsConfig ?? {}, provider);
      if (provider.baseUrl) settings.baseUrl = provider.baseUrl;
      if (provider.apiKey) settings.apiKey = provider.apiKey;
      data.models.providers[providerKey] = settings;
      if (isPlainObject(config.suggestedDefaults)) {
        if (!isPlainObject(data.agents)) data.agents = {};
        data.agents.defaults = deepMerge(data.agents.defaults, config.suggestedDefaults);
      }
    }, { models: { mode: "merge", providers: {} } });
    return { target, backup, keys: [`models.providers.${providerKey}`, "agents.defaults"] };
  }

  async #applyHermes(provider) {
    const hermesRoot = this.runtimeHome === homedir() && process.platform === "win32"
      ? join(this.#localAppData(), "hermes")
      : join(this.runtimeHome, ".hermes");
    const target = join(hermesRoot, "config.yaml");
    const raw = this.#rawOverride(provider, "hermes", target);
    if (raw != null) {
      const backup = await this.#writeRaw(target, raw);
      return { target, backup, keys: ["rawConfig"] };
    }
    const config = provider.meta?.appConfig?.hermes ?? {};
    const providerKey = providerKeyOf(provider, "hermes");
    const backup = await this.#writeYaml(target, (data) => {
      if ((this.commonConfig.hermes || "").trim()) Object.assign(data, deepMerge(data, parseYaml(this.commonConfig.hermes)));
      if (!Array.isArray(data.custom_providers)) data.custom_providers = [];
      const existing = data.custom_providers.find((entry) => entry?.name === providerKey) ?? {};
      const settings = deepMerge(existing, replaceProviderPlaceholders(config.settingsConfig ?? {}, provider));
      settings.name = providerKey;
      if (provider.baseUrl) settings.base_url = provider.baseUrl;
      if (provider.apiKey) settings.api_key = provider.apiKey;
      const models = Array.isArray(settings.models) ? settings.models : [];
      if (models[0]?.id && !settings.model) settings.model = models[0].id;
      data.custom_providers = data.custom_providers.filter((entry) => entry?.name !== providerKey);
      data.custom_providers.push(settings);
      if (isPlainObject(config.suggestedDefaults?.model)) data.model = deepMerge(data.model, config.suggestedDefaults.model);
      else {
        if (!isPlainObject(data.model)) data.model = {};
        data.model.provider = providerKey;
        if (models[0]?.id) data.model.default = models[0].id;
      }
    });
    return { target, backup, keys: [`custom_providers.${providerKey}`, "model"] };
  }

  /** 切到应用内置官方登录：Grok 写回空 config.toml，current 指针清空。 */
  switchToOfficial(app) {
    if (app !== "grokbuild") fail("official login switch is only supported for Grok Build", "VALIDATION_FAILED");
    return this.#withProjectionLock(app, () => this.#switchToOfficialSerialized(app));
  }

  #switchToOfficialSerialized(app) {
    return this.#serialize(async () => {
      const candidate = this.#snapshotState();
      candidate.current[app] = null;
      const previousSignal = this.#publishSignal;
      const previousDeadline = this.#publishDeadline;
      const previousPlan = this.#publishPlan;
      const previousBackupContext = this.#backupContext;
      const publishPlan = { entries: new Map(), snapshots: new Map(), backups: new Map(), rollbackTemps: new Map() };
      this.#publishSignal = null;
      this.#publishDeadline = Infinity;
      this.#publishPlan = publishPlan;
      this.#backupContext = { app, providerId: OFFICIAL_PROVIDER_SWITCH_ID, providerName: "Grok Official", reason: "switch" };
      try {
        const applied = await this.#applyGrokBuild({
          id: OFFICIAL_PROVIDER_SWITCH_ID,
          name: "Grok Official",
          baseUrl: "",
          apiKey: "",
          category: "official",
          models: {},
          meta: { appConfig: { grokbuild: { official: true } } },
        });
        await this.#stageSidecarWrites([{ target: this.path, content: this.#stateContent(candidate) }]);
        this.#commitPublishPlanSync(publishPlan, () => this.#installState(candidate));
        await this.eventStore?.emit("provider.switch", { app, providerId: OFFICIAL_PROVIDER_SWITCH_ID, name: "Grok Official" }).catch(() => {});
        return { app, official: true, provider: { id: OFFICIAL_PROVIDER_SWITCH_ID, name: "Grok Official" }, applied: Array.isArray(applied) ? applied : [applied] };
      } finally {
        this.#publishSignal = previousSignal;
        this.#publishDeadline = previousDeadline;
        this.#publishPlan = previousPlan;
        this.#backupContext = previousBackupContext;
      }
    });
  }

  /** 一键切换：投影 → 备份 → 原子写 → current 指针落盘 → 审计事件。 */
  switchTo(app, providerId) {
    if (!PROVIDER_APPS.includes(app)) fail(`unknown app: ${app}`, "VALIDATION_FAILED");
    return this.#withProjectionLock(app, () => this.#switchToSerialized(app, providerId));
  }

  #switchToSerialized(app, providerId) {
    if (providerId === OFFICIAL_PROVIDER_SWITCH_ID) return this.#switchToOfficialSerialized(app);
    return this.#serialize(async () => {
      const provider = this.get(providerId);
      if (!provider.apps[app]) fail(`provider "${provider.name}" is not enabled for ${APP_LABELS[app]}`, "VALIDATION_FAILED");
      const candidate = this.#snapshotState();
      candidate.current[app] = provider.id;
      const projected = this.#projectedProvider(app, provider);
      const previousSignal = this.#publishSignal;
      const previousDeadline = this.#publishDeadline;
      const previousPlan = this.#publishPlan;
      const previousBackupContext = this.#backupContext;
      const publishPlan = { entries: new Map(), snapshots: new Map(), backups: new Map(), rollbackTemps: new Map() };
      this.#publishSignal = null;
      this.#publishDeadline = Infinity;
      this.#publishPlan = publishPlan;
      // 备份清单归属：这次备份是「切到哪个档案」留下的，回退面板才能说清 from/to
      this.#backupContext = { app, providerId: provider.id, providerName: provider.name, reason: "switch" };
      try {
        let applied;
        if (app === "claude") applied = await this.#applyClaude(projected);
        else if (app === "claude-desktop") applied = await this.#applyClaudeDesktop(projected);
        else if (app === "codex") applied = await this.#applyCodex(projected);
        else if (app === "gemini") applied = await this.#applyGemini(projected);
        else if (app === "grokbuild") applied = await this.#applyGrokBuild(projected);
        else if (app === "kimi") applied = await this.#applyKimi(projected);
        else if (app === "opencode") applied = await this.#applyOpenCode(projected);
        else if (app === "openclaw") applied = await this.#applyOpenClaw(projected);
        else if (app === "hermes") applied = await this.#applyHermes(projected);
        else fail(`no writer registered for ${app}`, "APP_NOT_SUPPORTED");
        await this.#stageSidecarWrites([{ target: this.path, content: this.#stateContent(candidate) }]);
        this.#commitPublishPlanSync(publishPlan, () => this.#installState(candidate));
        await this.eventStore?.emit("provider.switch", { app, providerId: provider.id, name: provider.name }).catch(() => {});
        return { app, provider: publicView(provider), applied: Array.isArray(applied) ? applied : [applied] };
      } finally {
        this.#publishSignal = previousSignal;
        this.#publishDeadline = previousDeadline;
        this.#publishPlan = previousPlan;
        this.#backupContext = previousBackupContext;
      }
    });
  }

  withProviderProjection(app, providerIdOrResolver, operation) {
    if (!PROVIDER_APPS.includes(app)) fail(`unknown app: ${app}`, "VALIDATION_FAILED");
    if (typeof operation !== "function") fail("provider projection operation must be a function", "VALIDATION_FAILED");
    return this.#withProjectionLock(app, async () => {
      const providerId = typeof providerIdOrResolver === "function"
        ? await providerIdOrResolver()
        : providerIdOrResolver;
      if (providerId !== null && providerId !== undefined) {
        if (typeof providerId !== "string" || !providerId) {
          fail("provider projection resolver must return a provider id or null", "VALIDATION_FAILED");
        }
        if (this.current?.[app] !== providerId) await this.#switchToSerialized(app, providerId);
      }
      return operation(providerId ?? null);
    });
  }

  /** 配置预览干跑：表单草稿（可带 id 指向已存档案）经 applier 原逻辑跑一遍，
      写盘全部改收集——回显「启用后完整文件」（默认密钥掩码，reveal 显式取明文；不落盘、不备份、不动 current 指针）。
      合并语义镜像 update：草稿字段盖已存档案，apiKey/usage 密钥留空 = 保留现值；
      draft.meta.rawConfig 按补丁合并（字符串=覆盖，null=删除，未提及保留）。 */
  previewSwitch(app, draft = {}, { reveal = false, baseFiles = null } = {}) {
    if (!PROVIDER_APPS.includes(app)) fail(`unknown app: ${app}`, "VALIDATION_FAILED");
    return this.#serialize(async () => {
      const stored = draft.id ? (this.providers.get(String(draft.id)) ?? null) : null;
      const draftMeta = isPlainObject(draft.meta) ? JSON.parse(JSON.stringify(draft.meta)) : {};
      // 表单密钥位空值/掩码占位不盖已存真值（「留空 = 保留」语义）
      if (isPlainObject(draftMeta.usageScript)) {
        for (const key of ["apiKey", "accessToken"]) {
          if (!draftMeta.usageScript[key] || draftMeta.usageScript[key] === "<redacted>") delete draftMeta.usageScript[key];
        }
      }
      if (isPlainObject(draftMeta.proxyConfig) && (!draftMeta.proxyConfig.password || draftMeta.proxyConfig.password === "<redacted>")) {
        delete draftMeta.proxyConfig.password;
      }
      const rawConfig = draftMeta.rawConfig !== undefined
        ? mergeRawConfigPatch(stored?.meta?.rawConfig, draftMeta.rawConfig, { validate: false })
        : stored?.meta?.rawConfig ?? null;
      delete draftMeta.rawConfig;
      const provider = {
        ...(stored ?? {}),
        id: stored?.id ?? "__preview__",
        name: String(draft.name ?? stored?.name ?? "").trim(),
        baseUrl: String(draft.baseUrl ?? stored?.baseUrl ?? "").trim(),
        apiKey: String(draft.apiKey ?? "").trim() || stored?.apiKey || "",
        websiteUrl: draft.websiteUrl ?? stored?.websiteUrl ?? "",
        notes: draft.notes ?? stored?.notes ?? "",
        category: draft.category ?? stored?.category ?? "custom",
        apps: { ...(stored?.apps ?? {}), ...(isPlainObject(draft.apps) ? draft.apps : {}) },
        models: { ...(stored?.models ?? {}), ...(isPlainObject(draft.models) ? draft.models : {}) },
        meta: { ...deepMerge(stored?.meta ?? {}, draftMeta), ...(rawConfig ? { rawConfig } : {}) },
      };
      if (!provider.name) fail("provider name is required", "VALIDATION_FAILED");
      if (!provider.apps?.[app]) fail(`provider "${provider.name}" is not enabled for ${APP_LABELS[app]}`, "VALIDATION_FAILED");
      const projected = this.#projectedProvider(app, provider);
      const baseEntries = baseFiles instanceof Map
        ? [...baseFiles.entries()]
        : baseFiles && typeof baseFiles === "object"
          ? Object.entries(baseFiles)
          : null;
      if (baseEntries && (baseEntries.length > 32 || baseEntries.some(([path, content]) => {
        const key = String(path);
        return !key || key.length > 1024 || key.includes("\0") || Buffer.byteLength(String(content ?? "")) > 1024 * 1024;
      }))) {
        fail("preview baseFiles exceeds the remote projection boundary", "VALIDATION_FAILED");
      }
      this.#dryRunFiles = new Map();
      this.#dryRunBaseFiles = baseEntries ? new Map(baseEntries.map(([path, content]) => [String(path), String(content ?? "")])) : null;
      let collected;
      try {
        if (app === "claude") await this.#applyClaude(projected);
        else if (app === "claude-desktop") await this.#applyClaudeDesktop(projected);
        else if (app === "codex") await this.#applyCodex(projected);
        else if (app === "gemini") await this.#applyGemini(projected);
        else if (app === "grokbuild") await this.#applyGrokBuild(projected);
        else if (app === "kimi") await this.#applyKimi(projected);
        else if (app === "opencode") await this.#applyOpenCode(projected);
        else if (app === "openclaw") await this.#applyOpenClaw(projected);
        else if (app === "hermes") await this.#applyHermes(projected);
        else fail(`no writer registered for ${app}`, "APP_NOT_SUPPORTED");
      } finally {
        collected = this.#dryRunFiles;
        this.#dryRunFiles = null;
        this.#dryRunBaseFiles = null;
      }
      const files = [...collected].map(([target, entry]) => {
        const shown = this.#shownPath(target);
        if (entry.removed) return { path: shown, removed: true };
        return { path: shown, content: reveal ? entry.content : maskConfigSecrets(entry.content) };
      });
      return { app, provider: publicView(provider), files };
    });
  }

  setProxyTakeover(app, enabled, {
    signal = null,
    deadline = Infinity,
    sidecarWrites = [],
    onCommitted = null,
    queueIfProjectionHeld = false,
  } = {}) {
    if (!PROVIDER_APPS.includes(app)) fail(`unknown app: ${app}`, "VALIDATION_FAILED");
    if (sidecarWrites?.length && !signal) fail("sidecar writes require an AbortSignal", "VALIDATION_FAILED");
    if (onCommitted !== null && typeof onCommitted !== "function") fail("onCommitted must be a function", "VALIDATION_FAILED");
    if (onCommitted && !signal) fail("onCommitted requires an AbortSignal", "VALIDATION_FAILED");
    return this.#withProjectionLock(app, () => this.#serialize(async () => {
      this.#assertPublishable(signal);
      const currentId = this.current[app];
      if (!currentId) fail(`no current provider for ${APP_LABELS[app]}`, "VALIDATION_FAILED");
      const previousTakeover = this.proxyRuntime.takeover.has(app);
      const previousSignal = this.#publishSignal;
      const previousDeadline = this.#publishDeadline;
      const previousPlan = this.#publishPlan;
      const publishPlan = signal
        ? { entries: new Map(), snapshots: new Map(), backups: new Map(), rollbackTemps: new Map() }
        : null;
      this.#publishSignal = signal;
      this.#publishDeadline = deadline;
      this.#publishPlan = publishPlan;
      try {
        this.#assertPublishable();
        const provider = this.get(currentId);
        const projected = this.#projectedProvider(app, provider, Boolean(enabled));
        const commitRuntime = () => {
          if (enabled) this.proxyRuntime.takeover.add(app);
          else this.proxyRuntime.takeover.delete(app);
          if (previousTakeover !== Boolean(enabled)) {
            this.#proxyTakeoverRevisions[app] += 1;
          }
          onCommitted?.({
            app,
            enabled: Boolean(enabled),
            providerId: currentId,
          });
        };
        let applied;
        if (app === "claude") applied = await this.#applyClaude(projected);
        else if (app === "claude-desktop") applied = await this.#applyClaudeDesktop(projected);
        else if (app === "codex") applied = await this.#applyCodex(projected);
        else if (app === "gemini") applied = await this.#applyGemini(projected);
        else if (app === "grokbuild") applied = await this.#applyGrokBuild(projected);
        else if (app === "kimi") applied = await this.#applyKimi(projected);
        else if (app === "opencode") applied = await this.#applyOpenCode(projected);
        else if (app === "openclaw") applied = await this.#applyOpenClaw(projected);
        else if (app === "hermes") applied = await this.#applyHermes(projected);
        if (publishPlan) {
          await this.#stageSidecarWrites(sidecarWrites);
          await this.beforeLiveConfigPlanCommit?.({
            app,
            enabled: Boolean(enabled),
            targets: [...publishPlan.entries.keys()],
          });
          this.#assertPublishable();
          this.#commitPublishPlanSync(publishPlan, commitRuntime);
        } else {
          commitRuntime();
        }
        return { app, enabled, providerId: currentId, applied: Array.isArray(applied) ? applied : [applied] };
      } catch (error) {
        if (previousTakeover) this.proxyRuntime.takeover.add(app);
        else this.proxyRuntime.takeover.delete(app);
        throw error;
      } finally {
        this.#publishSignal = previousSignal;
        this.#publishDeadline = previousDeadline;
        this.#publishPlan = previousPlan;
      }
    }), { queueIfHeld: queueIfProjectionHeld });
  }

  markProxyCurrent(app, providerId, { proxyObserved = false } = {}) {
    if (!PROVIDER_APPS.includes(app)) fail(`unknown app: ${app}`, "VALIDATION_FAILED");
    const observedTakeoverRevision = this.#proxyTakeoverRevisions[app];
    const persistCurrent = ({ requireSameTakeover = false } = {}) => this.#serialize(async () => {
      if (
        requireSameTakeover
        && (
          !this.proxyRuntime.takeover.has(app)
          || this.#proxyTakeoverRevisions[app] !== observedTakeoverRevision
        )
      ) {
        return { app, providerId, ignored: true, reason: "takeover-changed" };
      }
      const provider = this.get(providerId);
      if (!provider.apps?.[app]) fail(`provider "${provider.name}" is not enabled for ${APP_LABELS[app]}`, "VALIDATION_FAILED");
      const candidate = this.#snapshotState();
      candidate.current[app] = providerId;
      await this.#commitState(candidate);
      return { app, providerId };
    });
    // Proxy takeover keeps the live CLI pinned to the local proxy endpoint. Its own successful
    // request may therefore update only the upstream pointer without waiting behind the operation
    // that issued that request. The takeover revision makes this conditional write stale if a
    // queued close/restore wins first, so current can never move away from the live direct config.
    // External callers still queue behind the app projection lock.
    if (proxyObserved && this.proxyRuntime.takeover.has(app)) {
      return persistCurrent({ requireSameTakeover: true });
    }
    return this.#withProjectionLock(app, async () => {
      // takeover 关闭时 current 与 live CLI 配置必须保持同一事实；只改指针会让下一次
      // execution projection 误以为已经切到 providerId，实际请求却仍发往旧 Provider。
      if (!this.proxyRuntime.takeover.has(app)) {
        await this.#switchToSerialized(app, providerId);
        return { app, providerId };
      }
      return persistCurrent();
    });
  }

  /** 团队绑定扩展（cc-switch 没有的面）：一组绑定一次应用，逐 app 如实回报成败——部分失败不吞。 */
  async applyTeamBindings(team, { apps = PROVIDER_SCHEME_APPS } = {}) {
    const bindings = team?.providers ?? {};
    const requestedApps = new Set(Array.isArray(apps) ? apps.filter((app) => PROVIDER_SCHEME_APPS.includes(app)) : PROVIDER_SCHEME_APPS);
    const results = [];
    for (const app of PROVIDER_APPS) {
      if (!requestedApps.has(app)) continue;
      const providerId = bindings[app];
      if (!providerId) continue;
      try {
        results.push({ app, ok: true, ...(await this.switchTo(app, providerId)) });
      } catch (error) {
        results.push({ app, ok: false, providerId, error: error.message, code: error.code ?? null });
      }
    }
    return { teamId: team.id, teamName: team.name, applied: results, skipped: results.length === 0 };
  }

  /** live 状态回读：current 指针不是唯一真源——外部手改/别的工具切了，照实显示并尝试按 baseUrl 认亲。 */
  async liveStatus() {
    const live = {};
    // claude：settings.json env
    try {
      const data = JSON.parse(await readFile(join(this.runtimeHome, ".claude", "settings.json"), "utf8"));
      const env = data?.env ?? {};
      live.claude = {
        baseUrl: env.ANTHROPIC_BASE_URL ?? null,
        model: env.ANTHROPIC_MODEL ?? null,
        matchedProviderId: this.#matchByBaseUrl("claude", env.ANTHROPIC_BASE_URL),
      };
    } catch {
      live.claude = { baseUrl: null, model: null, matchedProviderId: null };
    }
    // codex：标记块认亲优先，base_url 次之；认证只返回脱敏分类。
    try {
      const toml = await readFile(join(this.runtimeHome, ".codex", "config.toml"), "utf8");
      const marker = toml.match(/# >>> 514-forge-provider \(([^)]+)\) >>>/);
      const baseUrl = toml.match(/^\s*base_url\s*=\s*"([^"]+)"/m)?.[1] ?? null;
      const model = toml.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] ?? null;
      const activeProvider = toml.match(/^\s*model_provider\s*=\s*"([^"]+)"/m)?.[1] ?? null;
      const auth = await codexAuthStatus(this.runtimeHome);
      live.codex = {
        baseUrl,
        model,
        matchedProviderId: marker?.[1] && this.providers.has(marker[1]) ? marker[1] : this.#matchByBaseUrl("codex", baseUrl, codexBaseUrl),
        ...auth,
        official: auth.officialCredentialAvailable && !marker && (!activeProvider || activeProvider === "openai"),
      };
    } catch {
      const auth = await codexAuthStatus(this.runtimeHome);
      live.codex = { baseUrl: null, model: null, matchedProviderId: null, ...auth, official: auth.officialCredentialAvailable };
    }
    // gemini：.env 块
    try {
      const envText = await readFile(join(this.runtimeHome, ".gemini", ".env"), "utf8");
      const baseUrl = envText.match(/^GOOGLE_GEMINI_BASE_URL=(.+)$/m)?.[1]?.trim() ?? null;
      const model = envText.match(/^GEMINI_MODEL=(.+)$/m)?.[1]?.trim() ?? null;
      live.gemini = { baseUrl, model, matchedProviderId: this.#matchByBaseUrl("gemini", baseUrl) };
    } catch {
      live.gemini = { baseUrl: null, model: null, matchedProviderId: null };
    }
    // Claude Desktop：企业 configLibrary 的 applied profile 是 live 真源。
    try {
      const paths = this.#claudeDesktopPaths();
      const meta = JSON.parse(await readFile(paths.meta, "utf8"));
      const applied = meta?.appliedId;
      const profile = applied === "00000000-0000-4000-8000-000000157210"
        ? JSON.parse(await readFile(paths.profile, "utf8"))
        : null;
      const baseUrl = profile?.inferenceGatewayBaseUrl ?? null;
      const currentId = this.current["claude-desktop"];
      live["claude-desktop"] = {
        baseUrl,
        model: profile?.inferenceModels?.[0]?.name ?? null,
        mode: baseUrl?.includes("/claude-desktop") ? "proxy" : "direct",
        matchedProviderId: currentId && applied === "00000000-0000-4000-8000-000000157210"
          ? currentId
          : this.#matchByBaseUrl("claude-desktop", baseUrl),
      };
    } catch {
      live["claude-desktop"] = { baseUrl: null, model: null, mode: null, matchedProviderId: null };
    }
    // Grok Build：514 管理块 marker 可精确认亲；无自定义模型表 = 官方登录。
    // 档位/模型/backend/上下文窗口全部按生效的 [model."<档位>"] 表回读，供界面热加载显示真实 live 值。
    try {
      const toml = await readFile(join(this.runtimeHome, ".grok", "config.toml"), "utf8");
      const official = isGrokOfficialLiveConfig(toml);
      const marker = toml.match(/# >>> 514-forge-grokbuild-provider \(([^)]+)\) >>>/);
      const detail = official ? null : parseGrokLiveConfig(toml);
      live.grokbuild = {
        baseUrl: detail?.baseUrl ?? null,
        model: detail?.model ?? null,
        profile: detail?.profile ?? null,
        apiBackend: detail?.apiBackend ?? null,
        contextWindow: detail?.contextWindow ?? null,
        matchedProviderId: official
          ? null
          : marker?.[1] && this.providers.has(marker[1]) ? marker[1] : this.#matchByBaseUrl("grokbuild", detail?.baseUrl ?? null),
        official,
        authModeLabel: official ? "Grok 官方登录" : "自定义供应商",
      };
    } catch {
      live.grokbuild = {
        baseUrl: null, model: null, profile: null, apiBackend: null, contextWindow: null,
        matchedProviderId: null, official: true, authModeLabel: "Grok 官方登录",
      };
    }
    // Kimi Code：marker 认亲优先；base_url 只在 514 管理块内回读——块外用户自有的
    // providers/services 也写 base_url，全局匹配会认亲错人。514 块缺席时回读 CLI 托管的
    // [providers."managed:kimi-code"]：type "kimi" +（oauth 子表或官方域名端点）即官方登录态，
    // 以 official: true 上报（凭据由 CLI 自管，绝不落档案）。
    try {
      const toml = await readFile(join(this.runtimeHome, ".kimi-code", "config.toml"), "utf8");
      const marker = toml.match(/# >>> 514-forge-provider \(([^)]+)\) >>>/);
      const blockText = toml.match(/# >>> 514-forge-provider \([^)]*\) >>>([\s\S]*?)# <<< 514-forge-provider <<</)?.[1] ?? "";
      let baseUrl = blockText.match(/^\s*base_url\s*=\s*"([^"]+)"/m)?.[1] ?? null;
      const model = toml.match(/^\s*default_model\s*=\s*"([^"]+)"\s*$/m)?.[1] ?? null;
      // managed 表体切片：表头行之后到下一个表头（或文件尾）为止
      const managedBody = tomlTableBody(toml, 'providers."managed:kimi-code"');
      const managedBaseUrl = managedBody?.match(/^\s*base_url\s*=\s*"([^"]+)"/m)?.[1] ?? null;
      const official = !baseUrl
        && managedBody !== null
        && /^\s*type\s*=\s*"kimi"\s*$/m.test(managedBody)
        && (/^\[providers\."managed:kimi-code"\.oauth\]/m.test(toml)
          || /^https?:\/\/api\.(kimi\.com|moonshot\.cn|moonshot\.ai)(\/|$)/i.test(managedBaseUrl ?? ""));
      if (official && managedBaseUrl) baseUrl = managedBaseUrl;
      live.kimi = {
        baseUrl,
        model,
        matchedProviderId: marker?.[1] && this.providers.has(marker[1]) ? marker[1] : this.#matchByBaseUrl("kimi", baseUrl),
        ...(official ? { official: true } : {}),
      };
    } catch {
      live.kimi = { baseUrl: null, model: null, matchedProviderId: null };
    }
    // 累加式应用：current 表示最后一次由 514 应用的条目；live 中条目缺失时必须如实失配。
    try {
      const data = JSON5.parse(await readFile(join(this.runtimeHome, ".config", "opencode", "opencode.json"), "utf8"));
      const currentId = this.current.opencode;
      const currentProvider = currentId ? this.providers.get(currentId) : null;
      const key = currentProvider ? providerKeyOf(currentProvider, "opencode") : null;
      const entry = key ? data?.provider?.[key] : null;
      const baseUrl = entry?.options?.baseURL ?? entry?.options?.baseUrl ?? null;
      live.opencode = {
        baseUrl,
        model: entry ? Object.keys(entry.models ?? {})[0] ?? null : null,
        providerKey: entry ? key : null,
        matchedProviderId: entry ? currentId : this.#matchByBaseUrl("opencode", baseUrl),
      };
    } catch {
      live.opencode = { baseUrl: null, model: null, providerKey: null, matchedProviderId: null };
    }
    try {
      const data = JSON5.parse(await readFile(join(this.runtimeHome, ".openclaw", "openclaw.json"), "utf8"));
      const currentId = this.current.openclaw;
      const currentProvider = currentId ? this.providers.get(currentId) : null;
      const key = currentProvider ? providerKeyOf(currentProvider, "openclaw") : null;
      const entry = key ? data?.models?.providers?.[key] : null;
      const baseUrl = entry?.baseUrl ?? entry?.baseURL ?? null;
      live.openclaw = {
        baseUrl,
        model: entry?.models?.[0]?.id ?? data?.agents?.defaults?.model?.primary ?? null,
        providerKey: entry ? key : null,
        matchedProviderId: entry ? currentId : this.#matchByBaseUrl("openclaw", baseUrl),
      };
    } catch {
      live.openclaw = { baseUrl: null, model: null, providerKey: null, matchedProviderId: null };
    }
    try {
      const hermesRoot = this.runtimeHome === homedir() && process.platform === "win32"
        ? join(this.#localAppData(), "hermes")
        : join(this.runtimeHome, ".hermes");
      const data = parseYaml(await readFile(join(hermesRoot, "config.yaml"), "utf8"));
      const currentId = this.current.hermes;
      const currentProvider = currentId ? this.providers.get(currentId) : null;
      const key = currentProvider ? providerKeyOf(currentProvider, "hermes") : null;
      const entry = key ? data?.custom_providers?.find((item) => item?.name === key) : null;
      const baseUrl = entry?.base_url ?? null;
      live.hermes = {
        baseUrl,
        model: data?.model?.default ?? entry?.model ?? entry?.models?.[0]?.id ?? null,
        providerKey: entry ? key : null,
        matchedProviderId: entry ? currentId : this.#matchByBaseUrl("hermes", baseUrl),
      };
    } catch {
      live.hermes = { baseUrl: null, model: null, providerKey: null, matchedProviderId: null };
    }
    // live ↔ 档案 漂移：认亲到档案后逐字段比对，界面据此显示真实 live 值而不是过期档案值。
    // 只挂在认亲成功的条目上——没认亲时"漂移"无从谈起（那是未关联，另一码事）。
    for (const app of PROVIDER_APPS) {
      const entry = live[app];
      if (!isPlainRecord(entry)) continue;
      const matched = entry.matchedProviderId ? this.providers.get(entry.matchedProviderId) : null;
      entry.drift = matched ? providerLiveDrift(app, matched, entry) : [];
    }
    return live;
  }

  #matchByBaseUrl(app, baseUrl, transform = (value) => value) {
    if (!baseUrl) return null;
    const needle = String(baseUrl).replace(/\/+$/, "");
    for (const provider of this.providers.values()) {
      if (!provider.apps[app] || !provider.baseUrl) continue;
      if (transform(provider.baseUrl).replace(/\/+$/, "") === needle) return provider.id;
    }
    return null;
  }
}
