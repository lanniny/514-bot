/**
 * team-config-kit.js — 团队配置的便利层：预设模板 + 团队包（team-pack）导入导出。
 *
 * 纯函数模块，不碰 DOM/网络，便于 node --test 直测；app.js 负责接线。
 * 纪律：不改动 teams.mjs / team-members.mjs 的 CRUD 内核（多轮评审冻结面），
 * 导入走既有 POST /api/teams 与 POST /api/team-members，逐成员失败如实上报不静默。
 */

export const TEAM_PACK_FORMAT = "514cc-team-pack";
export const TEAM_PACK_VERSION = 1;

/** 内置席位 id 全集（gemini-research 已按 context.md 禁用，不进任何预设）。 */
const SEAT = Object.freeze({
  claude: "claude-fable",
  codex: "codex-technical",
  grokBuild: "grok-build",
  kimi: "kimi-frontend",
  pi: "pi-resident",
});

/** 团队预设：成员配比 + 主脑 + 协作风格提示词。skills/mcp 留空——能力声明按本机目录
    勾选，预设不臆造目录里没有的条目。成员 id 在套用时按本机目录过滤，缺席席位如实提示。 */
export const TEAM_PRESETS = Object.freeze([
  Object.freeze({
    id: "dev-strike",
    label: "研发攻坚团",
    summary: "Claude 主脑规划 + Codex/Kimi/Grok Build 执行，全栈实现导向",
    name: "研发攻坚团",
    description: "从规划到实现到验证的完整研发链路：主脑拆解，多执行席并行，评审收尾。",
    systemPrompt: "协作风格：先出可验证的实施计划再动手；每个执行席交付必须带验证证据（测试/构建/运行输出）；评审席有一票否决权，打回必须附文件+行号。",
    coordinator: SEAT.claude,
    members: [SEAT.claude, SEAT.codex, SEAT.kimi, SEAT.grokBuild],
  }),
  Object.freeze({
    id: "review-guild",
    label: "评审团",
    summary: "Codex 主审 + Claude 复审 + Kimi 前端走查，质量闸门导向",
    name: "评审团",
    description: "多视角代码评审：技术深审、架构复审、前端走查分层把关，结论固定四节。",
    systemPrompt: "协作风格：评审结论固定「致命问题 / 建议改进 / 可保留 / 总评」四节，每条必须引用文件+行号；无证据的意见降级为建议，不得伪装成致命问题。",
    coordinator: SEAT.codex,
    members: [SEAT.codex, SEAT.claude, SEAT.kimi],
  }),
  Object.freeze({
    id: "research-desk",
    label: "研究写作团",
    summary: "Claude 主脑综合 + Codex 调用检索工具 + Kimi 成稿，长文/调研导向",
    name: "研究写作团",
    description: "情报检索、交叉取证、长文综合：先事实后观点，出处随行。",
    systemPrompt: "协作风格：事实先于观点，每条关键论断带出处；检索席给原始材料与链接，主脑负责综合成文，禁止无源断言。",
    coordinator: SEAT.claude,
    members: [SEAT.claude, SEAT.codex, SEAT.kimi],
  }),
  Object.freeze({
    id: "full-ensemble",
    label: "全栈混编团",
    summary: "五个执行席位：规划、实现、评审、前端与工具编排",
    name: "全栈混编团",
    description: "CLI 与 harness 席位协作，主脑按需派工，搜索通过 MCP 工具完成。",
    systemPrompt: "协作风格：按任务类型派给最专长的席位，不平均用力；跨席交接必须写清上下文与验收标准。",
    coordinator: SEAT.claude,
    members: [SEAT.claude, SEAT.codex, SEAT.grokBuild, SEAT.kimi, SEAT.pi],
  }),
]);

export function presetById(id) {
  return TEAM_PRESETS.find((preset) => preset.id === id) || null;
}

/** 套用预设到本机目录：过滤缺席/不合格席位，主脑缺席时挑首个可任主脑的成员。
    available: knownProviderOptions 形态 [{ id, teamMemberEligible, coordinatorEligible }]。
    返回 { members, coordinator, dropped } — dropped 为被滤掉的席位 id，供 UI 如实提示。 */
export function resolvePreset(preset, available = []) {
  const byIdSeat = new Map(available.map((option) => [option.id, option]));
  const members = [];
  const dropped = [];
  for (const id of preset.members) {
    const seat = byIdSeat.get(id);
    if (!seat || seat.teamMemberEligible === false) dropped.push(id);
    else members.push(id);
  }
  let coordinator = members.includes(preset.coordinator) && byIdSeat.get(preset.coordinator)?.coordinatorEligible
    ? preset.coordinator
    : "";
  if (!coordinator) {
    coordinator = members.find((id) => byIdSeat.get(id)?.coordinatorEligible) || "";
  }
  return { members, coordinator, dropped };
}

/** 导出：把已保存团队打成可迁移 team-pack。catalog 为 /api/team-members 的 members。
    自定义成员（builtin===false）随包携带完整定义；内置席位只带 id 引用（各机目录自带）。 */
