// 514cc 团队体系：会话级能力配比预设——成员（模型 profile 白名单）、团队提示词、skill/MCP 声明。
// 内置 514cc 团队硬编码在此（builtin：不落盘、update/remove 一律 FROZEN_BLOCK——
// "默认团队不能更改"的最硬保证是代码常量，而非数据标记）；自定义团队落 dataRoot/teams.json 原子写。
// skills/mcp 是声明性配置：注入主脑规划提示词供派工参考，控制面本身不代理 skill/MCP 执行。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { findSecretCandidates } from "./redaction.mjs";
import { PROVIDER_APPS } from "./providers.mjs";
import { ADAPTER_BINDINGS } from "./adapters/manifest.mjs";

const NAME_MAX = 60;
const TEXT_MAX = 4000;
const LIST_MAX = 40;
const ITEM_MAX = 80;

// 团队背景预设（纯 CSS 渐变，前端 styles.css 定义同名渐变类）。图片走
// /api/team-backgrounds 上传管线，这里只管落盘字段的白名单校验。
export const TEAM_BACKGROUND_PRESETS = Object.freeze(["none", "aurora", "ember", "tide", "moss", "noir"]);

// 动效档位（dsh-wallpaper-engine 式分级 → 工作台化）：off 保帧率；subtle 单层缓流；
// rich 叠光尘。前端渲染以 data-team-motion 驱动 CSS，prefers-reduced-motion 一律回落 off。
export const TEAM_MOTION_LEVELS = Object.freeze(["off", "subtle", "rich"]);

// 视频壁纸播放控制（对标 dsh-wallpaper-engine：倍速走原生 playbackRate 即时生效不重载，
// 翻转走 CSS scaleX(-1) 零主线程开销）。rate 白名单制——非法值回落 1 而不是拒绝；
// flipped/paused 布尔。缺失字段 = 默认值，视觉零回归。
export const TEAM_BG_PLAYBACK_RATES = Object.freeze([0.5, 1, 1.5, 2]);
const DEFAULT_BACKGROUND_PLAYBACK = Object.freeze({ rate: 1, flipped: false, paused: false });

// 融合调节（对齐参考项目的融合滑杆精神：blur/brightness/contrast/saturation/dim 五轴，
// 值域即 clamp 边界；超出边界的持久化输入被夹回而不是拒绝——滑杆语义要宽容）。
export const TEAM_BACKGROUND_FILTER_BOUNDS = Object.freeze({
  blur: [0, 24],
  brightness: [0.5, 1.5],
  contrast: [0.5, 1.5],
  saturation: [0, 2],
  dim: [0, 0.85],
});

const DEFAULT_BACKGROUND_FILTER = Object.freeze({ blur: 0, brightness: 1, contrast: 1, saturation: 1, dim: 0 });

function cleanFilterValue(key, raw) {
  const [min, max] = TEAM_BACKGROUND_FILTER_BOUNDS[key];
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return DEFAULT_BACKGROUND_FILTER[key];
  const clamped = Math.min(max, Math.max(min, numeric));
  // 固定精度防浮点尾巴写脏 teams.json（0.30000000000000004 这类）
  return Math.round(clamped * 100) / 100;
}

// 仅作旧调用方的默认目录；真实运行目录由 adapter manifest + 当前 models profile 共同生成。
export const COORDINATOR_ELIGIBLE = Object.freeze(
  ADAPTER_BINDINGS
    .filter((binding) => !binding.fallbackFor && binding.coordinatorEligible === true)
    .map((binding) => binding.profileId),
);
export const DEFAULT_COORDINATOR = "claude-fable";

