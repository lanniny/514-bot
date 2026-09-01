/**
 * market.mjs — Wave G 供应链核心（MCP 双 registry + Skills stage-then-swap）。
 *
 * 契约（v40 设计 §3.5）：
 *   - MCP：官方 registry + smithery 搜索/详情；两段式 stage→审查报告→confirmed 安装；哈希台账
 *   - Skills：下载（来源 allowlist）→ 解压 → SKILL.md 校验 → stage-then-swap 原子安装 + 写锁
 *   - registry 不可达明确 502，不 silent fallback
 *   - fetch 注入式（测试 mock）
 */

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

const MCP_SOURCES = Object.freeze({
  official: {
    search: (query) => `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(query)}`,
    detail: (id) => `https://registry.modelcontextprotocol.io/v0/servers/${encodeURIComponent(id)}`,
  },
  smithery: {
    search: (query) => `https://registry.smithery.ai/servers?q=${encodeURIComponent(query)}`,
    detail: (id) => `https://registry.smithery.ai/servers/${encodeURIComponent(id)}`,
  },
});

const DEFAULT_SKILL_HOST_ALLOWLIST = Object.freeze([
  "github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
]);

function marketError(code, message, httpStatus = 400) {
  return Object.assign(new Error(message), { code, httpStatus });
}

/** stageId 只接受服务端签发的 UUID 片段字符；路径插值前消毒，防 `../` 逃出 staging 目录。 */
function safeStageId(value) {
  const id = String(value ?? "").replace(/[^A-Za-z0-9-]/g, "");
  if (!id) throw marketError("MARKET_STAGE_NOT_FOUND", "staging entry not found", 404);
  return id;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** 极简 YAML frontmatter 行解析（name:/description: 顶层键）。 */
function parseSkillFrontmatter(text) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
    if (pair && !fields[pair[1]]) fields[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, "");
  }
  return fields;
}

