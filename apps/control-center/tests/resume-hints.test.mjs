import test from "node:test";
import assert from "node:assert/strict";
import { resumeHintsFromSessions, resumeHintsMarkup } from "../public/modules/resume-hints.js";

test("resume hints map provider-native commands only", () => {
  const hints = resumeHintsFromSessions({
    "claude-fable": "sess-c1",
    "codex-technical": "sess-x1",
    "kimi-frontend": "sess-k1",
    "pi-resident": "sess-p1",
  });
  assert.equal(hints.find((h) => h.agentId === "claude-fable").command, "claude -r sess-c1");
  assert.equal(hints.find((h) => h.agentId === "codex-technical").command, "codex resume sess-x1");
  const rolloutHints = resumeHintsFromSessions({
    "codex-technical": "rollout-2026-07-17T09-21-00-019f0000-0000-7000-8000-000000000000.jsonl",
  });
  assert.equal(rolloutHints[0].command, "codex resume 019f0000-0000-7000-8000-000000000000");
  assert.equal(hints.find((h) => h.agentId === "kimi-frontend").command, "kimi -S sess-k1");
  assert.equal(hints.find((h) => h.agentId === "pi-resident").canResume, true);
  assert.equal(hints.find((h) => h.agentId === "pi-resident").command, "pi --session-id sess-p1");
  const uuidHints = resumeHintsFromSessions(
    { "custom-uuid-member": "sess-x2" },
    { members: [{ id: "custom-uuid-member", runtimeProfileId: "codex-technical" }] },
  );
  assert.equal(uuidHints[0].command, "codex resume sess-x2");
});

test("resume hints markup only lists canResume commands", () => {
  const html = resumeHintsMarkup(
    resumeHintsFromSessions({ "claude-fable": "abc", "pi-resident": "nope" }),
    { escapeHtml: (value) => String(value) },
  );
  assert.match(html, /claude -r abc/);
  assert.match(html, /pi --session-id nope/);
  assert.match(html, /data-copy-resume/);
});