export const BUILTIN_TEAM = Object.freeze({
  id: "team-514cc",
  name: "514cc",
  builtin: true,
  description: "514cc 默认协作团队：Claude 主脑统一规划，Codex 技术执行，Grok 情报与快执行，Kimi 前端工程，Pi 扩展。",
  systemPrompt:
    "遵循 514cc 宪法：主脑规划-专家执行-独立验证三角；先读后写；危险操作二次确认；严禁 silent fallback；完成结论必须踩在验证证据上。",
  coordinator: DEFAULT_COORDINATOR,
  members: Object.freeze(["claude-fable", "codex-technical", "grok-search", "grok-build", "kimi-frontend", "pi-resident"]),
  skills: Object.freeze(["co-review", "co-research", "co-status", "co-enhance", "vibe", "ssh", "docx"]),
  mcp: Object.freeze(["codex-agent", "serena", "playwright", "exa", "grok-search-rs", "context7", "sequential-thinking"]),
  appearance: Object.freeze({ background: Object.freeze({ preset: "none", image: "" }) }),
});

function cleanBackground(value) {
  if (value == null) {
    return {
      background: { preset: "none", image: "" },
      motion: "off",
      filter: { ...DEFAULT_BACKGROUND_FILTER },
      playback: { ...DEFAULT_BACKGROUND_PLAYBACK },
    };
  }

  const raw = value.background ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) fail("appearance.background must be an object", "VALIDATION_FAILED");
  const presetRaw = String(raw.preset ?? "").trim().toLowerCase();
  if (presetRaw.length > ITEM_MAX) fail("background preset exceeds limit", "VALIDATION_FAILED");
  if (presetRaw && !TEAM_BACKGROUND_PRESETS.includes(presetRaw)) {
    fail(`unknown background preset: ${presetRaw} (allowed: ${TEAM_BACKGROUND_PRESETS.join("/")})`, "VALIDATION_FAILED");
  }
  // image 只是"该团队在 uploads/team-backgrounds 有自定义图"的标记位；真实字节只经
  // /api/team-backgrounds 上传管线写入，API 层不接受任意文件引用。
  const image = String(raw.image ?? "").trim();
  if (image && image !== "custom") fail('background image marker must be "" or "custom"', "VALIDATION_FAILED");

  // 动效档位：白名单校验；历史记录/手改数据里未知值回落 off，不构成拒绝载入的理由。
  const motionRaw = String(value.motion ?? "").trim().toLowerCase();
  const motion = TEAM_MOTION_LEVELS.includes(motionRaw) ? motionRaw : "off";

  // 融合调节：未知键忽略、值域夹紧（宽容语义——滑杆产物不该把整条团队配置打红）。
  const filterRaw = value.filter ?? {};
  const filter = { ...DEFAULT_BACKGROUND_FILTER };
  if (filterRaw && typeof filterRaw === "object" && !Array.isArray(filterRaw)) {
    for (const key of Object.keys(DEFAULT_BACKGROUND_FILTER)) {
      if (Object.hasOwn(filterRaw, key)) filter[key] = cleanFilterValue(key, filterRaw[key]);
    }
  }

  // 播放控制：宽容校验——rate 白名单外回落 1，布尔字段强转；未知键忽略。
  const playbackRaw = value.playback ?? {};
  const playback = { ...DEFAULT_BACKGROUND_PLAYBACK };
  if (playbackRaw && typeof playbackRaw === "object" && !Array.isArray(playbackRaw)) {
    if (TEAM_BG_PLAYBACK_RATES.includes(Number(playbackRaw.rate))) playback.rate = Number(playbackRaw.rate);
    if (typeof playbackRaw.flipped === "boolean") playback.flipped = playbackRaw.flipped;
    if (typeof playbackRaw.paused === "boolean") playback.paused = playbackRaw.paused;
  }

  return {
    background: { preset: presetRaw || "none", image: image === "custom" ? "custom" : "" },
    motion,
    filter,
    playback,
  };
}

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function catalogFail(message) {
  throw Object.assign(new Error(message), { code: "VALIDATION_FAILED", catalogConflict: true });
}

function cleanText(value, label, max) {
  const text = String(value ?? "").trim();
  if (text.length > max) fail(`${label} exceeds ${max} characters`, "VALIDATION_FAILED");
  return text;
}

