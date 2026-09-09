import test from "node:test";
import assert from "node:assert/strict";
import {
  TEAM_PRESETS,
  presetById,
  resolvePreset,
  buildTeamPack,
  parseTeamPack,
  planMemberResolution,
  remappedTeamPayload,
} from "../public/modules/team-config-kit.js";

const seat = (id, over = {}) => ({ id, teamMemberEligible: true, coordinatorEligible: true, ...over });
const ALL_SEATS = [
  seat("claude-fable"),
  seat("codex-technical"),
  seat("grok-build"),
  seat("kimi-frontend"),
  seat("pi-resident"),
];

test("presets never reference the disabled gemini seat and always have a coordinator plan", () => {
  for (const preset of TEAM_PRESETS) {
    assert.ok(!preset.members.includes("gemini-research"), `${preset.id} must not include gemini-research`);
    assert.ok(!preset.members.includes("grok-search"), `${preset.id} must not include a retired tool seat`);
    assert.ok(preset.members.includes(preset.coordinator), `${preset.id} coordinator must be a member`);
    assert.ok(preset.name && preset.systemPrompt, `${preset.id} needs name + systemPrompt`);
  }
  assert.equal(presetById("review-guild").coordinator, "codex-technical");
  assert.equal(presetById("nope"), null);
});

test("resolvePreset filters missing/ineligible seats and falls back coordinator honestly", () => {
  const full = resolvePreset(presetById("full-ensemble"), ALL_SEATS);
  assert.deepEqual(full.members, ["claude-fable", "codex-technical", "grok-build", "kimi-frontend", "pi-resident"]);
  assert.equal(full.coordinator, "claude-fable");
  assert.deepEqual(full.dropped, []);

  // 主脑缺席 → 回退首个可任主脑成员
  const noClaude = ALL_SEATS.filter((s) => s.id !== "claude-fable");
  const degraded = resolvePreset(presetById("dev-strike"), noClaude);
  assert.deepEqual(degraded.dropped, ["claude-fable"]);
  assert.equal(degraded.coordinator, "codex-technical");

  // 主脑在但不可任主脑 → 同样回退
  const claudeNoCoord = ALL_SEATS.map((s) => s.id === "claude-fable" ? seat(s.id, { coordinatorEligible: false }) : s);
  const fallback = resolvePreset(presetById("dev-strike"), claudeNoCoord);
  assert.equal(fallback.coordinator, "codex-technical");

  // 席位不合格 → 进 dropped，不进 members
  const codexOff = ALL_SEATS.map((s) => s.id === "codex-technical" ? seat(s.id, { teamMemberEligible: false }) : s);
  const partial = resolvePreset(presetById("review-guild"), codexOff);
  assert.deepEqual(partial.members, ["claude-fable", "kimi-frontend"]);
  assert.deepEqual(partial.dropped, ["codex-technical"]);

  // 全灭 → 空成员空主脑，调用方拦截
  const none = resolvePreset(presetById("dev-strike"), []);
  assert.deepEqual(none.members, []);
  assert.equal(none.coordinator, "");
});

const catalog = [
  { id: "claude-fable", builtin: true, label: "Claude Fable" },
  { id: "codex-technical", builtin: true, label: "烛" },
  {
    id: "member-aaa", builtin: false, label: "我的评审席", shortLabel: "评", role: "评审",
    description: "d", systemPrompt: "s", capabilities: ["review"], runtimeProfileId: "codex-technical",
    defaultModel: "gpt-5", defaultEffort: "high", mainBrainAllowed: true,
  },
];

test("buildTeamPack splits custom definitions from builtin refs and drops ghosts", () => {
  const team = {
    name: "混编团", description: "desc", systemPrompt: "prompt",
    coordinator: "member-aaa",
    members: ["claude-fable", "member-aaa", "ghost-seat"],
    skills: ["review"], mcp: ["filesystem"], providers: { codex: "p1" },
  };
  const pack = buildTeamPack({ team, catalog, now: () => "2026-08-02T00:00:00.000Z" });
  assert.equal(pack.format, "514cc-team-pack");
  assert.equal(pack.version, 1);
  assert.equal(pack.exportedAt, "2026-08-02T00:00:00.000Z");
  assert.deepEqual(pack.team.members, ["claude-fable", "member-aaa", "ghost-seat"]);
  assert.deepEqual(pack.members.builtinRefs, ["claude-fable"]);
  assert.equal(pack.members.custom.length, 1);
  assert.equal(pack.members.custom[0].id, "member-aaa");
  assert.equal(pack.members.custom[0].runtimeProfileId, "codex-technical");
  assert.equal(pack.members.custom[0].mainBrainAllowed, true);
  assert.deepEqual(pack.team.providers, { codex: "p1" });
  assert.throws(() => buildTeamPack({ team: null, catalog }), /没有可导出的团队/);
});

