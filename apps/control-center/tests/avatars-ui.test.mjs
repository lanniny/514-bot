import test from "node:test";
import assert from "node:assert/strict";
import {
  memberFaceMarkup,
  memberInitials,
  officialCliIconMarkup,
} from "../public/modules/avatars.js";

test("custom personas fall back to label initials instead of empty faces", () => {
  assert.equal(memberInitials({ label: "金色暗影" }), "金色");
  assert.equal(memberInitials({ label: "初音未来·极速电子歌姬" }), "初音");
  assert.equal(memberInitials({ shortLabel: "CX", label: "Codex 技术执行" }), "CX");
  assert.equal(memberInitials({}), "·");

  const initials = memberFaceMarkup({ id: "miku-speed", label: "初音未来·极速电子歌姬" });
  assert.match(initials, /avatar-initials/);
  assert.match(initials, /初音/);
  assert.doesNotMatch(initials, /\?\?/);

  const branded = memberFaceMarkup({ id: "codex-technical", provider: "openai" });
  assert.equal(branded, officialCliIconMarkup("codex", "cli-logo"));
  assert.match(officialCliIconMarkup("claude", "bot-avatar-icon"), /class="bot-avatar-icon cli-brand-claude"/);
  assert.match(officialCliIconMarkup("claude", "bot-avatar-icon"), /data-cli-brand="claude"/);
});