function cleanList(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(`${label} must be an array`, "VALIDATION_FAILED");
  if (value.length > LIST_MAX) fail(`${label} exceeds ${LIST_MAX} entries`, "VALIDATION_FAILED");
  const items = value.map((item) => String(item ?? "").trim()).filter(Boolean);
  for (const item of items) {
    if (item.length > ITEM_MAX) fail(`${label} entry exceeds ${ITEM_MAX} characters`, "VALIDATION_FAILED");
    if (findSecretCandidates(item).length) fail(`${label} entry contains secret-like material`, "VALIDATION_FAILED"); // 进 brief 的都过闸（烛 R12）
  }
  return [...new Set(items)];
}

function rawMemberReferences(value) {
  if (!Array.isArray(value?.members)) return [];
  return [...new Set(value.members
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
}

// 供应商绑定（cc-switch 迁移波）：八应用 providerId——键白名单严格校验（拼写错即报），
// id 存在性不在此硬校验（跨 Store 引用；绑了已删供应商时 apply-team 逐 app 如实报 SOURCE_NOT_FOUND，UI 显示失效）。
function cleanProviders(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) fail("providers must be an object", "VALIDATION_FAILED");
  const out = {};
  for (const [app, raw] of Object.entries(value)) {
    if (!PROVIDER_APPS.includes(app)) fail(`providers key must be one of ${PROVIDER_APPS.join("/")}: ${app}`, "VALIDATION_FAILED");
    const id = String(raw ?? "").trim();
    if (!id) continue;
    if (id.length > ITEM_MAX) fail(`providers.${app} exceeds ${ITEM_MAX} characters`, "VALIDATION_FAILED");
    out[app] = id;
  }
  return out;
}

export class TeamStore {
  /** 目录函数在每次校验时求值，确保 models 热重载后成员和主脑资格立即同步。 */
  constructor({
    dataRoot,
    teamCatalog = null,
    knownProviders = () => [],
    knownCoordinators = () => COORDINATOR_ELIGIBLE,
  }) {
    this.path = join(dataRoot, "teams.json");
    this.dataRoot = dataRoot;
    this.teamCatalog = teamCatalog || (() => {
      const coordinators = new Set(knownCoordinators());
      return knownProviders().map((id) => ({
        id,
        teamMemberEligible: true,
        coordinatorEligible: coordinators.has(id),
      }));
    });
    this.custom = new Map();
    this.rejectedOnLoad = [];
    this.catalogRejectedOnLoad = [];
    this.#retainedRejectedRecords = [];
    this.storeStatus = { state: "ready", failClosed: false, code: null, message: null, causeCode: null };
    this.pendingCatalog = null;
    this.#queue = Promise.resolve();
  }

  #queue;
  #retainedRejectedRecords;

  #assertWritable() {
    if (!this.storeStatus.failClosed) return;
    throw Object.assign(
      new Error(this.storeStatus.message || "team store is unavailable"),
      { code: "TEAM_STORE_UNAVAILABLE", storeStatus: { ...this.storeStatus } },
    );
  }

  #effectiveCatalog() {
    const current = Array.isArray(this.teamCatalog()) ? this.teamCatalog() : [];
    if (!Array.isArray(this.pendingCatalog)) return current;
    const pendingById = new Map(this.pendingCatalog.map((item) => [String(item?.id ?? ""), item]));
    return current.map((item) => {
      const pending = pendingById.get(String(item?.id ?? ""));
      return {
        ...item,
        teamMemberEligible: item?.teamMemberEligible === true && pending?.teamMemberEligible === true,
        coordinatorEligible: item?.coordinatorEligible === true && pending?.coordinatorEligible === true,
      };
    });
  }

  #catalogSets(catalog = undefined) {
    const members = new Set();
    const coordinators = new Set();
    const source = catalog === undefined ? this.#effectiveCatalog() : catalog;
    for (const item of Array.isArray(source) ? source : []) {
      const id = String(item?.id ?? "").trim();
      if (!id || item.teamMemberEligible !== true) continue;
      members.add(id);
      if (item.coordinatorEligible === true) coordinators.add(id);
    }
    return { members, coordinators };
  }

  /** CRUD 串行化：原子写只保证单次落盘完整，不保证并发次序——排队防旧快照乱序覆盖（烛 R10 致命3）。 */
  #serialize(task) {
    const next = this.#queue.then(task, task);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async beginCatalogTransition(catalogOrFactory, { unreferencedMemberId = null } = {}) {
    let releaseGate;
    let released = false;
    const previous = this.#queue;
    const gate = new Promise((resolveGate) => { releaseGate = resolveGate; });
    const reservation = previous.catch(() => {}).then(() => gate);
    this.#queue = reservation.then(
      () => undefined,
      () => undefined,
    );
    await previous.catch(() => {});
    const previousPendingCatalog = this.pendingCatalog;
    const guardedMemberId = unreferencedMemberId == null
      ? null
      : String(unreferencedMemberId).trim();
    try {
      if (unreferencedMemberId != null && !guardedMemberId) {
        fail("member id is required for a guarded catalog transition", "VALIDATION_FAILED");
      }
      if (guardedMemberId) {
        const references = this.referencesForMember(guardedMemberId);
        if (references.length) {
          throw Object.assign(
            new Error(`team member is referenced and cannot be deleted or rebound: ${guardedMemberId}`),
            { code: "MEMBER_IN_USE", memberId: guardedMemberId, references },
          );
        }
      }
      const catalog = typeof catalogOrFactory === "function"
        ? await catalogOrFactory()
        : catalogOrFactory;
      this.assertCatalogCompatible(catalog);
      this.pendingCatalog = catalog;
    } catch (error) {
      releaseGate();
      throw error;
    }
    return {
      referenceGuardedMemberId: guardedMemberId,
      release: async ({ committed = false, activation = null } = {}) => {
        if (released) return;
        released = true;
        if (!committed) this.pendingCatalog = previousPendingCatalog;
        else if (activation?.status === "reloaded") this.pendingCatalog = null;
        releaseGate();
      },
    };
  }

  async init() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.teams)) {
        throw Object.assign(new Error("teams.json must contain a teams array"), { code: "TEAM_STORE_INVALID" });
      }
      const diskTeams = parsed.teams;
      const seenTeamIds = new Set();
      for (const team of diskTeams) {
        if (!team || typeof team !== "object" || Array.isArray(team)) continue;
        const id = String(team.id ?? "").trim();
        if (!id || id === BUILTIN_TEAM.id) continue;
        if (seenTeamIds.has(id)) {
          throw Object.assign(new Error(`teams.json contains a duplicate team id: ${id}`), { code: "TEAM_STORE_INVALID" });
        }
        seenTeamIds.add(id);
      }
      for (const [index, team] of diskTeams.entries()) {
        if (!team || typeof team !== "object" || Array.isArray(team) || team.id === BUILTIN_TEAM.id) continue;
        const rejectedId = String(team.id ?? "").trim() || `rejected-team-${index + 1}`;
        if (!team.id) {
          this.#retainedRejectedRecords.push(team);
          this.rejectedOnLoad.push({
            id: rejectedId,
            name: String(team.name ?? rejectedId),
            reason: "team id is required",
            members: rawMemberReferences(team),
          });
          continue;
        }
        try {
          // 磁盘记录与 API 输入同一校验闸——手工注入 members:[] 等畸形记录拒载（烛 R10 致命1）
          const fields = this.#validate(team);
          this.custom.set(team.id, { ...team, ...fields, builtin: false });
        } catch (error) {
          this.#retainedRejectedRecords.push(team);
          const rejected = {
            id: rejectedId,
            name: String(team.name ?? rejectedId),
            reason: error.message,
            members: rawMemberReferences(team),
          };
          this.rejectedOnLoad.push(rejected);
          if (error.catalogConflict) this.catalogRejectedOnLoad.push(rejected);
        }
      }
      this.storeStatus = { state: "ready", failClosed: false, code: null, message: null, causeCode: null };
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.storeStatus = { state: "missing", failClosed: false, code: null, message: null, causeCode: "ENOENT" };
      } else {
        const code = error instanceof SyntaxError ? "TEAM_STORE_INVALID" : (error?.code || "TEAM_STORE_UNREADABLE");
        this.storeStatus = {
          state: "blocked",
          failClosed: true,
          code,
          message: `团队存储不可验证：${error.message}`,
          causeCode: error?.code ?? null,
        };
      }
    }
    return this;
  }

  /** 失败原子性（烛 R11 建议）：构造 next Map → 落盘 → 才提交内存；写盘失败时内存不变，API 报错与状态一致。 */
  async #commit(next) {
    this.#assertWritable();
    await mkdir(this.dataRoot, { recursive: true });
    const temp = join(this.dataRoot, `.teams.${randomUUID()}.tmp`);
    // 拒载记录不进入运行图，但必须原样留在真源中。否则一次无关 CRUD 就会抹掉其成员引用，
    // 重启后成员删除/换绑保护会失明。原始记录只在磁盘回写，不通过 rejectedOnLoad API 暴露。
    const persistedTeams = [...next.values(), ...this.#retainedRejectedRecords];
    await writeFile(temp, `${JSON.stringify({ teams: persistedTeams }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.path);
    this.custom = next;
    this.storeStatus = { state: "ready", failClosed: false, code: null, message: null, causeCode: null };
  }

  #validate(input, catalog = undefined) {
    const name = cleanText(input.name, "team name", NAME_MAX);
    if (!name) fail("team name is required", "VALIDATION_FAILED");
    // 保留名：自定义团队冒名 "514cc" 会让审计上无法区分冻结内置与任意提示词团队（烛 R10 致命4）。
    // NFKC 折叠全角同形（５１４ｃｃ 等，烛 R11 建议）
    if (name.normalize("NFKC").toLowerCase().replace(/\s+/g, "") === BUILTIN_TEAM.name.toLowerCase()) {
      fail(`"${BUILTIN_TEAM.name}" is a reserved team name`, "VALIDATION_FAILED");
    }
    for (const field of [name, String(input.description ?? ""), String(input.systemPrompt ?? "")]) {
      if (findSecretCandidates(field).length) {
        fail("team configuration contains secret-like material; use credential references instead", "VALIDATION_FAILED");
      }
    }
    const members = cleanList(input.members, "members");
    if (!members.length) fail("team must include at least one member", "VALIDATION_FAILED");
    const { members: known, coordinators: eligible } = this.#catalogSets(catalog);
    for (const member of members) {
      if (!known.has(member)) catalogFail(`team member has no executable adapter binding: ${member}`);
    }
    // 自定义团队不继承内置团队的 Claude 默认：缺省时取成员顺序中的首个 CLI profile。
    // UI 要求显式选择；动态缺省仅服务旧磁盘记录和 API 兼容。
    const coordinator = cleanText(input.coordinator, "coordinator", NAME_MAX)
      || members.find((member) => eligible.has(member))
      || "";
    if (!coordinator) {
      catalogFail("team must include at least one executable member that can act as coordinator");
    }
    if (!eligible.has(coordinator)) {
      catalogFail(`coordinator must have an executable coordinator adapter (${[...eligible].join(", ")})`);
    }
    if (!members.includes(coordinator)) fail("coordinator must be a team member", "VALIDATION_FAILED");
    return {
      name,
      description: cleanText(input.description, "description", TEXT_MAX),
      systemPrompt: cleanText(input.systemPrompt, "system prompt", TEXT_MAX),
      // 团队世界观（LO 2026-08-27）：叙事性设定——成员共同身处的虚构/语义空间
      //（例："魔法世界"）。注入主脑规划轮供表达风格与协作语境对齐；不是执行指令。
      worldview: cleanText(input.worldview, "team worldview", TEXT_MAX),
      coordinator,
      members,
      skills: cleanList(input.skills, "skills"),
      mcp: cleanList(input.mcp, "mcp"),
      providers: cleanProviders(input.providers),
      appearance: cleanBackground(input.appearance),
    };
  }

  catalogConflicts(catalog = this.teamCatalog()) {
    const { members, coordinators } = this.#catalogSets(catalog);
    const conflicts = [];
    for (const team of [BUILTIN_TEAM, ...this.custom.values()]) {
      const missingMembers = (team.members ?? []).filter((id) => !members.has(id));
      const coordinator = String(team.coordinator ?? "").trim();
      const reasons = [];
      if (missingMembers.length) reasons.push(`members without executable adapters: ${missingMembers.join(", ")}`);
      if (!coordinator || !coordinators.has(coordinator)) reasons.push(`coordinator is not executable: ${coordinator || "<missing>"}`);
      if (coordinator && !(team.members ?? []).includes(coordinator)) reasons.push(`coordinator is not a member: ${coordinator}`);
      if (reasons.length) conflicts.push({ id: team.id, name: team.name, reasons });
    }
    for (const rejected of this.catalogRejectedOnLoad) {
      if (conflicts.some((item) => item.id === rejected.id)) continue;
      conflicts.push({ id: rejected.id, name: rejected.name, reasons: [rejected.reason] });
    }
    return conflicts;
  }

  assertCatalogCompatible(catalog = this.teamCatalog()) {
    const conflicts = this.catalogConflicts(catalog);
    if (!conflicts.length) return { valid: true, conflicts: [] };
    const summary = conflicts
      .map((item) => `${item.name} (${item.id}): ${item.reasons.join("; ")}`)
      .join(" | ");
    throw Object.assign(
      new Error(`team catalog update would invalidate saved teams: ${summary}`),
      { code: "TEAM_CATALOG_CONFLICT", conflicts },
    );
  }

  list() {
    return [BUILTIN_TEAM, ...[...this.custom.values()].sort((a, b) => a.name.localeCompare(b.name))];
  }

  get(id) {
    if (id === BUILTIN_TEAM.id) return BUILTIN_TEAM;
    const team = this.custom.get(id);
    if (!team) fail("team not found", "SOURCE_NOT_FOUND");
    return team;
  }

  referencesForMember(memberId) {
    if (this.storeStatus.failClosed) {
      throw Object.assign(
        new Error(this.storeStatus.message || "team references cannot be verified"),
        {
          code: "MEMBER_REFERENCE_CHECK_FAILED",
          causeCode: this.storeStatus.code,
          storeStatus: { ...this.storeStatus },
        },
      );
    }
    const id = String(memberId ?? "").trim();
    if (!id) return [];
    const references = [];
    for (const team of [BUILTIN_TEAM, ...this.custom.values()]) {
      if (Array.isArray(team.members) && team.members.includes(id)) references.push(team.id);
    }
    for (const rejected of this.rejectedOnLoad) {
      if (Array.isArray(rejected.members) && rejected.members.includes(id)) references.push(rejected.id);
    }
    return [...new Set(references)];
  }

  withMemberReferenceGuard(memberId, mutation) {
    if (typeof mutation !== "function") fail("member mutation callback is required", "VALIDATION_FAILED");
    const id = String(memberId ?? "").trim();
    if (!id) fail("member id is required", "VALIDATION_FAILED");
    return this.#serialize(async () => {
      const references = this.referencesForMember(id);
      if (references.length) {
        throw Object.assign(
          new Error(`team member is referenced and cannot be deleted or rebound: ${id}`),
          { code: "MEMBER_IN_USE", memberId: id, references },
        );
      }
      return mutation();
    });
  }

  create(input = {}) {
    return this.#serialize(async () => {
      this.#assertWritable();
      const fields = this.#validate(input);
      const now = new Date().toISOString();
      const team = { id: `team-${randomUUID()}`, builtin: false, ...fields, createdAt: now, updatedAt: now };
      const next = new Map(this.custom);
      next.set(team.id, team);
      await this.#commit(next);
      return team;
    });
  }

  materializeEphemeral(input = {}) {
    this.#assertWritable();
    const fields = this.#validate(input);
    const now = new Date().toISOString();
    return {
      id: `team-ephemeral-${randomUUID()}`,
      builtin: false,
      ephemeral: true,
      ...fields,
      createdAt: now,
      updatedAt: now,
    };
  }

  update(id, input = {}) {
    return this.#serialize(async () => {
      if (id === BUILTIN_TEAM.id) fail("the builtin 514cc team is frozen and cannot be modified", "FROZEN_BLOCK");
      this.#assertWritable();
      const existing = this.get(id);
      const fields = this.#validate({ ...existing, ...input });
      const team = { ...existing, ...fields, updatedAt: new Date().toISOString() };
      const next = new Map(this.custom);
      next.set(id, team);
      await this.#commit(next);
      return team;
    });
  }

  remove(id) {
    return this.#serialize(async () => {
      if (id === BUILTIN_TEAM.id) fail("the builtin 514cc team is frozen and cannot be deleted", "FROZEN_BLOCK");
      this.#assertWritable();
      this.get(id); // 不存在则 404
      const next = new Map(this.custom);
      next.delete(id);
      await this.#commit(next);
      return { removed: id };
    });
  }

  /** 把指定团队的 background.image 标记为 custom（上传成功后由 server 层回调）。
      磁盘记录已过校验闸，这里只改白名单内的标记位，不整单重验。 */
  async markBackgroundImage(teamId) {
    if (teamId === BUILTIN_TEAM.id) fail("the builtin 514cc team is frozen and cannot be modified", "FROZEN_BLOCK");
    return this.#serialize(async () => {
      this.#assertWritable();
      const existing = this.get(teamId);
      const appearance = {
        ...(existing.appearance ?? {}),
        background: { ...(existing.appearance?.background ?? {}), image: "custom" },
      };
      const team = { ...existing, appearance, updatedAt: new Date().toISOString() };
      const next = new Map(this.custom);
      next.set(teamId, team);
      await this.#commit(next);
      return team;
    });
  }

  /** run 归属团队的规划注入段：结构化包裹 + 明示不得覆盖平台契约（烛 R10 建议——
      团队提示词是受信配置但不与 planner 契约同层级）。 */
  brief(id) {
    return this.briefFor(this.get(id));
  }

  briefFor(team) {
    const memberById = new Map((this.teamCatalog() || []).map((member) => [member.id, member]));
    const parts = [`当前团队：${team.name}`];
    const coordinator = memberById.get(team.coordinator);
    parts.push(`团队主脑（会话入口与总协调者）：${coordinator?.label || team.coordinator || DEFAULT_COORDINATOR}（${team.coordinator || DEFAULT_COORDINATOR}）`);
    if (team.worldview) {
      // 世界观是叙事语境（角色扮演式的表达/命名/协作风格基垫），必须显式声明"不越权"：
      // 它不改变安全边界，也不得覆盖平台契约与权限模式。
      parts.push(`团队世界观（叙事语境）：${team.worldview}`);
    }
    if (team.systemPrompt) parts.push(`团队指令：${team.systemPrompt}`);
    if (team.members?.length) {
      const roster = team.members.map((memberId) => {
        const member = memberById.get(memberId);
        if (!member) return memberId;
        const details = [member.label || memberId, member.role, ...(member.capabilities || [])].filter(Boolean);
        return `${details.join(" · ")} [${memberId}]`;
      });
      parts.push(`团队成员（可派工白名单）：${roster.join("；")}`);
    }
    if (team.skills?.length) parts.push(`团队 Skill（声明，供派工参考）：${team.skills.join("、")}`);
    if (team.mcp?.length) parts.push(`团队 MCP（声明，供派工参考）：${team.mcp.join("、")}`);
    return [
      "[团队配置开始——以下为会话能力配比声明。它不覆盖平台契约：无工具假设、诚实性要求、权限模式与危险操作约束始终优先]",
      ...parts,
      "[团队配置结束]",
    ].join("\n");
  }
}
