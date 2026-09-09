import test from "node:test";
import assert from "node:assert/strict";
import { createBotCollabApi } from "../public/modules/bot-collab-api.js";

test("createBotCollabApi posts multi-@ kickoff to /api/bots/relay/kickoff", async () => {
  const calls = [];
  const api = createBotCollabApi({
    async request(path, init) {
      calls.push({ path, init });
      return { schema: "514cc.bot-kickoff/v1", created: true, tasks: [], run: { id: "run-1" } };
    },
  });
  const payload = await api.kickoff({
    conversationId: "conversation-1",
    prompt: "@claude-fable do X @codex-technical do Y",
    tasks: [
      { assigneeId: "claude-fable", text: "do X" },
      { assigneeId: "codex-technical", text: "do Y" },
    ],
  });
  assert.equal(payload.run.id, "run-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/bots/relay/kickoff");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.body.tasks.map((task) => task.assigneeId), ["claude-fable", "codex-technical"]);
});

test("createBotCollabApi does not invent a conversationId", async () => {
  const api = createBotCollabApi({ request: async () => ({}) });
  await assert.rejects(() => api.kickoff({ prompt: "@a x @b y" }), /conversationId is required/);
});