const samplePack = buildTeamPack({
  team: {
    name: "混编团", description: "d", systemPrompt: "p", coordinator: "member-aaa",
    members: ["claude-fable", "member-aaa"], skills: [], mcp: [], providers: {},
  },
  catalog,
});

test("parseTeamPack accepts a round-tripped pack and rejects broken input precisely", () => {
  const ok = parseTeamPack(JSON.stringify(samplePack));
  assert.equal(ok.team.name, "混编团");

  assert.throws(() => parseTeamPack("not json"), /不是合法 JSON/);
  assert.throws(() => parseTeamPack(JSON.stringify({ format: "other" })), /format 不匹配/);
  assert.throws(() => parseTeamPack(JSON.stringify({ ...samplePack, version: 99 })), /版本不支持/);
  assert.throws(() => parseTeamPack(JSON.stringify({ ...samplePack, team: { ...samplePack.team, name: " " } })), /团队名为空/);
  assert.throws(() => parseTeamPack(JSON.stringify({ ...samplePack, team: { ...samplePack.team, members: [] } })), /成员列表为空/);
  assert.throws(() => parseTeamPack(JSON.stringify({ ...samplePack, team: { ...samplePack.team, members: ["a", 1] } })), /成员 id 非法/);
  assert.throws(
    () => parseTeamPack(JSON.stringify({ ...samplePack, team: { ...samplePack.team, members: Array.from({ length: 41 }, (_, i) => `m${i}`) } })),
    /超过上限 40/,
  );
  assert.throws(
    () => parseTeamPack(JSON.stringify({ ...samplePack, members: { custom: [{ id: "m1", label: "x" }], builtinRefs: [] } })),
    /缺 runtimeProfileId/,
  );
  assert.throws(
    () => parseTeamPack(JSON.stringify({ ...samplePack, members: { custom: [], builtinRefs: ["a", 2] } })),
    /builtinRefs 段非法/,
  );
});

test("planMemberResolution reuses by id, dedupes twins, creates the rest, skips honestly", () => {
  // 本机已有内置 + 一个同 label/runtimeProfileId 的孪生自定义成员
  const local = [
    { id: "claude-fable", builtin: true },
    { id: "member-twin", builtin: false, label: "我的评审席", runtimeProfileId: "codex-technical" },
  ];
  const plan = planMemberResolution(samplePack, local);
  assert.equal(plan.idMap["claude-fable"], "claude-fable");
  assert.equal(plan.idMap["member-aaa"], "member-twin", "twin must be reused, not duplicated");
  assert.equal(plan.toCreate.length, 0);
  assert.equal(plan.skipped.length, 0);

  // 空本机：内置缺席如实 skip，自定义进 toCreate
  const cold = planMemberResolution(samplePack, []);
  assert.equal(cold.idMap["claude-fable"], undefined);
  assert.equal(cold.toCreate.length, 1);
  assert.deepEqual(cold.skipped, [{ id: "claude-fable", reason: "本机无此内置席位" }]);

  // 包内无定义且本机不存在 → skip
  const orphanPack = { ...samplePack, team: { ...samplePack.team, members: ["claude-fable", "member-zzz"] } };
  const orphan = planMemberResolution(orphanPack, [{ id: "claude-fable", builtin: true }]);
  assert.deepEqual(orphan.skipped, [{ id: "member-zzz", reason: "包内无定义且本机不存在" }]);
});

test("remappedTeamPayload remaps members/coordinator and fails closed when empty", () => {
  const body = remappedTeamPayload(samplePack, { "claude-fable": "claude-fable", "member-aaa": "member-new" });
  assert.deepEqual(body.members, ["claude-fable", "member-new"]);
  assert.equal(body.coordinator, "member-new");
  assert.equal(body.name, "混编团");

  // 主脑丢失 → 回退首个剩余成员
  const fallback = remappedTeamPayload(samplePack, { "claude-fable": "claude-fable" });
  assert.deepEqual(fallback.members, ["claude-fable"]);
  assert.equal(fallback.coordinator, "claude-fable");

  // 全灭 → null，导入必须中止
  assert.equal(remappedTeamPayload(samplePack, {}), null);
});
