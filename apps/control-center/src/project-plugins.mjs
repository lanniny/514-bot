import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const SCHEMA = "514cc.project-plugins/v1";
const MANIFEST = "514cc.plugin/v1";
const MAX_BYTES = 2 * 1024 * 1024;
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const fail = (message, code = "PLUGIN_INVALID", httpStatus = 400) => { throw Object.assign(new Error(message), { code, httpStatus }); };
const clone = (value) => structuredClone(value);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("需要对象格式");
  return value;
}
function keys(value, allowed) {
  object(value);
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail("包含不支持的字段");
}
function text(value, max = 160) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008]/.test(value)) fail("文本字段无效或过长");
  return value.trim();
}
function id(value) { if (typeof value !== "string" || !idPattern.test(value)) fail("标识无效"); return value; }
function projectKey(value) { const normalized = text(value, 120); if (normalized !== value) fail("项目标识必须使用规范形式"); return normalized; }
function list(value, max = 12) { if (!Array.isArray(value) || value.length > max) fail("列表长度无效"); return value; }
function unique(items) { if (new Set(items.map((item) => item.id)).size !== items.length) fail("重复标识"); return items; }
function versionParts(value) { return String(value).split(".").map((part) => Number(part)); }
function newerVersion(candidate, current) {
  const next = versionParts(candidate), prior = versionParts(current);
  return next.some((part, index) => part > prior[index] && next.slice(0, index).every((value, offset) => value === prior[offset]));
}

export function normalizePluginManifest(raw) {
  keys(raw, ["schema", "id", "name", "version", "description", "settings", "tools", "workflows", "panels"]);
  if (raw.schema !== MANIFEST || !/^\d+\.\d+\.\d+$/.test(raw.version || "")) fail("插件格式或版本不受支持");
  const settings = unique(list(raw.settings || [], 32).map((field) => {
    keys(field, ["id", "label", "type", "default", "options"]);
    if (!["string", "boolean", "number", "select"].includes(field.type)) fail("配置类型不受支持");
    const result = { id: id(field.id), label: text(field.label, 80), type: field.type };
    if (field.type === "select") result.options = list(field.options, 20).map((value) => text(value, 80));
    result.default = field.default;
    validateValue(result, result.default);
    return result;
  }));
  const tools = unique(list(raw.tools || []).map((item) => {
    keys(item, ["id", "name", "kind"]);
    if (!["project-summary", "run-summary"].includes(item.kind)) fail("工具类型不受支持");
    return { id: id(item.id), name: text(item.name, 80), kind: item.kind };
  }));
  const workflows = unique(list(raw.workflows || []).map((item) => {
    keys(item, ["id", "name", "prompt"]);
    const prompt = text(item.prompt, 6000);
    for (const match of prompt.matchAll(/\{\{([^{}]+)\}\}/g)) {
      if (match[1] !== "project.title" && !settings.some((setting) => `config.${setting.id}` === match[1])) fail("工作流引用未知配置");
    }
    return { id: id(item.id), name: text(item.name, 80), prompt };
  }));
  const panels = unique(list(raw.panels || [], 4).map((item) => {
    keys(item, ["id", "name", "source"]);
    if (!["project-summary", "run-summary"].includes(item.source)) fail("面板数据源不受支持");
    return { id: id(item.id), name: text(item.name, 80), source: item.source };
  }));
  if (!tools.length && !workflows.length && !panels.length) fail("插件没有可用扩展");
  return { schema: MANIFEST, id: id(raw.id), name: text(raw.name, 80), version: text(raw.version, 40), description: text(raw.description, 600), settings, tools, workflows, panels };
}
function validateValue(field, value) {
  if (field.type === "boolean" && typeof value !== "boolean") fail(`${field.label} 需要开关值`);
  if (field.type === "number" && (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1000000)) fail(`${field.label} 数值无效`);
  if (field.type === "string" && (typeof value !== "string" || value.length > 2000)) fail(`${field.label} 文本过长`);
  if (field.type === "select" && !field.options.includes(value)) fail(`${field.label} 选项无效`);
  return value;
}
function configFor(manifest, config = {}) {
  keys(config, manifest.settings.map((field) => field.id));
  return Object.fromEntries(manifest.settings.map((field) => [field.id, validateValue(field, Object.hasOwn(config, field.id) ? config[field.id] : field.default)]));
}

