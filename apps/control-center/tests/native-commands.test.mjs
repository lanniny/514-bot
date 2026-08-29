import test from "node:test";
import assert from "node:assert/strict";
import { adapterTemplateForRuntimeProfileId } from "../src/adapters/manifest.mjs";
import { resolveNativeCommand } from "../src/adapters/native-commands.mjs";

test("Codex compact is an adapter hook; unknown tokens fail closed", () => {
  const codex = adapterTemplateForRuntimeProfileId("codex-technical");
  const compact = resolveNativeCommand(codex, "/compact");
  assert.equal(compact.ok, true);
  assert.equal(compact.command.execution, "adapter-hook");
  assert.equal(compact.command.hook, "compactThread");
  const extra = resolveNativeCommand(codex, "/compact leftover");
  assert.equal(extra.ok, false);
  assert.equal(extra.code, "NATIVE_COMMAND_INVALID");
  const unknown = resolveNativeCommand(codex, "/not-real");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "NATIVE_COMMAND_UNSUPPORTED");
});

test("Claude compact stays slash passthrough; Grok attach is explicit", () => {
  const claude = adapterTemplateForRuntimeProfileId("claude-fable");
  const compact = resolveNativeCommand(claude, "/compact");
  assert.equal(compact.ok, true);
  assert.equal(compact.command.execution, "passthrough");
  const grok = adapterTemplateForRuntimeProfileId("grok-build");
  const attach = resolveNativeCommand(grok, "/tui");
  assert.equal(attach.ok, false);
  assert.equal(attach.code, "NATIVE_COMMAND_ATTACH_REQUIRED");
  const uuidUnknown = resolveNativeCommand(adapterTemplateForRuntimeProfileId("kimi-frontend"), "/compact");
  assert.equal(uuidUnknown.ok, false);
});