export function buildTeamPack({ team, catalog = [], now = () => new Date().toISOString() }) {
  if (!team || typeof team !== "object") throw new Error("导出失败：没有可导出的团队");
  const byIdMember = new Map((Array.isArray(catalog) ? catalog : []).map((member) => [member.id, member]));
  const customMembers = [];
  const builtinRefs = [];
  for (const id of team.members ?? []) {
    const member = byIdMember.get(id);
    if (!member) continue; // 目录已没有的席位不背包——幽灵引用不值得迁移
    if (member.builtin === false) {
      customMembers.push({
        id: member.id,
        label: member.label,
        shortLabel: member.shortLabel ?? "",
        role: member.role ?? "",
        description: member.description ?? "",
        systemPrompt: member.systemPrompt ?? "",
        capabilities: Array.isArray(member.capabilities) ? [...member.capabilities] : [],
        runtimeProfileId: member.runtimeProfileId,
        defaultModel: member.defaultModel ?? null,
        defaultEffort: member.defaultEffort ?? null,
        mainBrainAllowed: member.mainBrainAllowed === true,
      });
    } else {
      builtinRefs.push(id);
    }
  }
  return {
    format: TEAM_PACK_FORMAT,
    version: TEAM_PACK_VERSION,
    exportedAt: now(),
    team: {
      name: team.name ?? "",
      description: team.description ?? "",
      systemPrompt: team.systemPrompt ?? "",
      coordinator: team.coordinator ?? "",
      members: [...(team.members ?? [])],
      skills: [...(team.skills ?? [])],
      mcp: [...(team.mcp ?? [])],
      providers: team.providers && typeof team.providers === "object" ? { ...team.providers } : {},
    },
    members: { custom: customMembers, builtinRefs },
  };
}

/** 解析 + 校验 team-pack 文本。坏包抛中文错误；绝不容错半截包进导入流。 */
export function parseTeamPack(text) {
  let pack;
  try {
    pack = JSON.parse(text);
  } catch {
    throw new Error("文件不是合法 JSON，不是有效的团队包");
  }
  if (pack?.format !== TEAM_PACK_FORMAT) throw new Error("不是 514cc 团队包（format 不匹配）");
  if (pack.version !== TEAM_PACK_VERSION) throw new Error(`团队包版本不支持：${pack.version}（当前支持 ${TEAM_PACK_VERSION}）`);
  const team = pack.team;
  if (!team || typeof team !== "object") throw new Error("团队包缺少 team 段");
  if (typeof team.name !== "string" || !team.name.trim()) throw new Error("团队包里的团队名为空");
  if (!Array.isArray(team.members) || !team.members.length) throw new Error("团队包里的成员列表为空");
  if (team.members.some((id) => typeof id !== "string" || !id)) throw new Error("团队包成员 id 非法");
  if (team.members.length > 40) throw new Error("团队包成员数超过上限 40");
  const custom = pack.members?.custom;
  if (custom !== undefined && !Array.isArray(custom)) throw new Error("团队包 members.custom 段非法");
  for (const def of custom ?? []) {
    if (typeof def?.id !== "string" || !def.id) throw new Error("团队包自定义成员缺 id");
    if (typeof def?.runtimeProfileId !== "string" || !def.runtimeProfileId) {
      throw new Error(`团队包自定义成员「${def.label || def.id}」缺 runtimeProfileId`);
    }
  }
  const refs = pack.members?.builtinRefs;
  if (refs !== undefined && (!Array.isArray(refs) || refs.some((id) => typeof id !== "string"))) {
    throw new Error("团队包 members.builtinRefs 段非法");
  }
  return pack;
}

/** 导入计划：对照本机目录决定每个成员引用的去向。
    命中优先级：同 id → 同 label+runtimeProfileId 的自定义成员（防重复导入造重）→ 待创建/跳过。
    返回 { idMap, toCreate, skipped:[{id, reason}] }；调用方负责创建后把新 id 补进 idMap。 */
export function planMemberResolution(pack, localCatalog = []) {
  const local = Array.isArray(localCatalog) ? localCatalog : [];
  const byIdLocal = new Map(local.map((member) => [member.id, member]));
  const customDefs = new Map((pack.members?.custom ?? []).map((def) => [def.id, def]));
  const builtinRefs = new Set(pack.members?.builtinRefs ?? []);
  const idMap = {};
  const toCreate = [];
  const skipped = [];
  for (const oldId of pack.team.members) {
    if (byIdLocal.has(oldId)) {
      idMap[oldId] = oldId;
      continue;
    }
    const def = customDefs.get(oldId);
    if (def) {
      const twin = local.find((member) =>
        member.builtin === false && member.label === def.label && member.runtimeProfileId === def.runtimeProfileId);
      if (twin) {
        idMap[oldId] = twin.id;
      } else {
        toCreate.push(def); // 创建成功后由调用方回填 idMap[oldId] = 新 id
      }
      continue;
    }
    if (builtinRefs.has(oldId)) {
      skipped.push({ id: oldId, reason: "本机无此内置席位" });
      continue;
    }
    skipped.push({ id: oldId, reason: "包内无定义且本机不存在" });
  }
  return { idMap, toCreate, skipped };
}

/** 生成 POST /api/teams 的请求体：成员/主脑按 idMap 重映射，被跳过的席位如实剔除。
    主脑丢失时回退首个剩余成员；全灭返回 null（调用方必须中止导入并说明）。 */
export function remappedTeamPayload(pack, idMap) {
  const members = pack.team.members.map((oldId) => idMap[oldId]).filter(Boolean);
  if (!members.length) return null;
  const coordinator = idMap[pack.team.coordinator] || members[0];
  return {
    name: pack.team.name.trim(),
    description: String(pack.team.description ?? ""),
    systemPrompt: String(pack.team.systemPrompt ?? ""),
    coordinator,
    members,
    skills: Array.isArray(pack.team.skills) ? [...pack.team.skills] : [],
    mcp: Array.isArray(pack.team.mcp) ? [...pack.team.mcp] : [],
    providers: pack.team.providers && typeof pack.team.providers === "object" ? { ...pack.team.providers } : {},
  };
}
