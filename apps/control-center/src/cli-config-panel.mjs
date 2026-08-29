/**
 * cli-config-panel.mjs — CLI 原生 /config 设置的只读可视化快照（T5 第一期：grok）
 *
 * 设计纪律：
 * - 白名单制：只透出 GROK_FIELD_SCHEMA 声明的键；~/.grok/config.toml 的 [model."x"] 段
 *   含明文 api_key / base_url，整段永不读取。
 * - 双重脱敏：每个字符串值走 redaction.scrub（仓内出站文本统一出口）；FORBIDDEN_FIELD_KEY
 *   额外拦截 api_key/base_url/token 类键名——即使将来扩白名单也必须掩码。
 * - 失败不抛错：文件缺失/不可读返回 { available: false, reason }，界面如实展示。
 * - schema 驱动：字段形态 { key, label, value, group, type }，未来新 CLI 同构扩展零 UI 改动。
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { scrub } from "./redaction.mjs";

/** grok 原生设置的规范 runtimeProfileId（与 capability-watcher 的 runtimeProfileId 一致）。 */
export const GROK_NATIVE_SETTINGS_AGENT = "grok-build";

/** 数据来源标记：只给约定相对路径，不泄露完整绝对路径。 */
const GROK_CONFIG_SOURCE_LABEL = "~/.grok/config.toml";

/**
 * 即使将来扩白名单也必须掩码的键名（比 redaction.isSensitiveKeyName 更严：
 * 额外覆盖 base_url 这类非凭据但属于连接机密的键）。
 */
const FORBIDDEN_FIELD_KEY = /(?:api[_-]?key|access[_-]?key|base[_-]?url|tokens?|secrets?|passwords?|credentials?|authorization|private[_-]?key)/i;

/** permission_mode 原值 → 中文语义（与 grok CLI /config 的档位对齐）。 */
export const GROK_PERMISSION_MODE_SEMANTICS = Object.freeze({
  "always-approve": "全自动",
  auto: "安全检查放行",
  ask: "逐次询问",
  default: "逐次询问",
  plan: "只读规划",
  dontAsk: "严格白名单",
  acceptEdits: "自动接受编辑",
});

const GROK_GROUPS = Object.freeze([
  { id: "agentApproval", label: "审批与权限" },
  { id: "models", label: "模型" },
  { id: "appearance", label: "外观与界面" },
]);

/**
 * 字段白名单：{ key, label, group, type, section, semantic? }。
 * section 是 config.toml 的表名；解析只切 [models] 与 [ui] 两个表体。
 */
const GROK_FIELD_SCHEMA = Object.freeze([
  { key: "permission_mode", label: "权限模式", group: "agentApproval", type: "string", section: "ui", semantic: GROK_PERMISSION_MODE_SEMANTICS },
  { key: "yolo", label: "YOLO 模式", group: "agentApproval", type: "boolean", section: "ui" },
  { key: "default", label: "默认模型档位", group: "models", type: "string", section: "models" },
  // 默认推理档位（~/.grok/config.toml [models].default_reasoning_effort）：只是档位字符串，
  // 与 model-discovery parseGrokDefaults 同源读取，不碰敏感键名红线。
  { key: "default_reasoning_effort", label: "默认推理档位", group: "models", type: "string", section: "models" },
  { key: "fork_secondary_model", label: "分叉副模型", group: "models", type: "string", section: "ui" },
  { key: "compact_mode", label: "紧凑模式", group: "appearance", type: "boolean", section: "ui" },
  { key: "max_thoughts_width", label: "思考区宽度", group: "appearance", type: "number", section: "ui" },
]);

/** TOML 表体切片：表头行之后到下一个表头（或文件尾）——与 parseGrokDefaults 同纪律，绝不越表读键。
 * 表头行尾允许注释（TOML 规范：`[models] # comment`）。 */
