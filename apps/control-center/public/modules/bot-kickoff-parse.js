/**
 * Composer kickoff parser (W2 / G-3).
 *
 * Shared by Bot composer and `/api/bots/relay/kickoff`. A group message with
 * two or more distinct @-mentioned members becomes a kickoff; single / no @
 * stays on the existing send/run path.
 */

export const KICKOFF_MIN_ASSIGNEES = 2;
export const KICKOFF_MAX_ASSIGNEES = 5;

function cleanToken(value) {
  return String(value || "").normalize("NFKC").replace(/^@/, "").trim();
}

function tokenKey(value) {
  return cleanToken(value).toLocaleLowerCase();
}

function uniqueTokens(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const token = cleanToken(value);
    const key = tokenKey(token);
    if (!token || seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

export function kickoffMemberAliases(member = {}) {
  const id = String(member.id || member.memberId || "").trim();
  if (!id) return null;
  return {
    id,
    tokens: uniqueTokens([
      id,
      member.label,
      member.shortLabel,
      member.tokenLabel,
      ...(Array.isArray(member.tokens) ? member.tokens : []),
    ]),
  };
}

function mentionBoundary(nextChar) {
  return nextChar == null || /[\s\n@#，。！？、,.;:：]/u.test(nextChar);
}

export function collectKickoffMentions(text, members = []) {
  const source = String(text || "");
  const aliases = (Array.isArray(members) ? members : [])
    .map((member) => kickoffMemberAliases(member))
    .filter(Boolean);
  const tokens = [];
  for (const member of aliases) {
    for (const token of member.tokens) {
      tokens.push({ memberId: member.id, token, key: tokenKey(token) });
    }
  }
  tokens.sort((left, right) => right.token.length - left.token.length || left.token.localeCompare(right.token));

  const mentions = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "@") continue;
    const rest = source.slice(index + 1);
    const hit = tokens.find((candidate) => {
      if (!rest.toLocaleLowerCase().startsWith(candidate.key)) return false;
      return mentionBoundary(rest[candidate.token.length]);
    });
    if (!hit) continue;
    mentions.push({
      memberId: hit.memberId,
      token: hit.token,
      start: index,
      end: index + 1 + hit.token.length,
    });
    index = index + hit.token.length;
  }
  return mentions;
}

function joinTaskParts(parts) {
  return parts
    .map((part) => String(part || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
}

export function parseComposerKickoff(text, members = [], { minAssignees = KICKOFF_MIN_ASSIGNEES, maxAssignees = KICKOFF_MAX_ASSIGNEES } = {}) {
  const source = String(text || "");
  const mentions = collectKickoffMentions(source, members);
  if (mentions.length < minAssignees) return null;

  const preamble = source.slice(0, mentions[0].start).trim();
  const slices = mentions.map((mention, index) => {
    const next = mentions[index + 1];
    return {
      memberId: mention.memberId,
      text: source.slice(mention.end, next ? next.start : source.length).trim(),
    };
  });
  const fallback = joinTaskParts([preamble, slices.find((item) => item.text)?.text]);
  const byId = new Map();
  for (const slice of slices) {
    const textPart = joinTaskParts([preamble, slice.text]) || fallback || source.trim();
    const existing = byId.get(slice.memberId);
    if (!existing) {
      byId.set(slice.memberId, textPart);
      continue;
    }
    byId.set(slice.memberId, joinTaskParts([existing, slice.text]));
  }

  const assigneeIds = [...byId.keys()].slice(0, maxAssignees);
  if (assigneeIds.length < minAssignees) return null;
  return {
    assigneeIds,
    tasks: assigneeIds.map((assigneeId) => ({
      assigneeId,
      text: byId.get(assigneeId) || source.trim(),
    })),
  };
}

export function shouldComposerKickoff(text, members = [], { conversationKind = "" } = {}) {
  return String(conversationKind || "") === "workspace_group"
    && parseComposerKickoff(text, members) != null;
}

export function normalizeKickoffTasks(value, { allowedIds = null, maxAssignees = KICKOFF_MAX_ASSIGNEES } = {}) {
  if (!Array.isArray(value)) return null;
  const allowed = allowedIds instanceof Set ? allowedIds : Array.isArray(allowedIds) ? new Set(allowedIds) : null;
  const seen = new Set();
  const tasks = [];
  for (const raw of value) {
    const assigneeId = String(raw?.assigneeId || raw?.memberId || "").trim();
    const text = String(raw?.text || "").trim();
    if (!assigneeId || seen.has(assigneeId)) continue;
    if (allowed && !allowed.has(assigneeId)) {
      throw Object.assign(new Error("every kickoff assignee must belong to the selected Conversation"), {
        code: "NOT_TEAM_MEMBER",
      });
    }
    seen.add(assigneeId);
    tasks.push({ assigneeId, text });
    if (tasks.length >= maxAssignees) break;
  }
  return tasks.length ? tasks : null;
}
