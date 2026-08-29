import { escapeAttr, escapeHtml } from "../utils.js";

const CLI_BRAND_ICONS = Object.freeze({
  claude: "icon-cli-claude",
  codex: "icon-cli-codex",
  grok: "icon-cli-grok",
  kimi: "icon-cli-kimi",
  pi: "icon-cli-pi",
  gemini: "icon-cli-gemini",
  opencode: "icon-cli-opencode",
});

const cache = new Map();

export const AVATAR_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
export const MAX_AVATAR_FILE_BYTES = 1024 * 1024;

export function officialCliIconMarkup(brand, className = "cli-logo") {
  const icon = CLI_BRAND_ICONS[brand];
  return icon
    ? `<svg class="${escapeAttr(`${className} cli-brand-${brand}`)}" data-cli-brand="${escapeAttr(brand)}" aria-hidden="true"><use href="#${icon}"></use></svg>`
    : "";
}

export function brandForMember(member = {}) {
  const value = `${member.provider || ""} ${member.runtimeProfileId || ""} ${member.id || ""} ${member.brand || ""}`.toLowerCase();
  if (value.includes("anthropic") || value.includes("claude")) return "claude";
  if (value.includes("openai") || value.includes("codex")) return "codex";
  if (value.includes("grok") || value.includes("xai")) return "grok";
  if (value.includes("kimi") || value.includes("moonshot")) return "kimi";
  if (value.includes("gemini") || value.includes("google")) return "gemini";
  if (value.includes("opencode")) return "opencode";
  if (value.includes("pi")) return "pi";
  return member.brand && CLI_BRAND_ICONS[member.brand] ? member.brand : "";
}

export function avatarCacheKey(owner, id) {
  return `${owner}:${id}`;
}

export function cachedAvatarUrl(owner, id) {
  return cache.get(avatarCacheKey(owner, id))?.url || "";
}

export function forgetAvatar(owner, id) {
  const key = avatarCacheKey(owner, id);
  const previous = cache.get(key);
  if (previous?.url) URL.revokeObjectURL(previous.url);
  cache.delete(key);
}

export function photoMarkup(url, className = "avatar-photo") {
  return `<img class="${className}" src="${escapeAttr(url)}" alt="" />`;
}

export function memberAvatarMarkup(member, {
  className = "avatar-photo",
  iconClass = "cli-logo",
  fallback = "",
} = {}) {
  if (member?.avatar === "custom") {
    const url = cachedAvatarUrl("member", member.id);
    if (url) return photoMarkup(url, className);
  }
  const brand = brandForMember(member);
  return officialCliIconMarkup(brand, iconClass) || fallback;
}

export function memberInitials(member = {}, extra = "") {
  const text = String(member.shortLabel || member.label || extra || member.id || "").trim();
  return text.slice(0, 2) || "·";
}

export function memberFaceMarkup(member, {
  className = "avatar-photo",
  iconClass = "cli-logo",
  fallback = "",
  initialsClass = "avatar-initials",
} = {}) {
  const face = memberAvatarMarkup(member, { className, iconClass, fallback });
  if (face) return face;
  return `<span class="${escapeAttr(initialsClass)}">${escapeHtml(memberInitials(member))}</span>`;
}

export function operatorAvatarMarkup({
  profile,
  className = "avatar-photo",
  fallback = "",
} = {}) {
  if (profile?.avatar === "custom") {
    const url = cachedAvatarUrl("operator", "self");
    if (url) return photoMarkup(url, className);
  }
  return fallback;
}

export async function fileToAvatarDataUrl(file) {
  if (!file) throw new Error("请选择一张图片");
  if (file.size > MAX_AVATAR_FILE_BYTES) throw new Error("头像不能超过 1 MB");
  if (file.type && !AVATAR_ACCEPT.split(",").includes(file.type)) {
    throw new Error("只支持 PNG / JPEG / GIF / WebP");
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
  if (!dataUrl.startsWith("data:image/")) throw new Error("只支持图片文件");
  return dataUrl;
}

export async function hydrateAvatar(requestBlob, owner, id) {
  const path = owner === "operator"
    ? "/api/avatars/operator"
    : `/api/avatars/members/${encodeURIComponent(id)}`;
  const blob = await requestBlob(path);
  const url = URL.createObjectURL(blob);
  forgetAvatar(owner, id);
  cache.set(avatarCacheKey(owner, id), { url });
  return url;
}

export async function hydrateAvatarCatalog(requestBlob, { members = [], operatorProfile = null } = {}) {
  const tasks = [];
  if (operatorProfile?.avatar === "custom") {
    tasks.push(hydrateAvatar(requestBlob, "operator", "self").catch(() => {
      forgetAvatar("operator", "self");
      return null;
    }));
  } else {
    forgetAvatar("operator", "self");
  }
  const keep = new Set();
  for (const member of members) {
    if (member?.avatar === "custom" && member.id) {
      keep.add(member.id);
      tasks.push(hydrateAvatar(requestBlob, "member", member.id).catch(() => {
        forgetAvatar("member", member.id);
        return null;
      }));
    }
  }
  for (const key of [...cache.keys()]) {
    if (!key.startsWith("member:")) continue;
    const id = key.slice("member:".length);
    if (!keep.has(id)) forgetAvatar("member", id);
  }
  await Promise.all(tasks);
}