export const PLUGIN_CATALOG = [
  { schema: MANIFEST, id: "project-context", name: "项目上下文", version: "1.0.0", description: "读取当前项目与运行摘要，作为协作上下文。", tools: [{ id: "project", name: "读取项目概要", kind: "project-summary" }, { id: "runs", name: "读取运行摘要", kind: "run-summary" }] },
  { schema: MANIFEST, id: "delivery-review", name: "交付审查", version: "1.0.0", description: "按项目范围准备实现审查和交付核验。", settings: [{ id: "focus", label: "审查重点", type: "select", options: ["正确性与回归", "用户体验", "性能与边界"], default: "正确性与回归" }, { id: "acceptance", label: "验收要求", type: "string", default: "列出证据、未验证项与剩余风险。" }], workflows: [{ id: "review", name: "准备交付审查", prompt: "请审查项目「{{project.title}}」的当前工作。重点：{{config.focus}}。\n验收要求：{{config.acceptance}}\n先核对实际文件与已有改动，按严重度列出发现和证据。" }] },
  { schema: MANIFEST, id: "project-overview", name: "项目状态面板", version: "1.0.0", description: "在 Bot 内查看项目与最近运行状态。", panels: [{ id: "overview", name: "项目概览", source: "project-summary" }, { id: "activity", name: "最近运行", source: "run-summary" }] },
  {
    schema: MANIFEST,
    id: "desktop-pet",
    name: "桌宠伴侣",
    version: "1.2.0",
    description: "桌面透明悬浮猫窗与工作台看板伴侣，随 Bot 任务进度与键盘打字起舞，陪伴协同编码。",
    settings: [
      { id: "enabled", label: "启用桌宠伴侣", type: "boolean", default: true },
      { id: "model", label: "模型模式", type: "select", options: ["standard", "keyboard", "gamepad"], default: "standard" },
      { id: "max-fps", label: "最大帧率", type: "select", options: ["30", "60", "120"], default: "60" },
      { id: "model-mirror", label: "模型镜像", type: "boolean", default: false },
      { id: "pointer-mirror", label: "指针镜像", type: "boolean", default: false },
      { id: "random-expression", label: "随机表情", type: "boolean", default: false },
      { id: "interactive", label: "互动模式 (可拖拽与戳一戳)", type: "boolean", default: false },
      { id: "opacity", label: "不透明度 (%)", type: "number", default: 100 },
      { id: "scale", label: "大小缩放 (%)", type: "number", default: 100 },
      { id: "web-dock", label: "Web 模式内嵌浮窗", type: "boolean", default: true },
      { id: "mouse-tracking", label: "鼠标光标与按键跟随", type: "boolean", default: true },
      { id: "lightning-combo", label: "打字连击狂热与闪电特效", type: "boolean", default: true },
      { id: "sound", label: "敲击节奏伴音与喵叫", type: "boolean", default: false }
    ],
    tools: [
      { id: "pet-status", name: "读取桌宠状态与伴随统计", kind: "project-summary" }
    ],
    workflows: [
      { id: "poke", name: "戳一戳问候", prompt: "请以桌宠伴侣的元气语气向用户简短问好，并汇报当前项目「{{project.title}}」的进行状态。" },
      { id: "celebrate", name: "任务欢庆", prompt: "请复核当前项目「{{project.title}}」的交付成果与验证情况，确认无误后给出简要交付总结并触发桌宠欢庆。" }
    ],
    panels: [
      { id: "pet-dashboard", name: "桌宠互动看板", source: "project-summary" }
    ]
  }
].map(normalizePluginManifest);

