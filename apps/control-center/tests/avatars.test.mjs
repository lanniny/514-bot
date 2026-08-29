import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAvatarStore, MAX_AVATAR_BYTES, OPERATOR_DEFAULT_LABEL } from "../src/avatars.mjs";
import { TeamMemberStore } from "../src/team-members.mjs";

function runtimeProfile(id = "codex-technical") {
  return {
    id,
    label: id === "codex-technical" ? "Codex 技术执行" : id,
    shortLabel: "Codex",
    role: "technical-executor",
    description: "runtime",
    systemPrompt: "verify",
    capabilities: ["coding"],
    model: "gpt-test",
    defaultEffort: "high",
    modelOptions: [{ id: "gpt-test", label: "gpt-test" }],
    effortLevels: ["high", "xhigh"],
    provider: "openai",
    adapter: "codex-app-server",
    enabled: true,
    teamMemberEligible: true,
    coordinatorEligible: true,
  };
}

function minimalJpeg() {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0xff, 0xd9,
  ]);
}

function jpegDataUrl() {
  return `data:image/jpeg;base64,${minimalJpeg().toString("base64")}`;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cc-avatars-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const teamMembers = await new TeamMemberStore({
    dataRoot: root,
    runtimeCatalog: () => [runtimeProfile()],
    referencesForMember: async () => [],
    secureFile: async (path) => chmod(path, 0o600),
  }).load();
  const avatars = await createAvatarStore({ dataRoot: root, teamMembers }).init();
  return { root, teamMembers, avatars };
}

test("operator avatar defaults to AEMEATH and round-trips a custom photo", async (t) => {
  const { avatars } = await fixture(t);
  const initial = await avatars.operatorProfile();
  assert.equal(initial.label, OPERATOR_DEFAULT_LABEL);
  assert.equal(initial.avatar, "");
  assert.deepEqual(initial.hiddenMemberIds, []);
  await assert.rejects(() => avatars.readOperatorFile(), { code: "AVATAR_NOT_FOUND" });

  const saved = await avatars.setOperatorAvatar(jpegDataUrl());
  assert.equal(saved.avatar, "custom");
  const file = await avatars.readOperatorFile();
  assert.equal(file.mimeType, "image/jpeg");
  assert.ok(file.bytes.equals(minimalJpeg()));

  const cleared = await avatars.clearOperatorAvatar();
  assert.equal(cleared.avatar, "");
  await assert.rejects(() => avatars.readOperatorFile(), { code: "AVATAR_NOT_FOUND" });
});

test("operator nickname is validated and survives avatar changes", async (t) => {
  const { avatars } = await fixture(t);
  await assert.rejects(() => avatars.setOperatorProfile({ label: "   " }), { code: "VALIDATION_FAILED" });
  await assert.rejects(
    () => avatars.setOperatorProfile({ label: "LO", hiddenMemberIds: ["../unsafe"] }),
    { code: "VALIDATION_FAILED" },
  );

  const renamed = await avatars.setOperatorProfile({
    label: "LO 的工作台",
    hiddenMemberIds: ["grok-search", "grok-search", "kimi-frontend"],
  });
  assert.equal(renamed.label, "LO 的工作台");
  assert.equal(renamed.avatar, "");
  assert.deepEqual(renamed.hiddenMemberIds, ["grok-search", "kimi-frontend"]);

  const withAvatar = await avatars.setOperatorAvatar(jpegDataUrl());
  assert.equal(withAvatar.label, "LO 的工作台");
  assert.equal(withAvatar.avatar, "custom");
  assert.deepEqual(withAvatar.hiddenMemberIds, ["grok-search", "kimi-frontend"]);
});

test("member avatar writes the catalog flag and rejects unknown members before storing bytes", async (t) => {
  const { root, avatars, teamMembers } = await fixture(t);
  await assert.rejects(() => avatars.setMemberAvatar("missing-member", jpegDataUrl()), { code: "SOURCE_NOT_FOUND" });
  assert.deepEqual(await readdir(join(root, "uploads", "avatars")).catch(() => []), []);

  const updated = await avatars.setMemberAvatar("codex-technical", jpegDataUrl());
  assert.equal(updated.avatar, "custom");
  assert.equal(teamMembers.get("codex-technical").avatar, "custom");
  const file = await avatars.readMemberFile("codex-technical");
  assert.equal(file.mimeType, "image/jpeg");

  const cleared = await avatars.clearMemberAvatar("codex-technical");
  assert.equal(cleared.avatar, "");
  await assert.rejects(() => avatars.readMemberFile("codex-technical"), { code: "AVATAR_NOT_FOUND" });
});