function tomlTableBody(text, headerLiteral) {
  const head = String(text).match(new RegExp(`^\\s*\\[${headerLiteral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\][^\\S\\r\\n]*(#.*)?$`, "m"));
  if (!head) return null;
  const rest = String(text).slice(head.index + head[0].length);
  const end = rest.search(/^\[/m);
  return end === -1 ? rest : rest.slice(0, end);
}

function readTomlScalar(body, key, type) {
  if (body == null) return null;
  if (type === "string") return body.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1] ?? null;
  if (type === "boolean") {
    const raw = body.match(new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\b`, "m"))?.[1];
    return raw == null ? null : raw === "true";
  }
  const numeric = body.match(new RegExp(`^\\s*${key}\\s*=\\s*(-?\\d+)`, "m"))?.[1];
  return numeric == null ? null : Number(numeric);
}

function unavailable(reason) {
  return {
    agent: GROK_NATIVE_SETTINGS_AGENT,
    cli: "grok",
    available: false,
    reason,
    generatedAt: new Date().toISOString(),
    source: GROK_CONFIG_SOURCE_LABEL,
    groups: [],
  };
}

/**
 * 读取并结构化 ~/.grok/config.toml 的白名单字段。
 * @param {{ home?: string }} [options] home 覆盖 runtimeHome（测试用）；默认同
 *   ProviderStore 规约：CONTROL_CENTER_RUNTIME_HOME || homedir()。
 */
export async function buildGrokNativeSettings({ home = null } = {}) {
  const runtimeHome = home || process.env.CONTROL_CENTER_RUNTIME_HOME || homedir();
  const configPath = join(runtimeHome, ".grok", "config.toml");
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    return unavailable(error?.code === "ENOENT" ? "config-not-found" : "config-unreadable");
  }

  const tableBodies = {
    models: tomlTableBody(raw, "models"),
    ui: tomlTableBody(raw, "ui"),
  };
  const fields = [];
  for (const spec of GROK_FIELD_SCHEMA) {
    // 脱敏红线：敏感键名永不进输出——白名单今天没有，扩白名单时也会被这里拦下。
    if (FORBIDDEN_FIELD_KEY.test(spec.key)) continue;
    let value = readTomlScalar(tableBodies[spec.section], spec.key, spec.type);
    // 字符串值逐个过仓内脱敏出口（不能整对象过 sanitizeForPersistence：字段属性名
    // key 本身命中敏感键名规则，会把白名单键名误伤成 [REDACTED]）。
    if (typeof value === "string") value = scrub(value);
    const field = { key: spec.key, label: spec.label, value, group: spec.group, type: spec.type };
    if (spec.semantic) {
      field.semantic = value != null ? spec.semantic[String(value)] ?? null : null;
    }
    fields.push(field);
  }

  const snapshot = {
    agent: GROK_NATIVE_SETTINGS_AGENT,
    cli: "grok",
    available: true,
    generatedAt: new Date().toISOString(),
    source: GROK_CONFIG_SOURCE_LABEL,
    groups: GROK_GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      fields: fields.filter((field) => field.group === group.id),
    })),
  };
  return snapshot;
}

/** codex 原生设置的规范 runtimeProfileId（与 adapters manifest 的 codex-app-server 一致）。 */
export const CODEX_NATIVE_SETTINGS_AGENT = "codex-technical";

const CODEX_CONFIG_SOURCE_LABEL = "~/.codex/config.toml";

const CODEX_GROUPS = Object.freeze([
  { id: "model", label: "模型" },
  { id: "approval", label: "审批与权限" },
  { id: "runtime", label: "运行时" },
]);

/**
 * Codex config.toml 白名单（顶层标量键）。model_providers 等段可能带 api key 引用，
 * 整段永不读取；这里只切文件开头到第一个表头的顶层区。
 */
const CODEX_FIELD_SCHEMA = Object.freeze([
  { key: "model", label: "默认模型", group: "model", type: "string" },
  { key: "model_reasoning_effort", label: "推理强度", group: "model", type: "string", semantic: { minimal: "极简", low: "低", medium: "中", high: "高", ultra: "极高" } },
  { key: "approval_policy", label: "审批策略", group: "approval", type: "string", semantic: { untrusted: "仅信任白名单", "on-failure": "失败时询问", "on-request": "按需询问", never: "从不询问" } },
  { key: "sandbox_mode", label: "沙箱模式", group: "approval", type: "string", semantic: { "read-only": "只读", "workspace-write": "工作区可写", "danger-full-access": "完全访问" } },
]);

function codexUnavailable(reason, source = CODEX_CONFIG_SOURCE_LABEL) {
  return {
    agent: CODEX_NATIVE_SETTINGS_AGENT,
    cli: "codex",
    available: false,
    reason,
    generatedAt: new Date().toISOString(),
    source,
    groups: [],
  };
}

export async function buildCodexNativeSettings({ home = null } = {}) {
  const runtimeHome = home || process.env.CONTROL_CENTER_RUNTIME_HOME || homedir();
  const configPath = join(runtimeHome, ".codex", "config.toml");
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    return codexUnavailable(error?.code === "ENOENT" ? "config-not-found" : "config-unreadable");
  }

  // 只读顶层区（文件开头到第一个表头）；profile 变体留扩展位，不越表读键。
  const headerIndex = raw.search(/^\s*\[/m);
  const topBody = headerIndex === -1 ? raw : raw.slice(0, headerIndex);
  const fields = [];
  for (const spec of CODEX_FIELD_SCHEMA) {
    if (FORBIDDEN_FIELD_KEY.test(spec.key)) continue;
    let value = readTomlScalar(topBody, spec.key, spec.type);
    if (typeof value === "string") value = scrub(value);
    const field = { key: spec.key, label: spec.label, value, group: spec.group, type: spec.type };
    if (spec.semantic) field.semantic = value != null ? spec.semantic[String(value)] ?? null : null;
    fields.push(field);
  }
  if (!fields.some((field) => field.value != null)) {
    // 文件存在但没有任何白名单字段：如实报不可用原因，而不是渲染一张全空表
    return codexUnavailable("no-whitelisted-fields");
  }
  return {
    agent: CODEX_NATIVE_SETTINGS_AGENT,
    cli: "codex",
    available: true,
    generatedAt: new Date().toISOString(),
    source: CODEX_CONFIG_SOURCE_LABEL,
    groups: CODEX_GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      fields: fields.filter((field) => field.group === group.id),
    })),
  };
}

/** runtimeProfileId → 快照构造器。新 CLI 在此挂同款 builder 即可（扩展位）。 */
const NATIVE_SETTINGS_BUILDERS = new Map([
  [GROK_NATIVE_SETTINGS_AGENT, buildGrokNativeSettings],
  [CODEX_NATIVE_SETTINGS_AGENT, buildCodexNativeSettings],
]);

/** 该 agent 是否有原生设置面板支持（端点白名单判据）。 */
export function hasNativeSettingsAgent(agentId) {
  return NATIVE_SETTINGS_BUILDERS.has(String(agentId ?? ""));
}

/** 构造指定 agent 的原生设置快照；非白名单 agent 返回 null（端点据此拒绝）。 */
export async function buildNativeSettings(agentId) {
  const builder = NATIVE_SETTINGS_BUILDERS.get(String(agentId ?? ""));
  if (!builder) return null;
  return builder();
}