export class ProjectPluginStore {
  #data = { schema: SCHEMA, revision: 0, installed: [], bindings: [] };
  #queue = Promise.resolve();
  #blocked = false;
  constructor({ dataRoot, projects }) { this.root = dataRoot; this.path = join(dataRoot, "project-plugins.json"); this.projects = projects; }
  async init() {
    try {
      if ((await stat(this.path)).size > MAX_BYTES) fail("插件台账过大");
      const data = JSON.parse(await readFile(this.path, "utf8"));
      keys(data, ["schema", "revision", "installed", "bindings"]);
      if (data.schema !== SCHEMA || !Number.isSafeInteger(data.revision) || data.revision < 0) fail("插件台账格式无效");
      const installed = unique(list(data.installed, 100).map((item) => {
        keys(item, ["id", "manifest", "digest", "installedAt"]);
        const manifest = normalizePluginManifest(item.manifest);
        if (manifest.id !== item.id || hash(manifest) !== item.digest) fail("插件摘要不匹配");
        return { id: manifest.id, manifest, digest: item.digest, installedAt: text(item.installedAt, 40) };
      }));
      let migrated = false;
      for (const item of installed) {
        const catalog = PLUGIN_CATALOG.find((entry) => entry.id === item.id);
        if (catalog && newerVersion(catalog.version, item.manifest.version)) {
          item.manifest = clone(catalog);
          item.digest = hash(catalog);
          migrated = true;
        }
      }
      const seen = new Set();
      const bindings = list(data.bindings, 5000).map((binding) => {
        keys(binding, ["projectId", "pluginId", "enabled", "config"]);
        const item = installed.find((entry) => entry.id === binding.pluginId);
        const projectId = projectKey(binding.projectId);
        const key = JSON.stringify([projectId, binding.pluginId]);
        if (!item || seen.has(key) || typeof binding.enabled !== "boolean") fail("插件绑定无效");
        seen.add(key);
        return { projectId, pluginId: item.id, enabled: binding.enabled, config: configFor(item.manifest, binding.config) };
      });
      this.#data = { schema: SCHEMA, revision: data.revision + Number(migrated), installed, bindings };
      if (migrated) {
        const temp = join(this.root, `.project-plugins.${randomUUID()}.tmp`);
        let file;
        try {
          file = await open(temp, "wx", 0o600);
          await file.writeFile(JSON.stringify(this.#data), "utf8");
          await file.sync();
          await file.close(); file = null;
          await rename(temp, this.path);
        } finally { await file?.close().catch(() => {}); await rm(temp, { force: true }).catch(() => {}); }
      }
    } catch (error) { if (error.code !== "ENOENT") this.#blocked = true; }
    return this;
  }
  #ready() { if (this.#blocked) fail("插件台账无法校验，已停止读写", "PLUGIN_STORE_UNAVAILABLE", 503); }
  #project(projectId, writable = false) {
    const project = this.projects.get(projectKey(projectId));
    if (writable && project.archivedAt) fail("项目已归档", "PLUGIN_PROJECT_ARCHIVED", 409);
    return project;
  }
  list(projectId = null) {
    this.#ready();
    if (projectId) this.#project(projectId);
    return clone({ revision: this.#data.revision, catalog: PLUGIN_CATALOG, installed: this.#data.installed, bindings: projectId ? this.#data.bindings.filter((item) => item.projectId === projectId) : [] });
  }
  #mutate(expectedRevision, change) {
    const operation = this.#queue.then(async () => {
      this.#ready();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.#data.revision) fail("配置已变化，请刷新后重试", "PLUGIN_REVISION_MISMATCH", 409);
      const next = clone(this.#data);
      change(next);
      next.revision += 1;
      if (next.installed.length > 100 || next.bindings.length > 5000) fail("插件数量超出上限");
      const content = JSON.stringify(next);
      if (Buffer.byteLength(content) > MAX_BYTES) fail("插件台账超出容量");
      await mkdir(this.root, { recursive: true });
      const temp = join(this.root, `.project-plugins.${randomUUID()}.tmp`);
      let file;
      try {
        file = await open(temp, "wx", 0o600);
        await file.writeFile(content, "utf8");
        await file.sync();
        await file.close(); file = null;
        await rename(temp, this.path);
        this.#data = next;
      } finally { await file?.close().catch(() => {}); await rm(temp, { force: true }).catch(() => {}); }
      return { revision: next.revision };
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
  install({ catalogId, manifest: raw, expectedRevision }) {
    const manifest = normalizePluginManifest(catalogId ? PLUGIN_CATALOG.find((item) => item.id === catalogId) : raw);
    if (!catalogId && PLUGIN_CATALOG.some((item) => item.id === manifest.id)) {
      fail("内置插件标识只能从官方目录安装", "PLUGIN_RESERVED_ID", 409);
    }
    return this.#mutate(expectedRevision, (next) => {
      if (next.installed.some((item) => item.id === manifest.id)) fail("插件已安装；请先停用并卸载旧版本", "PLUGIN_ALREADY_INSTALLED", 409);
      next.installed.push({ id: manifest.id, manifest, digest: hash(manifest), installedAt: new Date().toISOString() });
    });
  }
  remove({ pluginId, expectedRevision }) {
    return this.#mutate(expectedRevision, (next) => {
      if (!next.installed.some((item) => item.id === pluginId)) fail("插件未安装", "PLUGIN_NOT_FOUND", 404);
      if (next.bindings.some((item) => item.pluginId === pluginId && item.enabled)) fail("请先在绑定项目中停用插件", "PLUGIN_IN_USE", 409);
      next.installed = next.installed.filter((item) => item.id !== pluginId);
      next.bindings = next.bindings.filter((item) => item.pluginId !== pluginId);
    });
  }
  configure({ projectId, pluginId, enabled, config, expectedRevision }) {
    return this.#mutate(expectedRevision, (next) => {
      this.#project(projectId, enabled !== false);
      const item = next.installed.find((entry) => entry.id === pluginId);
      if (!item) fail("插件未安装", "PLUGIN_NOT_FOUND", 404);
      if (typeof enabled !== "boolean") fail("缺少启停状态");
      const normalizedConfig = configFor(item.manifest, config);
      if (pluginId === "desktop-pet" && Object.hasOwn(normalizedConfig, "enabled")) normalizedConfig.enabled = enabled;
      const binding = { projectId, pluginId, enabled, config: normalizedConfig };
      next.bindings = next.bindings.filter((entry) => entry.projectId !== projectId || entry.pluginId !== pluginId);
      next.bindings.push(binding);
    });
  }
  snapshot(projectId) {
    this.#ready();
    if (!projectId) return [];
    this.#project(projectId);
    return clone(this.#data.bindings.filter((item) => item.projectId === projectId && item.enabled).map((binding) => {
      const item = this.#data.installed.find((entry) => entry.id === binding.pluginId);
      return { id: item.id, name: item.manifest.name, version: item.manifest.version, digest: item.digest, config: binding.config, tools: item.manifest.tools, workflows: item.manifest.workflows.map(({ id, name }) => ({ id, name })), panels: item.manifest.panels };
    }));
  }
  execute({ projectId, pluginId, contributionId, type }, { runs = [] } = {}) {
    this.#ready();
    const project = this.#project(projectId, true);
    const item = this.#data.installed.find((entry) => entry.id === pluginId);
    const binding = this.#data.bindings.find((entry) => entry.projectId === projectId && entry.pluginId === pluginId && entry.enabled);
    if (!item || !binding) fail("插件未在当前项目启用", "PLUGIN_DISABLED", 409);
    if (!["tools", "workflows", "panels"].includes(type)) fail("扩展类型无效");
    const contribution = item.manifest[type].find((entry) => entry.id === contributionId);
    if (!contribution) fail("扩展不存在", "PLUGIN_CONTRIBUTION_NOT_FOUND", 404);
    const receipt = { projectId, pluginId, version: item.manifest.version, digest: item.digest, name: contribution.name, at: new Date().toISOString(), type };
    if (type === "workflows") {
      const prompt = contribution.prompt.replace(/\{\{([^{}]+)\}\}/g, (_, key) => String(key === "project.title" ? project.title : binding.config[key.slice(7)]));
      if (prompt.length > 16000) fail("工作流内容超出上限");
      return { ...receipt, prompt };
    }
    const ownRuns = runs.filter((run) => run.projectId === projectId);
    const source = contribution.kind || contribution.source;
    const data = source === "project-summary"
      ? {
          title: project.title,
          cwd: project.canonicalCwd || project.cwd,
          projectId,
          runCount: ownRuns.length,
          enabledPlugins: this.snapshot(projectId).map((plugin) => ({ name: plugin.name, version: plugin.version })),
          pet: pluginId === "desktop-pet" ? {
            enabled: binding.config.enabled ?? true,
            interactive: binding.config.interactive ?? false,
            opacity: binding.config.opacity ?? 100,
            scale: binding.config.scale ?? 100,
            web_dock: binding.config["web-dock"] ?? true,
            mouse_tracking: binding.config["mouse-tracking"] ?? true,
            lightning_combo: binding.config["lightning-combo"] ?? true,
            sound: binding.config.sound ?? false,
            model: binding.config.model ?? "standard"
          } : undefined
        }
      : { runs: ownRuns.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 30).map((run) => ({ id: run.id, status: run.status, createdAt: run.createdAt, conversationId: run.conversationId })) };
    return { ...receipt, data };
  }
}
