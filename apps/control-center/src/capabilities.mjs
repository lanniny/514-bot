// 能力图谱（codeg 对标 P2：Skills 只读矩阵 + MCP 本地扫描只读展示）。
// 只读聚合，不改任何源文件：
//   skills = 文件系统 skills/ + .agents/skills/ 扫描（存在性权威）
//            + module.yaml 注册表定向解析（type/phase/描述/花名册）
//            + 团队声明（TeamStore.skills 声明面）
//   mcp    = ~/.claude.json（顶层+项目段）/ ~/.claude/settings.json / ~/.codex/config.toml
//            + module.yaml mcp_servers 能力映射
// 纪律：源读不出=如实 unavailable 不伪造；MCP 只出白名单字段（名称/传输/来源/命令基名/URL host），
// env/args/headers 绝不外发（密钥面，与 redaction 同门）。
//
// 2026-07-20 升级可配置面（LO 拍板「需要配置全部 agent skill/mcp 的入口」）：
//   agent skill 启停 = dataRoot/agent-capabilities.json（disabledSkills 负名单，默认全启用）——
//     真接线：orchestrator 成员轮提示词按此过滤 skill 声明（capabilitiesProvider 注入）；
//   MCP 启停 = claude.json 全局 server 隔离式启停（禁用=移入 dataRoot/mcp-quarantine.json 可一键恢复）——
//     mtime 乐观锁（扫描后被外部改写即拒）+ 写前备份 + 只碰 mcpServers 一个键（env 凭据原样搬运）；
//     codex TOML 只读（TOML 注释保真编辑器未就绪，不做半吊子写入）。
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";

const execFileAsync = promisify(execFile);
let windowsPrincipalPromise = null;

const SKILL_SCOPES = [
  { dir: "skills", scope: "claude" },
  { dir: join(".agents", "skills"), scope: "codex" },
];

// 同一进程中可能短时存在多个 capabilities 实例（重载/测试）。
// 按主文件串行整段 read-modify-write，而不是只串行最后一次 write。
const MUTATION_CHAINS = new Map();
const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function serializeMutation(key, operation) {
  const previous = MUTATION_CHAINS.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.catch(() => {});
  MUTATION_CHAINS.set(key, tail);
  void tail.then(() => {
    if (MUTATION_CHAINS.get(key) === tail) MUTATION_CHAINS.delete(key);
  });
  return result;
}

function safeRecord(value) {
  const record = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return record;
  for (const [key, entry] of Object.entries(value)) record[key] = entry;
  return record;
}

function validateIdentifier(value, label) {
  const identifier = String(value ?? "").trim();
  if (!identifier || PROTOTYPE_KEYS.has(identifier)) {
    throw Object.assign(new Error(`${label} is invalid`), { code: "VALIDATION_FAILED" });
  }
  return identifier;
}

// Git Bash / MSYS 环境的 PATH 里 /usr/bin 排在 System32 之前，裸名 "whoami.exe" 会解析到
// GNU coreutils 版本（不认识 /user，exit 1）。Windows 系统工具一律按 System32 绝对路径调用。
function windowsSystemTool(name) {
  return join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32", name);
}

async function restrictSensitiveFile(file) {
  try {
    if (process.platform === "win32") {
      windowsPrincipalPromise ??= execFileAsync(windowsSystemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
        windowsHide: true,
        timeout: 10_000,
      }).then(({ stdout }) => {
        const sid = String(stdout).match(/S-\d+(?:-\d+)+/i)?.[0];
        if (!sid) throw Object.assign(new Error("current Windows SID is unavailable"), { code: "SID_UNAVAILABLE" });
        return `*${sid}`;
      });
      const account = await windowsPrincipalPromise;
      // The file is still empty here. Add an explicit owner grant before removing
      // inherited ACEs so a partial icacls failure cannot lock out the writer.
      await execFileAsync(windowsSystemTool("icacls.exe"), [file, "/grant:r", `${account}:(F)`], { windowsHide: true, timeout: 10_000 });
      await execFileAsync(windowsSystemTool("icacls.exe"), [file, "/inheritance:r"], { windowsHide: true, timeout: 10_000 });
      return;
    }
    await chmod(file, 0o600);
  } catch (error) {
    throw Object.assign(new Error(`failed to restrict sensitive file permissions: ${file}`), {
      code: "SENSITIVE_FILE_PERMISSION_FAILED",
      causeCode: error?.code ?? null,
    });
  }
}

function sameSourcePath(left, right) {
  const leftPath = resolve(String(left ?? ""));
  const rightPath = resolve(String(right ?? ""));
  return process.platform === "win32" ? leftPath.toLowerCase() === rightPath.toLowerCase() : leftPath === rightPath;
}