test("avatar upload rejects oversized or mismatched images", async (t) => {
  const { avatars } = await fixture(t);
  await assert.rejects(() => avatars.setOperatorAvatar("not-an-image"), { code: "INVALID_IMAGE_DATA" });
  const huge = `data:image/jpeg;base64,${Buffer.alloc(MAX_AVATAR_BYTES + 32).toString("base64")}`;
  await assert.rejects(() => avatars.setOperatorAvatar(huge), { code: "IMAGE_TOO_LARGE" });
  const lying = `data:image/png;base64,${minimalJpeg().toString("base64")}`;
  await assert.rejects(() => avatars.setOperatorAvatar(lying), { code: "IMAGE_TYPE_MISMATCH" });
});

test("team background stores, reads, and clears per-team image files", async (t) => {
  const { avatars } = await fixture(t);
  await assert.rejects(() => avatars.readTeamBackgroundFile("team-alpha"), { code: "BACKGROUND_NOT_FOUND" });
  assert.equal(await avatars.hasTeamBackground("team-alpha"), false);
  await avatars.setTeamBackground("team-alpha", jpegDataUrl());
  assert.equal(await avatars.hasTeamBackground("team-alpha"), true);
  const file = await avatars.readTeamBackgroundFile("team-alpha");
  assert.equal(file.mimeType, "image/jpeg");
  // 重传换格式时清掉旧后缀文件，不留僵尸图
  await avatars.setTeamBackground("team-alpha", jpegDataUrl());
  const again = await avatars.readTeamBackgroundFile("team-alpha");
  assert.ok(again.bytes.length > 0);
  await avatars.clearTeamBackground("team/team-id+odd");
  await avatars.clearTeamBackground("team-alpha");
  assert.equal(await avatars.hasTeamBackground("team-alpha"), false);
  await assert.rejects(() => avatars.readTeamBackgroundFile("team-alpha"), { code: "BACKGROUND_NOT_FOUND" });
});

test("team background rejects oversized payloads and non-image data", async (t) => {
  const { avatars } = await fixture(t);
  await assert.rejects(() => avatars.setTeamBackground("team-beta", "data:image/jpeg;base64,////"), { code: "INVALID_IMAGE_DATA" });
  await assert.rejects(() => avatars.setTeamBackground("team-beta", "not-a-data-url"), { code: "INVALID_IMAGE_DATA" });
});

test("team background accepts mp4/webm video by container magic and rejects fakes", async (t) => {
  const { avatars } = await fixture(t);
  // 最小 mp4 头：size(4) + "ftyp" + brand
  const mp4 = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftypisom", "latin1"),
    Buffer.from([0x00, 0x00, 0x02, 0x00]),
    Buffer.from("free", "latin1"),
  ]);
  const savedMp4 = await avatars.setTeamBackground("team-vid", `data:video/mp4;base64,${mp4.toString("base64")}`);
  assert.equal(savedMp4.mediaKind, "video");
  assert.equal(savedMp4.mimeType, "video/mp4");
  const file = await avatars.readTeamBackgroundFile("team-vid");
  assert.equal(file.mimeType, "video/mp4");
  // webm EBML 魔数
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]);
  const savedWebm = await avatars.setTeamBackground("team-vid", `data:video/webm;base64,${webm.toString("base64")}`);
  assert.equal(savedWebm.mediaKind, "video");
  // 伪装：声明 mp4 但没有 ftyp 容器头
  await assert.rejects(
    () => avatars.setTeamBackground("team-vid", `data:video/mp4;base64,${Buffer.from("not-an-mp4-at-all").toString("base64")}`),
    { code: "INVALID_IMAGE_DATA" },
  );
  // 未知视频容器：MIME 白名单直接拒绝
  await assert.rejects(
    () => avatars.setTeamBackground("team-vid", `data:video/x-matroska;base64,${mp4.toString("base64")}`),
    { code: "UNSUPPORTED_IMAGE_TYPE" },
  );
});