async function extractZip(zipPath, targetDir) {
  const root = resolve(targetDir);
  await mkdir(root, { recursive: true });
  try {
    await new Promise((resolveExtract, rejectExtract) => {
      yauzl.open(zipPath, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (openError, zip) => {
        if (openError || !zip) {
          rejectExtract(marketError("MARKET_EXTRACT_FAILED", `invalid zip: ${openError?.message || "open failed"}`, 400));
          return;
        }
        let settled = false;
        let entryCount = 0;
        let totalBytes = 0;
        const failExtract = (error) => {
          if (settled) return;
          settled = true;
          zip.close();
          const message = String(error?.message || error).slice(0, 300);
          rejectExtract(error?.code?.startsWith?.("MARKET_")
            ? error
            : /invalid relative path|absolute path|backslash/i.test(message)
              ? marketError("MARKET_ARCHIVE_PATH", message, 400)
              : marketError("MARKET_EXTRACT_FAILED", message, 400));
        };
        zip.once("error", failExtract);
        zip.once("end", () => {
          if (settled) return;
          settled = true;
          resolveExtract();
        });
        zip.on("entry", (entry) => {
          void (async () => {
            entryCount += 1;
            if (entryCount > 2_000) throw marketError("MARKET_ARCHIVE_LIMIT", "skill archive exceeds 2000 entries", 413);
            const name = String(entry.fileName).replace(/\\/g, "/");
            if (!name || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").some((part) => part === "..")) {
              throw marketError("MARKET_ARCHIVE_PATH", `unsafe archive path: ${name}`, 400);
            }
            const target = resolve(root, ...name.split("/").filter(Boolean));
            const rel = relative(root, target);
            if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw marketError("MARKET_ARCHIVE_PATH", `archive path escapes staging root: ${name}`, 400);
            const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
            if ((unixMode & 0o170000) === 0o120000) throw marketError("MARKET_ARCHIVE_PATH", `archive symlink is forbidden: ${name}`, 400);
            if (name.endsWith("/")) {
              await mkdir(target, { recursive: true });
              zip.readEntry();
              return;
            }
            totalBytes += Number(entry.uncompressedSize) || 0;
            if (entry.uncompressedSize > 16 * 1024 * 1024 || totalBytes > 64 * 1024 * 1024) {
              throw marketError("MARKET_ARCHIVE_LIMIT", "skill archive expands beyond the allowed size", 413);
            }
            await mkdir(dirname(target), { recursive: true });
            const stream = await new Promise((resolveStream, rejectStream) => zip.openReadStream(entry, (error, value) => error ? rejectStream(error) : resolveStream(value)));
            await pipeline(stream, createWriteStream(target, { flags: "wx", mode: 0o600 }));
            zip.readEntry();
          })().catch(failExtract);
        });
        zip.readEntry();
      });
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** 找到解压产物中含 SKILL.md 的根（zip 常带一层包裹目录）。 */
async function findSkillRoot(dir) {
  const direct = await stat(join(dir, "SKILL.md")).catch(() => null);
  if (direct?.isFile()) return dir;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = await stat(join(dir, entry.name, "SKILL.md")).catch(() => null);
    if (nested?.isFile()) return join(dir, entry.name);
  }
  return null;
}

const DEFAULT_REPOS = Object.freeze([
  { owner: "anthropics", name: "skills", branch: "main" },
]);

function parseRepoRef(input) {
  const raw = String(input ?? "").trim();
  const fromUrl = raw.match(/github\.com[/:]([^/]+)\/([^/#?]+)/i);
  const text = fromUrl ? `${fromUrl[1]}/${fromUrl[2].replace(/\.git$/i, "")}` : raw;
  const match = text.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) throw marketError("MARKET_BAD_REPO", "仓库格式应为 owner/name 或 GitHub URL");
  return { owner: match[1], name: match[2] };
}

function repoId(owner, name) {
  return `${owner}/${name}`;
}

function mcpIdFromRegistry(value) {
  const cleaned = String(value ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return /^[A-Za-z0-9]/.test(cleaned) ? cleaned : `mcp-${cleaned || "server"}`.slice(0, 96);
}

function mcpConfigFromRegistry(raw = {}) {
  const pkg = Array.isArray(raw.packages) ? raw.packages[0] ?? {} : {};
  const remote = Array.isArray(raw.remotes) ? raw.remotes[0] ?? {} : {};
  const url = String(raw.url ?? pkg.transport?.url ?? remote.url ?? "").trim();
  const command = String(raw.command ?? pkg.command ?? "").trim();
  const args = Array.isArray(raw.args) ? raw.args.map(String) : Array.isArray(pkg.args) ? pkg.args.map(String) : [];
  if (url && !command) return { type: "http", url, headers: {}, env: {} };
  if (!command && pkg.identifier) {
    return { type: "stdio", command: "npx", args: ["-y", String(pkg.identifier)], env: {} };
  }
  if (command) return { type: "stdio", command, args, env: {} };
  return null;
}

function assertInside(root, target, label) {
  const rel = relative(resolve(root), resolve(target));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw marketError("MARKET_PATH", `${label} escapes root`);
  return resolve(target);
}

export function createMarketService({
  dataRoot,
  eventStore = null,
  fetchImpl = globalThis.fetch,
  skillHostAllowlist = DEFAULT_SKILL_HOST_ALLOWLIST,
  mcpSources = MCP_SOURCES,
  ccswitchDomain = null,
  repoRoot = null,
} = {}) {
  const root = String(dataRoot);
  const stagingDir = join(root, "market", "staging");
  const skillsDir = join(root, "market", "skills");
  const installedPath = join(root, "market", "installed.json");
  const reposPath = join(root, "market", "repos.json");
  const state = {
    writeChain: Promise.resolve(),
    installLocks: new Map(), // skillName → Promise（写锁串行化）
  };

  function audit(type, detail) {
    void eventStore?.emit?.(type, detail, { sensitivity: "internal", agentId: "control-plane" })?.catch?.(() => {});
  }

  async function readInstalled() {
    try {
      const parsed = JSON.parse(await readFile(installedPath, "utf8"));
      return parsed?.items ?? [];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return [];
    }
  }

  /** 台账读-改-写全程挂在写链内：并发安装不丢更新（烛式竞态修法）。 */
  function rewriteInstalled(mutator) {
    const op = state.writeChain.then(async () => {
      const items = mutator(await readInstalled());
      await mkdir(join(root, "market"), { recursive: true });
      const tmp = `${installedPath}.tmp`;
      await writeFile(tmp, JSON.stringify({ schema: "514cc.market-installed/v1", items }, null, 2), "utf8");
      await rename(tmp, installedPath);
    });
    state.writeChain = op.catch(() => {});
    return op;
  }

  function appendInstalled(item) {
    return rewriteInstalled((items) => [...items, item]);
  }

  async function readRepos() {
    try {
      const parsed = JSON.parse(await readFile(reposPath, "utf8"));
      return Array.isArray(parsed?.repos) ? parsed.repos : [];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return DEFAULT_REPOS.map((item) => ({
        id: repoId(item.owner, item.name),
        owner: item.owner,
        name: item.name,
        branch: item.branch,
        skills: [],
        scannedAt: null,
      }));
    }
  }

  async function writeRepos(repos) {
    await mkdir(join(root, "market"), { recursive: true });
    const tmp = `${reposPath}.tmp`;
    await writeFile(tmp, JSON.stringify({ schema: "514cc.market-repos/v1", repos }, null, 2), "utf8");
    await rename(tmp, reposPath);
  }

  async function fetchJson(url, headers = {}) {
    let response;
    try {
      response = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": "514cc-control-center", ...headers } });
    } catch (error) {
      throw marketError("MARKET_REGISTRY_UNREACHABLE", `registry unreachable: ${error.message}`, 502);
    }
    if (!response?.ok) throw marketError("MARKET_REGISTRY_UNREACHABLE", `registry returned ${response?.status}`, 502);
    return response.json();
  }

  function normalizeMcpEntry(source, raw) {
    const entry = raw ?? {};
    return {
      id: String(entry.name ?? entry.id ?? entry.qualifiedName ?? ""),
      name: String(entry.title ?? entry.displayName ?? entry.name ?? ""),
      description: String(entry.description ?? "").slice(0, 500),
      source,
      packageHint: entry.packages?.[0]?.name ?? entry.package ?? entry.qualifiedName ?? null,
    };
  }

  async function mcpSearch(query, source = "official") {
    const adapter = mcpSources[source];
    if (!adapter) throw marketError("MARKET_BAD_SOURCE", `unknown mcp source: ${source}`);
    const payload = await fetchJson(adapter.search(String(query || "")));
    const list = payload?.servers ?? payload?.items ?? payload?.data ?? [];
    return list.slice(0, 30).map((entry) => normalizeMcpEntry(source, entry?.server ?? entry));
  }

  async function mcpStage({ source = "official", id } = {}) {
    const adapter = mcpSources[source];
    if (!adapter) throw marketError("MARKET_BAD_SOURCE", `unknown mcp source: ${source}`);
    if (!id) throw marketError("MARKET_BAD_ID", "id is required");
    const detail = await fetchJson(adapter.detail(id));
    const raw = detail?.server ?? detail ?? {};
    const normalized = normalizeMcpEntry(source, raw);
    const config = mcpConfigFromRegistry(raw);
    const review = {
      id: normalized.id,
      name: normalized.name,
      description: normalized.description,
      source,
      command: config?.command ?? raw.command ?? raw.packages?.[0]?.command ?? null,
      args: config?.args ?? raw.args ?? raw.packages?.[0]?.args ?? [],
      url: config?.url ?? null,
      config,
      envKeys: Object.keys(raw.env ?? raw.environmentVariables ?? raw.packages?.[0]?.env ?? {}),
      hash: sha256(Buffer.from(JSON.stringify(raw))),
    };
    const stageId = randomUUID().slice(0, 12);
    await mkdir(stagingDir, { recursive: true });
    await writeFile(join(stagingDir, `mcp-${stageId}.json`), JSON.stringify({ kind: "mcp", stageId, review, stagedAt: new Date().toISOString() }, null, 2), "utf8");
    audit("market.stage", { kind: "mcp", id: normalized.id, source });
    return { ok: true, stageId, review };
  }

  async function mcpInstall({ stageId: rawStageId, confirmed, apps } = {}) {
    if (confirmed !== true) throw marketError("MARKET_NOT_CONFIRMED", "install requires confirmed: true", 409);
    // stageId 由服务端签发（UUID 片段字符）；插值进路径前消毒，防 `../` 逃出 staging 目录
    const stageId = safeStageId(rawStageId);
    const stagePath = join(stagingDir, `mcp-${stageId}.json`);
    let staged = null;
    try {
      staged = JSON.parse(await readFile(stagePath, "utf8"));
    } catch {
      throw marketError("MARKET_STAGE_NOT_FOUND", `staging entry not found: ${stageId}`, 404);
    }
    const config = staged.review?.config ?? mcpConfigFromRegistry(staged.review ?? {});
    if (!config?.command && !config?.url) {
      throw marketError("MARKET_MCP_INCOMPLETE", "目录未给出 command 或 url，请改用「新建 MCP」手填完整 JSON", 409);
    }
    const selectedApps = apps && typeof apps === "object" && !Array.isArray(apps)
      ? apps
      : { claude: true };
    if (!Object.values(selectedApps).some(Boolean)) {
      throw marketError("MARKET_MCP_NO_APP", "至少勾选一个投影目标", 400);
    }
    let projected = null;
    if (ccswitchDomain?.upsertMcp) {
      projected = await ccswitchDomain.upsertMcp({
        id: mcpIdFromRegistry(staged.review.id || staged.review.name),
        name: staged.review.name || staged.review.id || "MCP",
        description: staged.review.description ?? "",
        config,
        apps: selectedApps,
      });
    }
    await appendInstalled({
      kind: "mcp",
      id: projected?.id ?? staged.review.id,
      source: staged.review.source,
      hash: staged.review.hash,
      review: staged.review,
      apps: selectedApps,
      projected: Boolean(projected),
      installedAt: new Date().toISOString(),
    });
    await rm(stagePath, { force: true });
    audit("market.install", { kind: "mcp", id: staged.review.id, projected: Boolean(projected) });
    return { ok: true, installed: staged.review, projected: Boolean(projected), item: projected };
  }

  function assertSkillUrl(url) {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      throw marketError("MARKET_BAD_URL", "invalid url");
    }
    if (parsed.protocol !== "https:") throw marketError("MARKET_URL_FORBIDDEN", "only https: sources are allowed", 403);
    if (!skillHostAllowlist.includes(parsed.hostname.toLowerCase())) {
      throw marketError("MARKET_URL_FORBIDDEN", `host not in allowlist: ${parsed.hostname}`, 403);
    }
    return parsed;
  }

  async function skillsStage({ url, skillPath = "" } = {}) {
    const parsed = assertSkillUrl(url);
    let buffer;
    if (parsed.protocol === "file:" || parsed.hostname === "local.fixture") {
      buffer = await readFile(decodeURIComponent(parsed.pathname.replace(/^\/([A-Za-z]:)/, "$1")));
    } else {
      let response;
      try {
        response = await fetchImpl(parsed.href);
      } catch (error) {
        throw marketError("MARKET_DOWNLOAD_FAILED", `download failed: ${error.message}`, 502);
      }
      if (!response?.ok) throw marketError("MARKET_DOWNLOAD_FAILED", `download returned ${response?.status}`, 502);
      buffer = Buffer.from(await response.arrayBuffer());
    }
    if (buffer.length > 32 * 1024 * 1024) throw marketError("MARKET_TOO_LARGE", "skill archive exceeds 32MB", 413);
    const hash = sha256(buffer);
    const stageId = randomUUID().slice(0, 12);
    const stageRoot = join(stagingDir, `skill-${stageId}`);
    const zipPath = `${stageRoot}.zip`;
    await mkdir(stagingDir, { recursive: true });
    await writeFile(zipPath, buffer);
    try {
      await extractZip(zipPath, stageRoot);
    } finally {
      await rm(zipPath, { force: true });
    }
    const skillRoot = skillPath
      ? await findSkillAt(stageRoot, skillPath)
      : await findSkillRoot(stageRoot);
    if (!skillRoot) {
      await rm(stageRoot, { recursive: true, force: true });
      throw marketError("MARKET_SKILL_INVALID", skillPath ? `仓库里找不到 ${skillPath}/SKILL.md` : "archive contains no SKILL.md");
    }
    const frontmatter = parseSkillFrontmatter(await readFile(join(skillRoot, "SKILL.md"), "utf8"));
    if (!frontmatter.name || !frontmatter.description) {
      await rm(stageRoot, { recursive: true, force: true });
      throw marketError("MARKET_SKILL_INVALID", "SKILL.md frontmatter requires name and description");
    }
    if (!/^[\w][\w.-]{0,63}$/.test(frontmatter.name)) {
      await rm(stageRoot, { recursive: true, force: true });
      throw marketError("MARKET_SKILL_INVALID", `unsafe skill name: ${frontmatter.name}`);
    }
    const files = (await readdir(skillRoot, { recursive: true })).map(String).slice(0, 200);
    const review = { name: frontmatter.name, description: frontmatter.description, files, sha256: hash, sourceUrl: parsed.href };
    await writeFile(join(stageRoot, ".stage.json"), JSON.stringify({ kind: "skill", stageId, review, skillRoot }, null, 2), "utf8");
    audit("market.stage", { kind: "skill", name: frontmatter.name });
    return { ok: true, stageId, review };
  }

  async function skillsInstall({ stageId: rawStageId, confirmed, apps } = {}) {
    if (confirmed !== true) throw marketError("MARKET_NOT_CONFIRMED", "install requires confirmed: true", 409);
    const stageId = safeStageId(rawStageId);
    const stageRoot = join(stagingDir, `skill-${stageId}`);
    let staged = null;
    try {
      staged = JSON.parse(await readFile(join(stageRoot, ".stage.json"), "utf8"));
    } catch {
      throw marketError("MARKET_STAGE_NOT_FOUND", `staging entry not found: ${stageId}`, 404);
    }
    const name = staged.review.name;
    const selectedApps = apps && typeof apps === "object" && !Array.isArray(apps) ? apps : { claude: true, codex: true };
    // 写锁：同名 skill 安装串行（stage-then-swap 原子性只在串行下成立）
    const previous = state.installLocks.get(name) ?? Promise.resolve();
    const install = previous.then(async () => {
      const target = join(skillsDir, name);
      const swapTmp = join(skillsDir, `.${name}.swap`);
      await rm(swapTmp, { recursive: true, force: true });
      await mkdir(skillsDir, { recursive: true });
      await cp(staged.skillRoot, swapTmp, { recursive: true });
      const backup = join(skillsDir, `.${name}.old`);
      await rm(backup, { recursive: true, force: true });
      const hadOld = (await stat(target).catch(() => null)) != null;
      if (hadOld) await rename(target, backup);
      try {
        await rename(swapTmp, target);
      } catch (error) {
        if (hadOld) await rename(backup, target).catch(() => {});
        throw marketError("MARKET_SWAP_FAILED", `atomic swap failed: ${error.message}`, 500);
      }
      await rm(backup, { recursive: true, force: true });
      await rm(stageRoot, { recursive: true, force: true });
      await projectSkill(name, target, staged.review, selectedApps);
      await appendInstalled({ kind: "skill", id: name, hash: staged.review.sha256, review: staged.review, apps: selectedApps, installedAt: new Date().toISOString() });
      audit("market.install", { kind: "skill", name });
      return { ok: true, installed: { kind: "skill", name, path: target } };
    });
    state.installLocks.set(name, install.catch(() => {}));
    return install;
  }

  async function installedList() {
    return readInstalled();
  }

  async function skillsList() {
    const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
    const skills = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const frontmatter = parseSkillFrontmatter(await readFile(join(skillsDir, entry.name, "SKILL.md"), "utf8").catch(() => ""));
      skills.push({ name: entry.name, description: frontmatter.description ?? "" });
    }
    return skills;
  }

  function selectedAppsFrom(apps, fallback = { claude: true }) {
    const selected = apps && typeof apps === "object" && !Array.isArray(apps) ? apps : fallback;
    if (!Object.values(selected).some(Boolean)) {
      throw marketError("MARKET_MCP_NO_APP", "至少勾选一个投影目标", 400);
    }
    return selected;
  }

  async function skillsRemove(name) {
    const safe = String(name || "");
    if (!/^[\w][\w.-]{0,63}$/.test(safe)) throw marketError("MARKET_BAD_ID", `unsafe skill name: ${safe}`);
    const target = join(skillsDir, safe);
    const existed = (await stat(target).catch(() => null)) != null;
    const inLedger = (await readInstalled()).some((entry) => entry.kind === "skill" && entry.id === safe);
    if (!existed && !inLedger) return false;
    if (existed) await rm(target, { recursive: true, force: true });
    if (ccswitchDomain?.uninstallSkill) {
      await ccswitchDomain.uninstallSkill(safe, { confirmed: true }).catch(() => {});
    }
    await rewriteInstalled((items) => items.filter((entry) => !(entry.kind === "skill" && entry.id === safe)));
    audit("market.remove", { kind: "skill", name: safe });
    if (repoRoot) {
      await rm(join(repoRoot, ".agents", "skills", safe), { recursive: true, force: true }).catch(() => {});
    }
    return true;
  }

  async function mcpRemove(idValue) {
    const id = String(idValue || "").trim();
    if (!id) throw marketError("MARKET_BAD_ID", "id is required");
    const items = await readInstalled();
    const item = items.find((entry) => entry.kind === "mcp" && (entry.id === id || entry.review?.id === id));
    if (!item) throw marketError("MARKET_NOT_FOUND", `mcp not found: ${id}`, 404);
    if (ccswitchDomain?.deleteMcp && item.projected !== false) {
      await ccswitchDomain.deleteMcp(item.id).catch(() => {});
    }
    await rewriteInstalled((list) => list.filter((entry) => !(entry.kind === "mcp" && (entry.id === item.id || entry.review?.id === id))));
    audit("market.remove", { kind: "mcp", id: item.id });
    return { removed: item.id };
  }

  async function mcpUpdateApps({ id: idValue, apps } = {}) {
    const id = String(idValue || "").trim();
    if (!id) throw marketError("MARKET_BAD_ID", "id is required");
    const item = (await readInstalled()).find((entry) => entry.kind === "mcp" && (entry.id === id || entry.review?.id === id));
    if (!item) throw marketError("MARKET_NOT_FOUND", `mcp not found: ${id}`, 404);
    const selectedApps = selectedAppsFrom(apps);
    const config = item.review?.config ?? mcpConfigFromRegistry(item.review ?? {});
    if (!config?.command && !config?.url) {
      throw marketError("MARKET_MCP_INCOMPLETE", "目录未给出 command 或 url，无法改投影", 409);
    }
    let projected = item.projected;
    if (ccswitchDomain?.upsertMcp) {
      const result = await ccswitchDomain.upsertMcp({
        id: item.id,
        name: item.review?.name || item.id,
        description: item.review?.description ?? "",
        config,
        apps: selectedApps,
      });
      projected = Boolean(result);
    }
    await rewriteInstalled((list) => list.map((entry) => (
      entry.kind === "mcp" && entry.id === item.id ? { ...entry, apps: selectedApps, projected } : entry
    )));
    audit("market.reproject", { kind: "mcp", id: item.id });
    return { ok: true, id: item.id, apps: selectedApps, projected };
  }

  async function skillUpdateApps({ name, apps } = {}) {
    const safe = String(name || "");
    if (!/^[\w][\w.-]{0,63}$/.test(safe)) throw marketError("MARKET_BAD_ID", `unsafe skill name: ${safe}`);
    const target = join(skillsDir, safe);
    if (!(await stat(target).catch(() => null))) throw marketError("MARKET_NOT_FOUND", `skill not found: ${safe}`, 404);
    const selectedApps = selectedAppsFrom(apps, { claude: true, codex: true });
    const previous = (await readInstalled()).find((entry) => entry.kind === "skill" && entry.id === safe)?.apps ?? {};
    const frontmatter = parseSkillFrontmatter(await readFile(join(target, "SKILL.md"), "utf8").catch(() => ""));
    await projectSkill(safe, target, { description: frontmatter.description, sourceUrl: "market" }, selectedApps);
    if (ccswitchDomain?.toggleSkill) {
      for (const app of new Set([...Object.keys(previous), ...Object.keys(selectedApps)])) {
        if (previous[app] && !selectedApps[app]) {
          await ccswitchDomain.toggleSkill(safe, app, false).catch(() => {});
        }
      }
    }
    await rewriteInstalled((list) => {
      const next = list.map((entry) => (
        entry.kind === "skill" && entry.id === safe ? { ...entry, apps: selectedApps } : entry
      ));
      if (!next.some((entry) => entry.kind === "skill" && entry.id === safe)) {
        next.push({ kind: "skill", id: safe, apps: selectedApps, installedAt: new Date().toISOString() });
      }
      return next;
    });
    audit("market.reproject", { kind: "skill", name: safe });
    return { ok: true, id: safe, apps: selectedApps };
  }

  async function scanAllRepos() {
    const repos = await readRepos();
    const results = [];
    for (const repo of repos) {
      try {
        const scanned = await scanRepo(repo.id);
        results.push({ id: repo.id, ok: true, count: scanned.skills?.length ?? 0 });
      } catch (error) {
        results.push({ id: repo.id, ok: false, message: error.message, count: 0 });
      }
    }
    return { repos: results, skills: results.reduce((sum, item) => sum + (item.count || 0), 0) };
  }

  async function collectSkillFiles(skillRoot) {
    const files = {};
    const entries = await readdir(skillRoot, { recursive: true });
    for (const rel of entries) {
      const key = String(rel).replace(/\\/g, "/");
      if (!key || key.startsWith(".") || key.split("/").some((part) => part.startsWith("."))) continue;
      const full = join(skillRoot, rel);
      const info = await stat(full).catch(() => null);
      if (!info?.isFile() || info.size > 512 * 1024) continue;
      files[key] = await readFile(full, "utf8");
    }
    return files;
  }

  async function projectSkill(name, skillRoot, review, apps) {
    if (repoRoot) {
      const dest = assertInside(join(repoRoot, ".agents", "skills"), join(repoRoot, ".agents", "skills", name), "project skill");
      await rm(dest, { recursive: true, force: true });
      await mkdir(dirname(dest), { recursive: true });
      await cp(skillRoot, dest, { recursive: true });
    }
    if (ccswitchDomain?.installSkillFiles) {
      const files = await collectSkillFiles(skillRoot);
      if (files["SKILL.md"]) {
        await ccswitchDomain.installSkillFiles({
          name,
          description: review?.description ?? "",
          files,
          source: review?.sourceUrl ?? "market",
          apps,
        });
      }
    }
  }

  async function listRepos() {
    return readRepos();
  }

  async function addRepo({ url, branch = "main" } = {}) {
    const { owner, name } = parseRepoRef(url);
    const id = repoId(owner, name);
    const repos = await readRepos();
    if (repos.some((item) => item.id === id)) throw marketError("MARKET_REPO_EXISTS", `仓库已添加：${id}`, 409);
    const item = { id, owner, name, branch: String(branch || "main").trim() || "main", skills: [], scannedAt: null };
    repos.push(item);
    await writeRepos(repos);
    audit("market.repo_add", { id });
    return item;
  }

  async function removeRepo(idValue) {
    const id = String(idValue ?? "");
    const repos = await readRepos();
    const next = repos.filter((item) => item.id !== id);
    if (next.length === repos.length) throw marketError("MARKET_NOT_FOUND", `仓库不存在：${id}`, 404);
    await writeRepos(next);
    audit("market.repo_remove", { id });
    return { removed: id };
  }

  async function scanRepo(idValue) {
    const id = String(idValue ?? "");
    const repos = await readRepos();
    const item = repos.find((repo) => repo.id === id);
    if (!item) throw marketError("MARKET_NOT_FOUND", `仓库不存在：${id}`, 404);
    const treeUrl = `https://api.github.com/repos/${item.owner}/${item.name}/git/trees/${encodeURIComponent(item.branch)}?recursive=1`;
    const payload = await fetchJson(treeUrl);
    const nodes = Array.isArray(payload?.tree) ? payload.tree : [];
    const skills = [];
    for (const node of nodes) {
      const path = String(node?.path ?? "").replace(/\\/g, "/");
      if (!path.endsWith("/SKILL.md") && path !== "SKILL.md") continue;
      const dir = path === "SKILL.md" ? "" : path.slice(0, -"/SKILL.md".length);
      const name = (dir.split("/").filter(Boolean).at(-1) || item.name).slice(0, 64);
      skills.push({ name, path: dir || ".", description: "" });
    }
    const enriched = [];
    for (const skill of skills.slice(0, 80)) {
      const rawUrl = `https://raw.githubusercontent.com/${item.owner}/${item.name}/${item.branch}/${skill.path === "." ? "" : `${skill.path}/`}SKILL.md`;
      try {
        const response = await fetchImpl(rawUrl, { headers: { "user-agent": "514cc-control-center" } });
        if (response?.ok) {
          const frontmatter = parseSkillFrontmatter(await response.text());
          enriched.push({
            name: frontmatter.name || skill.name,
            path: skill.path,
            description: frontmatter.description ?? "",
          });
          continue;
        }
      } catch {
        /* 描述拿不到仍保留条目 */
      }
      enriched.push(skill);
    }
    item.skills = enriched;
    item.scannedAt = new Date().toISOString();
    await writeRepos(repos);
    audit("market.repo_scan", { id, count: enriched.length });
    return item;
  }

  async function catalogSkills(query = "") {
    const q = String(query ?? "").trim().toLowerCase();
    const repos = await readRepos();
    const items = [];
    for (const repo of repos) {
      for (const skill of repo.skills ?? []) {
        const hay = `${skill.name} ${skill.description} ${repo.id}`.toLowerCase();
        if (q && !hay.includes(q)) continue;
        items.push({
          ...skill,
          repoId: repo.id,
          repo: repo.id,
          branch: repo.branch,
          installed: false,
        });
      }
    }
    const installed = new Set((await skillsList()).map((skill) => skill.name));
    for (const item of items) item.installed = installed.has(item.name);
    return items;
  }

  async function findSkillAt(extractRoot, skillPath) {
    const entries = await readdir(extractRoot, { withFileTypes: true }).catch(() => []);
    const wrap = entries.length === 1 && entries[0].isDirectory() ? join(extractRoot, entries[0].name) : extractRoot;
    const relativePath = String(skillPath ?? ".").replace(/\\/g, "/");
    const target = relativePath === "." ? wrap : assertInside(wrap, join(wrap, ...relativePath.split("/").filter(Boolean)), "skill path");
    const skillMd = join(target, "SKILL.md");
    return (await stat(skillMd).catch(() => null))?.isFile() ? target : null;
  }

  async function skillsStageFromRepo({ repoId: idValue, skillPath } = {}) {
    const repos = await readRepos();
    const repo = repos.find((item) => item.id === String(idValue ?? ""));
    if (!repo) throw marketError("MARKET_NOT_FOUND", `仓库不存在：${idValue}`, 404);
    const zipUrl = `https://codeload.github.com/${repo.owner}/${repo.name}/zip/refs/heads/${encodeURIComponent(repo.branch)}`;
    return skillsStage({ url: zipUrl, skillPath });
  }

  // W3.12 团队模板库：团队包（514cc-team-pack/v1，buildTeamPack 产物）上架→安装→模板清单。
  // 安装 = 写入 installed.json 台账（kind:"team"），应用包仍走 team 视图既有 importTeamPack 流程
  // （模板库只做分发与版本留痕，不绕过团队配置的校验链）。
  function validateTeamPack(pack) {
    if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
      throw marketError("MARKET_TEAM_PACK_INVALID", "team pack must be an object", 400);
    }
    if (pack.format !== "514cc-team-pack" || pack.version !== 1) {
      throw marketError("MARKET_TEAM_PACK_INVALID", "team pack must be format '514cc-team-pack' version 1", 400);
    }
    const name = String(pack.team?.name ?? "").trim();
    if (!name) throw marketError("MARKET_TEAM_PACK_INVALID", "team pack requires team.name", 400);
    if (!Array.isArray(pack.team?.members) && !Array.isArray(pack.members?.custom) && !Array.isArray(pack.members?.builtinRefs)) {
      throw marketError("MARKET_TEAM_PACK_INVALID", "team pack requires members", 400);
    }
    return name;
  }

  async function teamStage({ pack } = {}) {
    const name = validateTeamPack(pack);
    const stageId = randomUUID().slice(0, 12);
    await mkdir(stagingDir, { recursive: true });
    await writeFile(join(stagingDir, `team-${stageId}.json`), JSON.stringify({
      kind: "team",
      stageId,
      review: { id: name, name, description: pack.team?.description ?? "", memberCount: (pack.members?.custom?.length ?? 0) + (pack.members?.builtinRefs?.length ?? 0), exportedAt: pack.exportedAt ?? null },
      pack,
      stagedAt: new Date().toISOString(),
    }, null, 2), "utf8");
    audit("market.stage", { kind: "team", id: name });
    return { ok: true, stageId, review: { id: name, name, description: pack.team?.description ?? "" } };
  }

  async function teamInstall({ stageId: rawStageId, confirmed } = {}) {
    if (confirmed !== true) throw marketError("MARKET_NOT_CONFIRMED", "install requires confirmed: true", 409);
    const stageId = safeStageId(rawStageId);
    let staged = null;
    try {
      staged = JSON.parse(await readFile(join(stagingDir, `team-${stageId}.json`), "utf8"));
    } catch {
      throw marketError("MARKET_STAGE_NOT_FOUND", `staging entry not found: ${stageId}`, 404);
    }
    validateTeamPack(staged.pack);
    await appendInstalled({ kind: "team", id: staged.review.id, name: staged.review.name, pack: staged.pack, installedAt: new Date().toISOString() });
    audit("market.install", { kind: "team", id: staged.review.id });
    return { ok: true, id: staged.review.id, name: staged.review.name };
  }

  async function teamTemplates() {
    const items = (await readInstalled()).filter((entry) => entry.kind === "team");
    return { templates: items.map((entry) => ({ id: entry.id, name: entry.name, installedAt: entry.installedAt ?? null, memberCount: (entry.pack?.members?.custom?.length ?? 0) + (entry.pack?.members?.builtinRefs?.length ?? 0) })) };
  }

  async function teamPack({ id: packId } = {}) {
    const clean = String(packId ?? "").trim();
    const item = (await readInstalled()).find((entry) => entry.kind === "team" && entry.id === clean);
    if (!item) throw marketError("MARKET_TEAM_NOT_FOUND", `team template not found: ${clean}`, 404);
    return { id: item.id, pack: item.pack };
  }

  return {
    mcpSearch,
    mcpStage,
    mcpInstall,
    teamStage,
    teamInstall,
    teamTemplates,
    teamPack,
    skillsStage,
    skillsStageFromRepo,
    skillsInstall,
    installedList,
    skillsList,
    skillsRemove,
    mcpRemove,
    mcpUpdateApps,
    skillUpdateApps,
    listRepos,
    addRepo,
    removeRepo,
    scanRepo,
    scanAllRepos,
    catalogSkills,
    assertSkillUrl,
    parseSkillFrontmatter,
    mcpConfigFromRegistry,
    parseRepoRef,
  };
}