// module.yaml 无 Node 解析依赖（validator 走 python 侧）——对 skills:/agents:/mcp_servers: 三个
// 结构规整的手维护块做定向行解析；块外/畸形行跳过，绝不整文件臆造解析。
function parseModuleYamlBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = { skills: [], agents: [], mcp_servers: [] };
  let section = null;
  let current = null;
  const flush = () => {
    if (current && section && blocks[section]) blocks[section].push(current);
    current = null;
  };
  for (const line of lines) {
    const top = line.match(/^([a-z_]+):\s*$/);
    if (top) {
      flush();
      section = Object.hasOwn(blocks, top[1]) ? top[1] : null;
      continue;
    }
    if (!section) continue;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^\S/.test(line)) { section = null; flush(); continue; } // 其他顶行键，块结束
    const item = line.match(/^\s{2}-\s+([a-z_]+):\s*(.*)$/);
    if (item) {
      flush();
      current = safeRecord({ [item[1]]: stripScalar(item[2]) });
      continue;
    }
    const field = line.match(/^\s{4,}([a-z_]+):\s*(.*)$/);
    if (field && current) {
      current[field[1]] = stripScalar(field[2]);
      continue;
    }
    // mcp_servers 是映射块（code_intelligence: serena / web_search: [a, b]），非列表
    const mapEntry = line.match(/^\s{2}([a-z_]+):\s*(.+)$/);
    if (section === "mcp_servers" && mapEntry) {
      blocks.mcp_servers.push({ capability: mapEntry[1], servers: stripScalar(mapEntry[2]) });
    }
  }
  flush();
  return blocks;
}

function stripScalar(raw) {
  let value = String(raw ?? "").trim();
  value = value.replace(/\s+#.*$/, "").trim(); // 行尾注释
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1).split(",").map((item) => item.trim()).filter(Boolean);
  }
  return value;
}

