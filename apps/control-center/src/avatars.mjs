import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { detectClipboardImageType } from "./clipboard-attachment.mjs";

export const MAX_AVATAR_BYTES = 1024 * 1024;
export const MAX_AVATAR_REQUEST_BYTES = Math.ceil(MAX_AVATAR_BYTES / 3) * 4 + 4096;
// 团队背景（dsh-wallpaper-engine 式）：静态图 ~8MB；视频壁纸放宽到 64MB（本机单用户
// 控制面，且前端在最小化/失焦时暂停解码，常驻成本受控）。
export const MAX_TEAM_BACKGROUND_BYTES = 8 * 1024 * 1024;
export const MAX_TEAM_BACKGROUND_VIDEO_BYTES = 64 * 1024 * 1024;
export const MAX_TEAM_BACKGROUND_REQUEST_BYTES = Math.ceil(MAX_TEAM_BACKGROUND_VIDEO_BYTES / 3) * 4 + 4096;
export const OPERATOR_DEFAULT_LABEL = "AEMEATH";

const STORE_VERSION = 1;
const HIDDEN_MEMBER_MAX = 512;
const MEMBER_ID_MAX = 128;
const PRIVATE_SKILL_MAX = 64;
const PRIVATE_SKILL_ID_MAX = 64;
const PRIVATE_SKILL_NAME_MAX = 80;
const PRIVATE_SKILL_DESCRIPTION_MAX = 200;
const PRIVATE_SKILL_INSTRUCTIONS_MAX = 4000;
const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const IMAGE_EXT = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
});
const EXT_MIME = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
});

/** 团队背景媒体类型判定：图片走既有魔数表；视频按容器魔数（mp4=ftyp box / webm=EBML）。
    返回 null 表示既不是可接受图片也不是可接受视频。 */
function detectBackgroundMediaKind(mimeType, bytes) {
  if (IMAGE_EXT[mimeType]) return "image";
  if (mimeType === "video/mp4") {
    return bytes.length > 8 && bytes.subarray(4, 8).toString("latin1") === "ftyp" ? "video" : null;
  }
  if (mimeType === "video/webm") {
    return bytes.length > 4 && bytes[0] === 0x1a && bytes[1] === 0x45
      && bytes[2] === 0xdf && bytes[3] === 0xa3 ? "video" : null;
  }
  return null;
}

function fail(message, code = "VALIDATION_FAILED") {
  throw Object.assign(new Error(message), { code });
}

function parseImageDataUrl(dataUrl, maxBytes) {
  if (typeof dataUrl !== "string") fail("image dataUrl is required", "INVALID_IMAGE_DATA");
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(dataUrl);
  if (!match) fail("image must be a base64 data URL", "INVALID_IMAGE_DATA");
  const declaredType = match[1].toLowerCase();
  if (!IMAGE_EXT[declaredType]) fail(`unsupported image type: ${declaredType}`, "UNSUPPORTED_IMAGE_TYPE");
  const encoded = match[2];
  if (!encoded || encoded.length % 4 !== 0) fail("image base64 is malformed", "INVALID_IMAGE_DATA");
  if (encoded.length > Math.ceil(maxBytes / 3) * 4) {
    fail(`image exceeds ${maxBytes} bytes`, "IMAGE_TOO_LARGE");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) fail("image base64 is malformed", "INVALID_IMAGE_DATA");
  if (!bytes.length) fail("image is empty", "INVALID_IMAGE_DATA");
  if (bytes.length > maxBytes) fail(`image exceeds ${maxBytes} bytes`, "IMAGE_TOO_LARGE");
  const detected = detectClipboardImageType(bytes);
  if (!detected) fail("image bytes are not a valid image", "INVALID_IMAGE_DATA");
  if (detected !== declaredType) fail("image MIME type does not match file bytes", "IMAGE_TYPE_MISMATCH");
  return { mimeType: detected, bytes };
}

function parseAvatarDataUrl(dataUrl) {
  return parseImageDataUrl(dataUrl, MAX_AVATAR_BYTES);
}

/** 团队背景专用：接受图片（沿用图片魔数表）与视频（mp4=ftyp box / webm=EBML 容器魔数），
    各自独立体积档。返回 { mimeType, bytes, mediaKind }。 */
function parseTeamBackgroundDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") fail("background dataUrl is required", "INVALID_IMAGE_DATA");
  const match = /^data:((?:image|video)\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(dataUrl);
  if (!match) fail("background must be a base64 data URL (image/* or video/*)", "INVALID_IMAGE_DATA");
  const declaredType = match[1].toLowerCase();
  const maxBytes = declaredType.startsWith("video/") ? MAX_TEAM_BACKGROUND_VIDEO_BYTES : MAX_TEAM_BACKGROUND_BYTES;
  // 初筛只认 MIME 白名单（mp4/webm 视频容器 + 既有图片表）；字节级真伪由末尾
  // detectBackgroundMediaKind 终验（ftyp / EBML / 图片魔数），空 buffer 预检探不出视频头。
  const VIDEO_MIME = new Set(["video/mp4", "video/webm"]);
  if (!IMAGE_EXT[declaredType] && !VIDEO_MIME.has(declaredType)) {
    fail(`unsupported background type: ${declaredType}`, "UNSUPPORTED_IMAGE_TYPE");
  }
  const encoded = match[2];
  if (!encoded || encoded.length % 4 !== 0) fail("background base64 is malformed", "INVALID_IMAGE_DATA");
  if (encoded.length > Math.ceil(maxBytes / 3) * 4) {
    fail(declaredType.startsWith("video/")
      ? `background video exceeds ${maxBytes} bytes`
      : `background image exceeds ${maxBytes} bytes`, "IMAGE_TOO_LARGE");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) fail("background base64 is malformed", "INVALID_IMAGE_DATA");
  if (!bytes.length) fail("background is empty", "INVALID_IMAGE_DATA");
  if (bytes.length > maxBytes) {
    fail(declaredType.startsWith("video/")
      ? `background video exceeds ${maxBytes} bytes`
      : `background image exceeds ${maxBytes} bytes`, "IMAGE_TOO_LARGE");
  }
  const kind = detectBackgroundMediaKind(declaredType, bytes);
  if (!kind || (kind === "image" && !detectClipboardImageType(bytes))) {
    fail("background bytes do not match the declared media type", "INVALID_IMAGE_DATA");
  }
  return { mimeType: declaredType, bytes, mediaKind: kind };
}

function safeFileStem(id) {
  const stem = String(id ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  if (!stem || stem === "." || stem === "..") fail("avatar owner id is invalid", "VALIDATION_FAILED");
  return stem;
}

function cleanHiddenMemberIds(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail("hiddenMemberIds must be an array", "VALIDATION_FAILED");
  if (value.length > HIDDEN_MEMBER_MAX) fail(`hiddenMemberIds exceeds ${HIDDEN_MEMBER_MAX} entries`, "VALIDATION_FAILED");
  const ids = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== "string") fail("hiddenMemberIds entries must be strings", "VALIDATION_FAILED");
    const id = raw.trim();
    if (!id || id.length > MEMBER_ID_MAX || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
      fail("hiddenMemberIds contains an invalid member id", "VALIDATION_FAILED");
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function cleanPrivateSkillText(value, label, max) {
  if (typeof value !== "string") fail(`${label} must be a string`, "VALIDATION_FAILED");
  const text = value.trim();
  if (!text) fail(`${label} is required`, "VALIDATION_FAILED");
  if (text.length > max) fail(`${label} exceeds ${max} characters`, "VALIDATION_FAILED");
  return text;
}

function cleanPrivateSkills(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail("skills must be an array", "VALIDATION_FAILED");
  if (value.length > PRIVATE_SKILL_MAX) fail(`skills exceeds ${PRIVATE_SKILL_MAX} entries`, "VALIDATION_FAILED");
  const skills = [];
  const seen = new Set();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      fail("skills entries must be objects", "VALIDATION_FAILED");
    }
    for (const key of Object.keys(raw)) {
      if (PROTOTYPE_KEYS.has(key)) fail("skills contains a forbidden key", "VALIDATION_FAILED");
    }
    const name = cleanPrivateSkillText(raw.name, "skill name", PRIVATE_SKILL_NAME_MAX);
    const description = cleanPrivateSkillText(raw.description, "skill description", PRIVATE_SKILL_DESCRIPTION_MAX);
    const instructions = cleanPrivateSkillText(raw.instructions, "skill instructions", PRIVATE_SKILL_INSTRUCTIONS_MAX);
    let id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) id = randomUUID();
    if (id.length > PRIVATE_SKILL_ID_MAX || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      fail("skills contains an invalid id", "VALIDATION_FAILED");
    }
    if (seen.has(id)) fail("skills contains a duplicate id", "VALIDATION_FAILED");
    seen.add(id);
    skills.push({ id, name, description, instructions });
  }
  return skills;
}