// W3.3 Skill 管理器补缺：SKILL.md frontmatter 的 version + 文件 mtime 一并提取（版本展示与内容级新鲜度）
async function readSkillMeta(dir) {
  let version = null;
  let mtimeMs = null;
  try {
    mtimeMs = (await stat(join(dir, "SKILL.md"))).mtimeMs;
  } catch {
    mtimeMs = null;
  }
  try {
    const text = await readFile(join(dir, "SKILL.md"), "utf8");
    const head = text.slice(0, 4096);
    const front = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (front) {
      const ver = front[1].match(/^version:\s*(.+)$/m);
      if (ver) version = ver[1].trim().replace(/^["']|["']$/g, "").slice(0, 40) || null;
      const desc = front[1].match(/^description:\s*(.+)$/m);
      if (desc) return { description: desc[1].trim().replace(/^["']|["']$/g, "").slice(0, 200), version, mtimeMs };
      const name = front[1].match(/^name:\s*(.+)$/m);
      if (name) return { description: name[1].trim().replace(/^["']|["']$/g, "").slice(0, 200), version, mtimeMs };
    }
    const heading = head.match(/^#\s+(.+)$/m);
    return { description: heading ? heading[1].trim().slice(0, 200) : "", version, mtimeMs };
  } catch {
    return { description: "", version, mtimeMs }; // 无 SKILL.md 或读失败：描述留空如实呈现（存在性由目录名承担）
  }
}

async function readSkillDescription(dir) {
  return (await readSkillMeta(dir)).description;
}

async function scanSkillDirs(repoRoot) {
  const skills = [];
  for (const { dir, scope } of SKILL_SCOPES) {
    const base = join(repoRoot, dir);
    let categories;
    try {
      categories = await readdir(base, { withFileTypes: true });
    } catch {
      continue; // scope 目录不存在=该面不可用，跳过不伪造
    }
    for (const category of categories) {
      // skills/<category>/<skill> 两层；.agents/skills/<skill> 一层（category 记 scope 名）
      if (category.isDirectory() && scope === "claude") {
        const entries = await readdir(join(base, category.name), { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const meta = await readSkillMeta(join(base, category.name, entry.name));
          skills.push({
            code: entry.name,
            category: category.name,
            scope,
            path: join(dir, category.name, entry.name),
            description: meta.description,
            version: meta.version,
            mtimeMs: meta.mtimeMs,
          });
        }
      } else if (category.isDirectory()) {
        const meta = await readSkillMeta(join(base, category.name));
        skills.push({
          code: category.name,
          category: scope,
          scope,
          path: join(dir, category.name),
          description: meta.description,
          version: meta.version,
          mtimeMs: meta.mtimeMs,
        });
      }
    }
  }
  return skills;
}

function transportOf(entry) {
  if (entry?.type) return String(entry.type);
  if (entry?.url) return "http";
  if (entry?.command) return "stdio";
  return "unknown";
}

// MCP 条目白名单化：只留名称/传输/命令基名或 URL host——env/args/headers 可能含密钥，一律丢弃
function whitelistMcpEntry(name, entry, source, scope) {
  const item = { name: String(name), transport: transportOf(entry), source, scope };
  if (entry?.command) item.command = basename(String(entry.command));
  if (entry?.url) {
    try {
      item.urlHost = new URL(String(entry.url)).host;
    } catch {
      item.urlHost = "（URL 无法解析）";
    }
  }
  return item;
}

async function scanClaudeJson(file, servers) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return; // 不存在/读不出=该源不可用
  }
  for (const [name, entry] of Object.entries(parsed?.mcpServers ?? {})) {
    servers.push(whitelistMcpEntry(name, entry, file, "全局"));
  }
  for (const [project, projectEntry] of Object.entries(parsed?.projects ?? {})) {
    for (const [name, entry] of Object.entries(projectEntry?.mcpServers ?? {})) {
      servers.push(whitelistMcpEntry(name, entry, file, `项目 ${project}`));
    }
  }
}

async function scanClaudeSettings(file, servers) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return;
  }
  for (const [name, entry] of Object.entries(parsed?.mcpServers ?? {})) {
    servers.push(whitelistMcpEntry(name, entry, file, "settings"));
  }
}

async function scanCodexToml(file, servers) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return;
  }
  // TOML 定向解析：[mcp_servers.<name>] 表头即 server 声明；transport 由字段粗判
  const names = new Set();
  for (const match of text.matchAll(/^\[mcp_servers\.([^\]]+)\]$/gm)) {
    names.add(match[1].replace(/^"|"$/g, ""));
  }
  for (const name of names) {
    const block = text.match(new RegExp(`^\\[mcp_servers\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]([\\s\\S]*?)(?=^\\[|$)`, "m"));
    const body = block?.[1] ?? "";
    const command = body.match(/^command\s*=\s*"([^"]+)"/m)?.[1];
    const url = body.match(/^url\s*=\s*"([^"]+)"/m)?.[1];
    servers.push(whitelistMcpEntry(name, { command, url }, file, "codex"));
  }
}

export function createCapabilities({
  repoRoot,
  homeDir,
  teamsStore,
  membersStore = null,
  dataRoot = null,
  eventStore = null,
  sourceIdForPath = null,
  fileOps = null,
  secureFile = restrictSensitiveFile,
}) {
  const capsPath = dataRoot ? join(dataRoot, "agent-capabilities.json") : null;
  const quarantinePath = dataRoot ? join(dataRoot, "mcp-quarantine.json") : null;
  // 文件操作注入只用于确定性故障测试；生产路径默认全部使用 node:fs/promises。
  const io = { mkdir, readFile, rename, rm, stat, writeFile, ...(fileOps ?? {}) };

  function configSourceId(path) {
    if (sourceIdForPath === null) return null;
    if (typeof sourceIdForPath !== "function") throw new TypeError("sourceIdForPath must be a function");
    const id = sourceIdForPath(resolve(path));
    return typeof id === "string" && id ? id : null;
  }

  async function syncFile(file) {
    // Windows requires a writable handle for FlushFileBuffers; read-only fsync
    // returns EPERM even when the DACL is correct.
    const handle = await open(file, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function syncParent(file) {
    if (process.platform === "win32") return;
    const handle = await open(dirname(file), "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function writeTextAtomic(file, content, { expectedText, conflictCode = "STALE_BASE" } = {}) {
    if (!file) {
      throw Object.assign(new Error("capability storage path is unavailable"), { code: "CAPABILITY_CONFIG_UNAVAILABLE" });
    }
    await io.mkdir(dirname(file), { recursive: true });
    const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
    let renamed = false;
    let failure = null;
    try {
      // Create an empty private file first. On Windows, mode=0600 does not change
      // the DACL, so icacls must succeed before any credential-bearing bytes land.
      await io.writeFile(temp, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
      await secureFile(temp);
      await io.writeFile(temp, content, { encoding: "utf8", flag: "r+" });
      await syncFile(temp);
      if (expectedText !== undefined) {
        let currentText;
        try {
          currentText = await io.readFile(file, "utf8");
        } catch (error) {
          throw Object.assign(new Error("MCP source changed or became unreadable during the transaction"), {
            code: error?.code === "ENOENT" ? conflictCode : "MCP_SOURCE_UNREADABLE",
            causeCode: error?.code ?? null,
          });
        }
        if (currentText !== expectedText) {
          throw Object.assign(new Error("MCP source changed during the transaction; refresh and retry"), { code: conflictCode });
        }
      }
      await io.rename(temp, file);
      renamed = true;
      await syncFile(file);
      await syncParent(file);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (!renamed) {
        try {
          await io.rm(temp, { force: true });
        } catch (cleanupError) {
          throw Object.assign(new Error("sensitive atomic-write temp cleanup failed"), {
            code: "SENSITIVE_TEMP_CLEANUP_FAILED",
            causeCode: failure?.code ?? null,
            cleanupCode: cleanupError?.code ?? null,
            tempPath: temp,
          });
        }
      }
    }
  }

  async function writeJsonAtomic(file, value, options) {
    await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`, options);
  }

  function configuredTeams() {
    try {
      const teams = teamsStore?.list?.();
      return Array.isArray(teams) ? teams : [];
    } catch {
      return [];
    }
  }

  function configuredMemberIds(teams = configuredTeams()) {
    try {
      const members = membersStore?.list?.();
      if (Array.isArray(members)) {
        return [...new Set(members
          .filter((member) => member?.teamMemberEligible === true)
          .map((member) => String(member.id ?? "").trim())
          .filter(Boolean))];
      }
    } catch {
      // Runtime member catalog failures are handled by its owning store. Keep the
      // previous team-union fallback for isolated/legacy capabilities callers.
    }
    return [...new Set(teams.flatMap((team) => Array.isArray(team?.members) ? team.members.map(String) : []))];
  }

  async function validateAgentSkill(agentId, skill) {
    const cleanAgentId = validateIdentifier(agentId, "agentId");
    const cleanSkill = validateIdentifier(skill, "skill");
    const teams = configuredTeams();
    const knownAgents = new Set(configuredMemberIds(teams));
    if (!knownAgents.has(cleanAgentId)) {
      throw Object.assign(new Error(`unknown capability agent: ${cleanAgentId}`), { code: "VALIDATION_FAILED" });
    }
    const knownSkills = new Set(teams.flatMap((team) => Array.isArray(team?.skills) ? team.skills.map(String) : []));
    for (const entry of await scanSkillDirs(repoRoot)) knownSkills.add(entry.code);
    if (!knownSkills.has(cleanSkill)) {
      throw Object.assign(new Error(`unknown capability skill: ${cleanSkill}`), { code: "VALIDATION_FAILED" });
    }
    return { agentId: cleanAgentId, skill: cleanSkill };
  }

  function normalizeAgentCaps(value) {
    const caps = safeRecord(value);
    const agents = safeRecord(value?.agents);
    for (const [agentId, rawEntry] of Object.entries(agents)) {
      const entry = safeRecord(rawEntry);
      entry.disabledSkills = Array.isArray(rawEntry?.disabledSkills)
        ? [...new Set(rawEntry.disabledSkills.map((skill) => String(skill).trim()))]
        : [];
      agents[agentId] = entry;
    }
    caps.agents = agents;
    return caps;
  }

  function validateAgentCapsDocument(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("agent-capabilities.json must contain an object");
    }
    if (value.agents !== undefined && (!value.agents || typeof value.agents !== "object" || Array.isArray(value.agents))) {
      throw new TypeError("agent-capabilities.json agents must be an object");
    }
    for (const [agentId, rawEntry] of Object.entries(value.agents ?? {})) {
      if (PROTOTYPE_KEYS.has(agentId) || !rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        throw new TypeError(`agent-capabilities.json has an invalid agent entry: ${agentId}`);
      }
      if (rawEntry.disabledSkills !== undefined && !Array.isArray(rawEntry.disabledSkills)) {
        throw new TypeError(`agent-capabilities.json disabledSkills must be an array: ${agentId}`);
      }
      for (const skill of rawEntry.disabledSkills ?? []) {
        if (typeof skill !== "string" || !skill.trim() || PROTOTYPE_KEYS.has(skill.trim())) {
          throw new TypeError(`agent-capabilities.json has an invalid disabled skill: ${agentId}`);
        }
      }
    }
  }

  function capabilityConfigStatus({ state, source, code = null, message = null, causeCode = null }) {
    return {
      state,
      source,
      writable: state === "ready",
      failClosed: state === "degraded",
      path: capsPath,
      code,
      message,
      causeCode,
    };
  }

  function capabilityConfigError(status) {
    return Object.assign(new Error(status.message || "agent capability configuration is unavailable"), {
      code: status.code || "CAPABILITY_CONFIG_UNAVAILABLE",
      capabilityStatus: status,
    });
  }

  function normalizeQuarantine(value) {
    const quarantine = safeRecord(value);
    const servers = safeRecord(value?.servers);
    for (const [name, rawHeld] of Object.entries(servers)) {
      const held = safeRecord(rawHeld);
      held.entry = rawHeld.entry;
      servers[name] = held;
    }
    quarantine.servers = servers;
    return quarantine;
  }

  function validateQuarantineDocument(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("mcp-quarantine.json must contain an object");
    }
    if (value.servers !== undefined && (!value.servers || typeof value.servers !== "object" || Array.isArray(value.servers))) {
      throw new TypeError("mcp-quarantine.json servers must be an object");
    }
    for (const [name, held] of Object.entries(value.servers ?? {})) {
      if (PROTOTYPE_KEYS.has(name) || !held || typeof held !== "object" || Array.isArray(held)) {
        throw new TypeError(`mcp-quarantine.json has an invalid server record: ${name}`);
      }
      if (!Object.hasOwn(held, "entry") || !held.entry || typeof held.entry !== "object" || Array.isArray(held.entry)) {
        throw new TypeError(`mcp-quarantine.json has an invalid server entry: ${name}`);
      }
      if (held.disabledAt !== undefined && typeof held.disabledAt !== "string") {
        throw new TypeError(`mcp-quarantine.json has an invalid disabledAt: ${name}`);
      }
    }
  }

  function quarantineConfigStatus({ state, source, code = null, message = null, causeCode = null }) {
    return {
      state,
      source,
      writable: state === "ready",
      failClosed: state === "degraded",
      path: quarantinePath,
      code,
      message,
      causeCode,
    };
  }

  function quarantineConfigError(status) {
    return Object.assign(new Error(status.message || "MCP quarantine configuration is unavailable"), {
      code: status.code || "MCP_QUARANTINE_UNAVAILABLE",
      quarantineStatus: status,
    });
  }

  // 缺文件是尚未隔离过任何条目的正常空态；只要文件存在，任何读/解析/结构错误都必须
  // fail-closed，不能把含恢复凭据的损坏台账翻译成“空隔离区”。
  async function readQuarantineState() {
    if (!quarantinePath) {
      const status = quarantineConfigStatus({
        state: "degraded",
        source: "unconfigured",
        code: "MCP_QUARANTINE_UNAVAILABLE",
        message: "MCP quarantine path is unavailable; MCP mutations are blocked",
      });
      return { config: null, status };
    }
    let text;
    try {
      text = await io.readFile(quarantinePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          config: normalizeQuarantine({ servers: {} }),
          status: quarantineConfigStatus({ state: "ready", source: "missing-default" }),
        };
      }
      const status = quarantineConfigStatus({
        state: "degraded",
        source: "disk",
        code: "MCP_QUARANTINE_UNREADABLE",
        message: "MCP quarantine is unreadable; MCP mutations are blocked",
        causeCode: error?.code ?? null,
      });
      return { config: null, status };
    }
    try {
      const parsed = JSON.parse(text);
      validateQuarantineDocument(parsed);
      return {
        config: normalizeQuarantine(parsed),
        status: quarantineConfigStatus({ state: "ready", source: "disk" }),
      };
    } catch {
      const status = quarantineConfigStatus({
        state: "degraded",
        source: "disk",
        code: "MCP_QUARANTINE_CORRUPT",
        message: "MCP quarantine is corrupt; MCP mutations are blocked",
      });
      return { config: null, status };
    }
  }

  async function readQuarantine() {
    const result = await readQuarantineState();
    if (result.status.failClosed) throw quarantineConfigError(result.status);
    return result.config;
  }

  // 缺文件才代表尚未配置（默认空负名单）；一旦文件存在，读失败/JSON 或结构损坏都必须
  // fail-closed。否则损坏配置会被解释为“全部 skill 启用”，正好把安全状态翻转。
  async function readAgentCapsState() {
    if (!capsPath) {
      const status = capabilityConfigStatus({
        state: "degraded",
        source: "unconfigured",
        code: "CAPABILITY_CONFIG_UNAVAILABLE",
        message: "agent capability configuration path is unavailable; dispatch and mutations are blocked",
      });
      return { config: null, status };
    }
    let text;
    try {
      text = await io.readFile(capsPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          config: normalizeAgentCaps({ agents: {} }),
          status: capabilityConfigStatus({ state: "ready", source: "missing-default" }),
        };
      }
      const status = capabilityConfigStatus({
        state: "degraded",
        source: "disk",
        code: "CAPABILITY_CONFIG_UNREADABLE",
        message: "agent capability configuration is unreadable; dispatch and mutations are blocked",
        causeCode: error?.code ?? null,
      });
      return { config: null, status };
    }
    try {
      const parsed = JSON.parse(text);
      validateAgentCapsDocument(parsed);
      return {
        config: normalizeAgentCaps(parsed),
        status: capabilityConfigStatus({ state: "ready", source: "disk" }),
      };
    } catch {
      const status = capabilityConfigStatus({
        state: "degraded",
        source: "disk",
        code: "CAPABILITY_CONFIG_CORRUPT",
        message: "agent capability configuration is corrupt; dispatch and mutations are blocked",
      });
      return { config: null, status };
    }
  }

  async function readAgentCaps() {
    const result = await readAgentCapsState();
    if (result.status.failClosed) throw capabilityConfigError(result.status);
    return result.config;
  }

  async function agentConfigStatus() {
    return (await readAgentCapsState()).status;
  }

  async function agentDisabledSkills(agentId) {
    const cleanAgentId = validateIdentifier(agentId, "agentId");
    const caps = await readAgentCaps();
    return new Set(caps.agents[cleanAgentId]?.disabledSkills ?? []);
  }

  async function disabledMcpNames() {
    const quarantineState = await readQuarantineState();
    return {
      failClosed: Boolean(quarantineState.status?.failClosed),
      names: new Set(Object.keys(quarantineState.config?.servers ?? {})),
    };
  }

  async function setAgentSkill(agentId, skill, enabled) {
    ({ agentId, skill } = await validateAgentSkill(agentId, skill));
    return serializeMutation(`agent-capabilities:${capsPath}`, async () => {
      const caps = await readAgentCaps();
      caps.agents ??= {};
      caps.agents[agentId] ??= { disabledSkills: [] };
      const disabled = new Set(caps.agents[agentId].disabledSkills ?? []);
      if (enabled) disabled.delete(skill);
      else disabled.add(skill);
      caps.agents[agentId].disabledSkills = [...disabled];
      await writeJsonAtomic(capsPath, caps);
      await eventStore?.emit("capabilities.agent_skill_toggled", { agentId, skill, enabled }, { sensitivity: "internal", agentId: "control-plane" }).catch(() => {});
      return { agentId, skill, enabled };
    });
  }

  async function readClaudeMcpConfig(file) {
    let text;
    try {
      text = await io.readFile(file, "utf8");
    } catch (error) {
      throw Object.assign(new Error(".claude.json 无法读取，MCP 变更已阻断"), {
        code: "MCP_SOURCE_UNREADABLE",
        causeCode: error?.code ?? null,
      });
    }
    let config;
    try {
      config = JSON.parse(text);
    } catch {
      throw Object.assign(new Error(".claude.json JSON 损坏，MCP 变更已阻断"), { code: "MCP_SOURCE_CORRUPT" });
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw Object.assign(new Error(".claude.json 结构损坏，MCP 变更已阻断"), { code: "MCP_SOURCE_CORRUPT" });
    }
    if (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers))) {
      throw Object.assign(new Error(".claude.json mcpServers 结构损坏，MCP 变更已阻断"), { code: "MCP_SOURCE_CORRUPT" });
    }
    config.mcpServers = safeRecord(config.mcpServers);
    return { config, text };
  }

  function mcpTransactionError(action, error, retainedIn) {
    if (["MCP_SOURCE_CONFLICT", "MCP_QUARANTINE_CONFLICT", "MCP_RESTORE_CONFLICT"].includes(error?.code)) return error;
    return Object.assign(new Error(`MCP ${action} transaction did not complete; recovery entry remains in ${retainedIn}`), {
      code: "MCP_TRANSACTION_INCOMPLETE",
      causeCode: error?.code ?? null,
      retainedIn,
    });
  }

  // MCP 隔离式启停（claude.json 全局 server）：每一步只增加或移动恢复副本。
  // disable 先落隔离再删源；enable 先恢复源再清隔离，任一阶段失败都至少保留一份 entry。
  async function toggleMcpServer({ name, source, action, knownMtimeMs }) {
    if (action !== "disable" && action !== "enable") {
      throw Object.assign(new Error("action must be disable|enable"), { code: "VALIDATION_FAILED" });
    }
    const home = homeDir ?? process.env.USERPROFILE ?? process.env.HOME ?? "";
    const claudeJson = join(home, ".claude.json");
    name = validateIdentifier(name, "MCP server name");
    source = String(source ?? "");
    if (!sameSourcePath(source, claudeJson)) {
      throw Object.assign(new Error("该来源暂只读（codex TOML / settings.json 的安全编辑器未就绪）"), { code: "READ_ONLY_SOURCE" });
    }
    return serializeMutation(`mcp-config:${claudeJson}`, async () => {
      // mtime 乐观锁：扫描后文件被外部（Claude Code 本体）改写即拒——不覆写他人变更
      let current;
      try {
        current = await io.stat(claudeJson);
      } catch (error) {
        if (error?.code === "ENOENT") throw Object.assign(new Error(".claude.json 不存在"), { code: "SOURCE_NOT_FOUND" });
        throw Object.assign(new Error(".claude.json 无法读取，MCP 变更已阻断"), {
          code: "MCP_SOURCE_UNREADABLE",
          causeCode: error?.code ?? null,
        });
      }
      if (Number.isFinite(knownMtimeMs) && Math.abs(current.mtimeMs - knownMtimeMs) > 1) {
        throw Object.assign(new Error(".claude.json 已被外部修改，请刷新后重试（避免覆写 Claude Code 的并发写入）"), { code: "STALE_BASE" });
      }
      const quarantine = await readQuarantine();
      const { config, text: originalText } = await readClaudeMcpConfig(claudeJson);

      if (action === "disable") {
        const entry = config.mcpServers[name];
        if (!entry) {
          if (quarantine.servers[name]) return { name, disabled: true, note: "条目已在隔离区" };
          throw Object.assign(new Error(`全局 mcpServers 无 ${name}`), { code: "SOURCE_NOT_FOUND" });
        }
        const previousHeld = quarantine.servers[name];
        if (previousHeld && !isDeepStrictEqual(previousHeld.entry, entry)) {
          throw Object.assign(new Error(`隔离区与 claude.json 中的同名 MCP 条目 ${name} 内容不同，未修改任一副本`), {
            code: "MCP_QUARANTINE_CONFLICT",
          });
        }
        try {
          // 备份保留源文件原字节；每次替换都重新收紧私密权限。
          await writeTextAtomic(`${claudeJson}.514cc-backup`, originalText);
        } catch (error) {
          throw mcpTransactionError("disable backup", error, ".claude.json");
        }
        quarantine.servers[name] = {
          entry,
          disabledAt: previousHeld?.disabledAt ?? new Date().toISOString(),
        };
        try {
          // 必须先持久化隔离记录。这里失败时源配置尚未改变。
          await writeJsonAtomic(quarantinePath, quarantine);
        } catch (error) {
          throw mcpTransactionError("disable quarantine", error, ".claude.json");
        }
        // Quarantine 持久化后重读最新源，只在目标 entry 未漂移时删除该键；
        // 其他进程在前序 I/O 期间新增的 sibling 字段会被保留。
        const latest = await readClaudeMcpConfig(claudeJson);
        const latestEntry = latest.config.mcpServers[name];
        if (!latestEntry) {
          await eventStore?.emit("capabilities.mcp_disabled", { name }, { sensitivity: "internal", agentId: "control-plane" }).catch(() => {});
          return { name, disabled: true, note: "条目已由外部移除，隔离副本已保留" };
        }
        if (!isDeepStrictEqual(latestEntry, entry)) {
          throw Object.assign(new Error(`claude.json 中的同名 MCP 条目 ${name} 已在事务期间变化，隔离副本保持不变`), {
            code: "MCP_SOURCE_CONFLICT",
          });
        }
        delete latest.config.mcpServers[name];
        try {
          await writeJsonAtomic(claudeJson, latest.config, { expectedText: latest.text, conflictCode: "MCP_SOURCE_CONFLICT" });
        } catch (error) {
          throw mcpTransactionError("disable source update", error, ".claude.json and mcp-quarantine.json");
        }
        await eventStore?.emit("capabilities.mcp_disabled", { name }, { sensitivity: "internal", agentId: "control-plane" }).catch(() => {});
        return { name, disabled: true };
      }

      // enable 可重入：恢复源成功但清隔离失败时形成双份；重试只清相同副本，不会丢 entry。
      const held = quarantine.servers[name];
      if (!held) {
        if (config.mcpServers[name]) return { name, disabled: false, note: "条目已启用" };
        throw Object.assign(new Error(`隔离区与全局 mcpServers 均无 ${name}`), { code: "SOURCE_NOT_FOUND" });
      }
      if (config.mcpServers[name]) {
        if (!isDeepStrictEqual(config.mcpServers[name], held.entry)) {
          throw Object.assign(new Error(`claude.json 已存在不同的同名 MCP 条目 ${name}，隔离副本保持不变`), { code: "MCP_RESTORE_CONFLICT" });
        }
        delete quarantine.servers[name];
        try {
          await writeJsonAtomic(quarantinePath, quarantine);
        } catch (error) {
          throw mcpTransactionError("enable quarantine cleanup", error, ".claude.json and mcp-quarantine.json");
        }
        return { name, disabled: false, note: "claude.json 已存在同名条目（外部已恢复），隔离副本已清" };
      }
      try {
        await writeTextAtomic(`${claudeJson}.514cc-backup`, originalText);
      } catch (error) {
        throw mcpTransactionError("enable backup", error, "mcp-quarantine.json");
      }
      // 备份完成后再次读取最新源，保留外部新增的 sibling 字段，并对同名漂移拒绝覆盖。
      const latest = await readClaudeMcpConfig(claudeJson);
      if (latest.config.mcpServers[name]) {
        if (!isDeepStrictEqual(latest.config.mcpServers[name], held.entry)) {
          throw Object.assign(new Error(`claude.json 中的同名 MCP 条目 ${name} 已在事务期间变化，隔离副本保持不变`), {
            code: "MCP_SOURCE_CONFLICT",
          });
        }
        delete quarantine.servers[name];
        await writeJsonAtomic(quarantinePath, quarantine);
        return { name, disabled: false, note: "claude.json 已由外部恢复同名条目，隔离副本已清" };
      }
      latest.config.mcpServers[name] = held.entry;
      try {
        // 先恢复源，失败时隔离记录保持原样。
        await writeJsonAtomic(claudeJson, latest.config, { expectedText: latest.text, conflictCode: "MCP_SOURCE_CONFLICT" });
      } catch (error) {
        throw mcpTransactionError("enable source restore", error, "mcp-quarantine.json");
      }
      delete quarantine.servers[name];
      try {
        await writeJsonAtomic(quarantinePath, quarantine);
      } catch (error) {
        throw mcpTransactionError("enable quarantine cleanup", error, ".claude.json and mcp-quarantine.json");
      }
      await eventStore?.emit("capabilities.mcp_enabled", { name }, { sensitivity: "internal", agentId: "control-plane" }).catch(() => {});
      return { name, disabled: false };
    });
  }

  return {
    agentDisabledSkills,
    disabledMcpNames,
    agentConfigStatus,
    setAgentSkill,
    toggleMcpServer,
    async createSkill({ name, description = "", body = "" } = {}) {
      const code = String(name ?? "").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(code) || PROTOTYPE_KEYS.has(code)) {
        throw Object.assign(new Error("Skill 名称只能用字母、数字、点、下划线和连字符，且不能超过 64 字"), { code: "VALIDATION_FAILED" });
      }
      const desc = String(description ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      const textBody = String(body ?? "").slice(0, 64 * 1024);
      const relative = join(".agents", "skills", code);
      const dir = resolve(repoRoot, relative);
      const rootResolved = resolve(repoRoot);
      if (dir !== join(rootResolved, ".agents", "skills", code)) {
        throw Object.assign(new Error("Skill 路径越界"), { code: "VALIDATION_FAILED" });
      }
      try {
        await io.stat(dir);
        throw Object.assign(new Error(`Skill「${code}」已存在`), { code: "SKILL_EXISTS" });
      } catch (error) {
        if (error?.code === "SKILL_EXISTS") throw error;
        if (error?.code !== "ENOENT") throw error;
      }
      await io.mkdir(dir, { recursive: true });
      const yamlDesc = desc.replace(/"/g, '\\"');
      const content = `---\nname: ${code}\ndescription: "${yamlDesc}"\n---\n\n${textBody.trim() ? `${textBody.trim()}\n` : ""}`;
      await io.writeFile(join(dir, "SKILL.md"), content, { encoding: "utf8", flag: "wx" });
      await eventStore?.emit("capabilities.skill_created", { code, path: relative.split(sep).join("/") }, { sensitivity: "internal", agentId: "control-plane" }).catch(() => {});
      return { code, path: relative.split(sep).join("/"), description: desc, created: true };
    },
    async summary() {
      const moduleYamlPath = join(repoRoot, "module.yaml");
      let registry = { skills: [], agents: [], mcp_servers: [] };
      let registryStatus = "ok";
      try {
        registry = parseModuleYamlBlocks(await readFile(moduleYamlPath, "utf8"));
      } catch {
        registryStatus = "unavailable"; // module.yaml 读不出：注册表面如实降级，文件系统扫描照常
      }
      const skills = await scanSkillDirs(repoRoot);
      for (const skill of skills) {
        skill.sourceId = configSourceId(resolve(repoRoot, skill.path, "SKILL.md"));
      }
      // 注册表交叉：文件系统存在的 skill 标注注册表元数据；注册表有而磁盘无的如实列出（幽灵注册）
      const byPath = new Map(registry.skills.map((item) => [String(item.path ?? ""), item]));
      for (const skill of skills) {
        const registered = byPath.get(skill.path.replace(/\\/g, "/")) ?? byPath.get(skill.path);
        if (registered) {
          skill.registryType = registered.type ?? null;
          skill.registryPhase = registered.phase ?? null;
          if (!skill.description && registered.description) skill.description = String(registered.description);
        }
        skill.registered = Boolean(registered);
      }
      const ghostRegistrations = registry.skills
        .filter((item) => item.path && !skills.some((skill) => skill.path.replace(/\\/g, "/") === String(item.path)))
        .map((item) => ({ code: item.code, path: item.path, type: item.type ?? null }));

      const teams = (teamsStore?.list?.() ?? []).map((team) => ({
        id: team.id,
        name: team.name,
        builtin: Boolean(team.builtin),
        skills: team.skills ?? [],
        members: team.members ?? [],
      }));
      // skill × 团队声明矩阵：声明了该 skill 的团队名单
      for (const skill of skills) {
        skill.teams = teams.filter((team) => team.skills.includes(skill.code)).map((team) => team.name);
      }
      // 启停矩阵列：成员库是真源；旧调用方无成员库注入时回退团队 union。
      const capsState = await readAgentCapsState();
      const caps = capsState.config;
      const memberIds = configuredMemberIds(teams);
      const agentSkillStates = Object.create(null);
      const failClosedSkills = [...new Set([
        ...skills.map((skill) => skill.code),
        ...teams.flatMap((team) => team.skills),
      ])];
      for (const memberId of memberIds) {
        agentSkillStates[memberId] = {
          disabledSkills: capsState.status.failClosed
            ? failClosedSkills
            : caps?.agents?.[memberId]?.disabledSkills ?? [],
          failClosed: capsState.status.failClosed,
        };
      }

      const mcpServers = [];
      const home = homeDir ?? process.env.USERPROFILE ?? process.env.HOME ?? "";
      let claudeJsonMtimeMs = null;
      if (home) {
        await scanClaudeJson(join(home, ".claude.json"), mcpServers);
        await scanClaudeSettings(join(home, ".claude", "settings.json"), mcpServers);
        await scanCodexToml(join(home, ".codex", "config.toml"), mcpServers);
        claudeJsonMtimeMs = (await stat(join(home, ".claude.json")).catch(() => null))?.mtimeMs ?? null;
      }
      // 隔离区条目并回 MCP 表（禁用态可见、可一键恢复）。损坏/不可读时不伪造成空态，
      // 只回显 degraded 状态并冻结启停；原文件字节保持不变。
      const quarantineState = await readQuarantineState();
      if (quarantineState.config) {
        for (const [name, held] of Object.entries(quarantineState.config.servers ?? {})) {
          mcpServers.push({ name, transport: transportOf(held.entry), source: join(home, ".claude.json"), scope: "全局", disabled: true, disabledAt: held.disabledAt });
        }
      }
      for (const server of mcpServers) server.sourceId = configSourceId(server.source);
      const mcpSources = [...new Set(mcpServers.map((server) => server.source))];
      return {
        generatedAt: new Date().toISOString(),
        skills: {
          items: skills,
          agents: registry.agents.map((agent) => ({
            code: agent.code,
            name: agent.name,
            title: agent.title ?? "",
            skill: agent.skill ?? null,
          })),
          teams,
          memberIds,
          agentSkillStates,
          configurationStatus: capsState.status,
          ghostRegistrations,
          registryStatus,
        },
        mcp: {
          servers: mcpServers,
          sources: mcpSources,
          claudeJsonMtimeMs,
          configurationStatus: quarantineState.status,
          capabilityMap: registry.mcp_servers, // 514cc 能力映射（module.yaml 策展层）
        },
      };
    },
  };
}