function readPrivateSkills(value) {
  if (value === undefined || value === null) return [];
  try {
    return cleanPrivateSkills(value) ?? [];
  } catch {
    return [];
  }
}

async function writeAtomicBytes(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temp, 0o600).catch(() => {});
    await rename(temp, path);
    renamed = true;
  } finally {
    if (!renamed) await rm(temp, { force: true });
  }
}

async function writeAtomicJson(path, value) {
  await writeAtomicBytes(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

export function createAvatarStore({ dataRoot, teamMembers } = {}) {
  if (typeof dataRoot !== "string" || !dataRoot.trim()) fail("dataRoot is required", "VALIDATION_FAILED");
  if (!teamMembers || typeof teamMembers.get !== "function" || typeof teamMembers.setAvatar !== "function") {
    fail("teamMembers store is required", "VALIDATION_FAILED");
  }
  const root = resolve(dataRoot);
  const avatarDir = join(root, "uploads", "avatars");
  const operatorPath = join(root, "operator-profile.json");

  function memberPrefix(memberId) {
    return `member--${safeFileStem(memberId)}`;
  }

  async function listFiles(prefix) {
    let names;
    try {
      names = await readdir(avatarDir);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    return names.filter((name) => {
      const dot = name.lastIndexOf(".");
      if (dot <= 0) return false;
      const stem = name.slice(0, dot);
      const ext = name.slice(dot + 1).toLowerCase();
      return stem === prefix && Object.hasOwn(EXT_MIME, ext);
    });
  }

  async function removeFiles(prefix) {
    const names = await listFiles(prefix);
    await Promise.all(names.map((name) => rm(join(avatarDir, name), { force: true })));
  }

  // maxBytes 是读取侧上限：头像恒 1MB；团队背景走写入侧同一预算（视频 64MB/图 8MB），
  // 否则合法落盘的壁纸会被头像级上限误判成不存在（存量 bug：>1MB 壁纸 GET 恒 404）。
  async function readFileRecord(prefix, maxBytes = MAX_AVATAR_BYTES) {
    const names = await listFiles(prefix);
    if (!names.length) return null;
    const name = names.sort().at(-1);
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    const bytes = await readFile(join(avatarDir, name));
    if (!bytes.length || bytes.length > maxBytes) return null;
    const mimeType = detectClipboardImageType(bytes) || EXT_MIME[ext];
    if (!mimeType) return null;
    return { bytes, mimeType, fileName: name };
  }

  async function saveFile(prefix, dataUrl) {
    const { mimeType, bytes } = parseAvatarDataUrl(dataUrl);
    const path = join(avatarDir, `${prefix}.${IMAGE_EXT[mimeType]}`);
    await removeFiles(prefix);
    await writeAtomicBytes(path, bytes);
    return { mimeType, bytes: bytes.length };
  }

  async function readOperatorRecord() {
    try {
      const parsed = JSON.parse(await readFile(operatorPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaultOperator();
      const label = typeof parsed.label === "string" && parsed.label.trim()
        ? parsed.label.trim().slice(0, 48)
        : OPERATOR_DEFAULT_LABEL;
      return {
        label,
        avatar: parsed.avatar === "custom" ? "custom" : "",
        hiddenMemberIds: cleanHiddenMemberIds(parsed.hiddenMemberIds ?? []),
        skills: readPrivateSkills(parsed.skills),
      };
    } catch (error) {
      if (error?.code === "ENOENT") return defaultOperator();
      fail("operator profile is unreadable", "OPERATOR_PROFILE_UNREADABLE");
    }
  }

  function defaultOperator() {
    return { label: OPERATOR_DEFAULT_LABEL, avatar: "", hiddenMemberIds: [], skills: [] };
  }

  async function writeOperatorRecord(record) {
    await writeAtomicJson(operatorPath, {
      version: STORE_VERSION,
      label: record.label,
      avatar: record.avatar === "custom" ? "custom" : "",
      hiddenMemberIds: cleanHiddenMemberIds(record.hiddenMemberIds ?? []),
      skills: cleanPrivateSkills(record.skills ?? []) ?? [],
    });
    return readOperatorRecord();
  }

  return {
    async init() {
      await mkdir(avatarDir, { recursive: true, mode: 0o700 });
      return this;
    },

    async operatorProfile() {
      const record = await readOperatorRecord();
      if (record.avatar === "custom" && !(await readFileRecord("operator"))) {
        return { ...record, avatar: "" };
      }
      return record;
    },

    async setOperatorProfile(input = {}) {
      const current = await readOperatorRecord();
      const label = Object.hasOwn(input, "label")
        ? (typeof input.label === "string" ? input.label.trim().slice(0, 48) : "")
        : current.label;
      if (!label) fail("operator label is required", "VALIDATION_FAILED");
      const hiddenMemberIds = Object.hasOwn(input, "hiddenMemberIds")
        ? cleanHiddenMemberIds(input.hiddenMemberIds)
        : current.hiddenMemberIds;
      const skills = Object.hasOwn(input, "skills")
        ? cleanPrivateSkills(input.skills)
        : current.skills;
      return writeOperatorRecord({ ...current, label, hiddenMemberIds, skills });
    },

    async setOperatorAvatar(dataUrl) {
      await saveFile("operator", dataUrl);
      const current = await readOperatorRecord();
      return writeOperatorRecord({ ...current, avatar: "custom" });
    },

    async clearOperatorAvatar() {
      const current = await readOperatorRecord();
      const next = await writeOperatorRecord({ ...current, avatar: "" });
      await removeFiles("operator");
      return next;
    },

    async setMemberAvatar(memberId, dataUrl) {
      const member = teamMembers.get(memberId);
      await saveFile(memberPrefix(member.id), dataUrl);
      try {
        return await teamMembers.setAvatar(member.id, "custom");
      } catch (error) {
        await removeFiles(memberPrefix(member.id));
        throw error;
      }
    },

    async clearMemberAvatar(memberId) {
      const member = teamMembers.get(memberId);
      const updated = await teamMembers.setAvatar(member.id, "");
      await removeFiles(memberPrefix(member.id));
      return updated;
    },

    async removeMemberFile(memberId) {
      await removeFiles(memberPrefix(memberId));
    },

    async readOperatorFile() {
      const file = await readFileRecord("operator");
      if (!file) fail("operator avatar not found", "AVATAR_NOT_FOUND");
      return file;
    },

    async readMemberFile(memberId) {
      const member = teamMembers.get(memberId);
      const file = await readFileRecord(memberPrefix(member.id));
      if (!file) fail("member avatar not found", "AVATAR_NOT_FOUND");
      return file;
    },

    // ---- 团队背景 ----
    // 与头像同一套原子写/魔数校验，但放宽到背景图体积；文件名前缀即团队 id。
    async setTeamBackground(teamId, dataUrl) {
      const stem = safeFileStem(teamId);
      const { mimeType, bytes, mediaKind } = parseTeamBackgroundDataUrl(dataUrl);
      const ext = IMAGE_EXT[mimeType] || (mediaKind === "video" ? mimeType.replace("video/", "") : "png");
      const path = join(avatarDir, `teambg--${stem}.${ext}`);
      await removeFiles(`teambg--${stem}`);
      try {
        await writeAtomicBytes(path, bytes);
      } catch (error) {
        await removeFiles(`teambg--${stem}`);
        throw error;
      }
      return { mimeType, mediaKind, bytes: bytes.length };
    },

    async clearTeamBackground(teamId) {
      await removeFiles(`teambg--${safeFileStem(teamId)}`);
    },

    async readTeamBackgroundFile(teamId) {
      // 读取上限与写入侧对齐（视频 64MB）：壁纸不是头像，不能被 1MB 头像上限拦截。
      const file = await readFileRecord(`teambg--${safeFileStem(teamId)}`, MAX_TEAM_BACKGROUND_VIDEO_BYTES);
      if (!file) fail("team background not found", "BACKGROUND_NOT_FOUND");
      return file;
    },

    async hasTeamBackground(teamId) {
      return (await listFiles(`teambg--${safeFileStem(teamId)}`)).length > 0;
    },
  };
}
