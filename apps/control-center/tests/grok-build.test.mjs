import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGrokArgs, GrokBuildAdapter } from "../src/adapters/grok-build.mjs";
import { createLfCollector } from "../src/adapters/stream-utils.mjs";

test("buildGrokArgs places prompt, resume, model and streaming format in order", () => {
  assert.deepEqual(buildGrokArgs({ prompt: "hi" }), ["-p", "hi", "--permission-mode", "plan", "--output-format", "streaming-json"]);
  assert.deepEqual(buildGrokArgs({ prompt: "new", newSessionId: "new-session" }), [
    "-p", "new", "--session-id", "new-session", "--permission-mode", "plan", "--output-format", "streaming-json",
  ]);
  assert.deepEqual(buildGrokArgs({ prompt: "again", sessionId: "s1", model: "grok45-514" }), [
    "-p", "again", "-r", "s1", "-m", "grok45-514", "--permission-mode", "plan", "--output-format", "streaming-json",
  ]);
  // 写轮必须是 headless deny-by-default：首次 Write 不弹无人权限框，其他工具也不能借环境默认扩权。
  assert.deepEqual(buildGrokArgs({ prompt: "w", permissionMode: "workspace-write" }), [
    "-p", "w",
    "--permission-mode", "dontAsk",
    "--tools", "read_file,grep,list_dir,search_replace,run_terminal_cmd,todo_write",
    "--no-subagents",
    "--disable-web-search",
    "--allow", "Edit(./**)",
    "--allow", "Write(./**)",
    "--deny", "MCPTool",
    "--output-format", "streaming-json",
  ]);
  assert.equal(buildGrokArgs({ prompt: "w", permissionMode: "workspace-write" }).some((arg) => arg.startsWith("Bash(")), false);
});

test("buildGrokArgs passes through empirically-validated native approval modes on read-semantic turns", () => {
  // 2026-08-27 本机实证通过的三档：auto / acceptEdits 走 --permission-mode，always-approve 是独立旗标形态。
  assert.deepEqual(buildGrokArgs({ prompt: "p", nativeApprovalMode: "native:auto" }), [
    "-p", "p", "--permission-mode", "auto", "--output-format", "streaming-json",
  ]);
  assert.deepEqual(buildGrokArgs({ prompt: "p", nativeApprovalMode: "native:acceptEdits" }), [
    "-p", "p", "--permission-mode", "acceptEdits", "--output-format", "streaming-json",
  ]);
  assert.deepEqual(buildGrokArgs({ prompt: "p", nativeApprovalMode: "native:always-approve" }), [
    "-p", "p", "--always-approve", "--output-format", "streaming-json",
  ]);
});

test("write turns ignore any nativeApprovalMode and keep the dontAsk whitelist invariant", () => {
  const expected = [
    "-p", "w",
    "--permission-mode", "dontAsk",
    "--tools", "read_file,grep,list_dir,search_replace,run_terminal_cmd,todo_write",
    "--no-subagents",
    "--disable-web-search",
    "--allow", "Edit(./**)",
    "--allow", "Write(./**)",
    "--deny", "MCPTool",
    "--output-format", "streaming-json",
  ];
  for (const mode of ["native:auto", "native:acceptEdits", "native:always-approve", "native:yolo", null]) {
    const args = buildGrokArgs({ prompt: "w", permissionMode: "workspace-write", nativeApprovalMode: mode });
    assert.deepEqual(args, expected, `写盘轮必须忽略 ${mode}，钉死 dontAsk + 白名单不变量`);
    assert.equal(args.includes("--always-approve"), false, `${mode} 不得把 --always-approve 带进写盘轮`);
  }
});

test("unknown or malformed nativeApprovalMode falls back to plan without throwing", () => {
  for (const mode of ["native:yolo", "auto", "acceptEdits", "always-approve", "bypassPermissions", 42, ""]) {
    assert.deepEqual(buildGrokArgs({ prompt: "p", nativeApprovalMode: mode }), [
      "-p", "p", "--permission-mode", "plan", "--output-format", "streaming-json",
    ], `非法值 ${JSON.stringify(mode)} 必须回落 plan`);
  }
});

test("GrokBuildAdapter rejects prompts over the arg budget without spawning", async () => {
  const events = [];
  const adapter = new GrokBuildAdapter({ eventStore: { emit: (t, d) => events.push([t, d]) }, cwd: "." });
  await assert.rejects(() => adapter.send({ prompt: "x".repeat(25_000), runId: "r" }), { code: "INVALID_PROMPT" });
  assert.equal(events.length, 0, "no events emitted when the prompt is rejected up front");
});

test("streaming-json event shape: thought stream ignored, text accumulated, end carries sessionId", () => {
  // 复用生产 collector 解析真实 grok streaming-json 三段式（2026-07-17 实测格式）
  const seen = [];
  const collector = createLfCollector((event) => seen.push(event));
  const lines = [
    '{"type":"thought","data":"The"}',
    '{"type":"thought","data":" user"}',
    '{"type":"text","data":"O"}',
    '{"type":"text","data":"K"}',
    '{"type":"end","stopReason":"EndTurn","sessionId":"019f6e79-abcd","usage":{"total_tokens":42}}',
  ];
  collector.push(lines.join("\n") + "\n");
  collector.end();
  const thoughts = seen.filter((e) => e.type === "thought").length;
  const text = seen.filter((e) => e.type === "text").map((e) => e.data).join("");
  const end = seen.find((e) => e.type === "end");
  assert.equal(thoughts, 2);
  assert.equal(text, "OK");
  assert.equal(end.sessionId, "019f6e79-abcd");
  assert.equal(end.usage.total_tokens, 42);
});

// LO 2026-08-14 报障（run d63b839d 第 5 轮）：grok 以 exit 0 + stopReason=cancelled 报「本轮
// 被中断」，443 output tokens 全丢。stopReason 只落事件、不进 send() 返回值时，编排器无从
// 分辨「正常完成」与「被中断」，于是把中断轮当正常完成记账，UI 显示「第 5 轮完成」的空白气泡。
test("send() 回传 stopReason，中断轮不会被编排器当成正常完成", async () => {
  const events = [];
  const adapter = new GrokBuildAdapter({
    eventStore: { emit: async (type, data) => { events.push([type, data]); } },
    cwd: ".",
    runProcessImpl: async (_command, _args, { onStdout }) => {
      // 现场形态也可能带 partial text；它只能留作 incomplete 诊断，不能先冒充普通答复。
      onStdout('{"type":"thought","data":"thinking"}\n');
      onStdout('{"type":"text","data":"开始处理，但写工具未获授权。"}\n');
      onStdout('{"type":"end","stopReason":"cancelled","sessionId":"019ffdc8-cafe","usage":{"output_tokens":443}}\n');
      return { code: 0, stderr: "" };
    },
  });
  const result = await adapter.send({ prompt: "继续执行", runId: "r-cancelled", agentId: "grok-build" });
  assert.equal(result.stopReason, "cancelled");
  assert.equal(result.text, "开始处理，但写工具未获授权。");
  assert.equal(result.sessionId, "019ffdc8-cafe");
  assert.equal(result.tokens, 443);
  assert.equal(events.some(([type]) => type === "assistant.message"), false, "cancelled partial text leaked as a normal assistant reply");
  // 正常收束同样如实回传，编排器据此区分两者
  const okEvents = [];
  const okCheckpoints = [];
  const ok = new GrokBuildAdapter({
    eventStore: { emit: async (type, data) => { okEvents.push([type, data]); } },
    cwd: ".",
    runProcessImpl: async (_command, _args, { onStdout }) => {
      onStdout('{"type":"text","data":"done"}\n');
      onStdout('{"type":"end","stopReason":"EndTurn","sessionId":"019ffdc8-beef"}\n');
      return { code: 0, stderr: "" };
    },
  });
  const okResult = await ok.send({
    prompt: "go",
    runId: "r-ok",
    agentId: "grok-build",
    onTurnSubmitting: async (data) => { okCheckpoints.push(data); },
  });
  assert.equal(okResult.stopReason, "EndTurn");
  assert.equal(okResult.text, "done");
  assert.deepEqual(okEvents.find(([type]) => type === "assistant.message")?.[1], { text: "done" });
  assert.equal(okCheckpoints.length, 2);
  assert.equal(okCheckpoints[0].sessionResumable, false);
  assert.equal(okCheckpoints[1].sessionId, "019ffdc8-beef");
  assert.equal(okCheckpoints[1].sessionResumable, true);
});

test("Responses 工具续调 400 会保留预分配 session，并收敛为可继续的阶段诊断", async () => {
  const sessionId = "01a0034a-771d-7b62-b97d-bf7089aaa07b";
  const checkpoints = [];
  const adapter = new GrokBuildAdapter({
    eventStore: { emit: async () => {} },
    cwd: ".",
    sessionIdFactory: () => sessionId,
    runProcessImpl: async (_command, args) => {
      assert.deepEqual(args.slice(0, 4), ["-p", "继续完善", "--session-id", sessionId]);
      return {
        code: 1,
        stderr: `Error: Internal error: ${JSON.stringify({
          message: "API error (status 400 Bad Request): bad_response_status_code: openai_error",
          http_status: 400,
          promptUsage: { modelCalls: 2, inputTokens: 44_432 },
        }, null, 2)}`,
      };
    },
  });

  await assert.rejects(
    () => adapter.send({
      prompt: "继续完善",
      runId: "r-upstream-400",
      agentId: "grok-build",
      onTurnSubmitting: async (data) => { checkpoints.push(data); },
    }),
    (error) => {
      assert.equal(error.code, "GROK_BUILD_FAILED");
      assert.equal(error.sessionId, sessionId);
      assert.equal(error.protocol, "grok-headless-resume");
      assert.equal(error.httpStatus, 400);
      assert.equal(error.successfulModelCalls, 2);
      assert.equal(error.sessionResumable, true);
      assert.equal(error.nativeTurnSettled, true);
      assert.match(error.message, /前 2 次模型调用成功后，于第 3 次续调返回 HTTP 400/);
      assert.match(error.message, /原生会话 .* 已确认保留，可在当前任务中继续/);
      assert.doesNotMatch(error.message, /inputTokens/);
      return true;
    },
  );
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].sessionId, null, "preallocated session must not be promoted before native evidence exists");
  assert.equal(checkpoints[0].tentativeSessionId, sessionId);
  assert.equal(checkpoints[0].sessionResumable, false);
});

test("首次 Responses 400 不会把预分配 UUID 宣称为可恢复 session", async () => {
  const sessionId = "01a0034a-771d-7b62-b97d-bf7089aaa07c";
  const adapter = new GrokBuildAdapter({
    eventStore: { emit: async () => {} },
    cwd: ".",
    sessionIdFactory: () => sessionId,
    runProcessImpl: async () => ({
      code: 1,
      stderr: `Error: Internal error: ${JSON.stringify({
        message: "API error (status 400 Bad Request): bad_response_status_code: openai_error",
        http_status: 400,
        promptUsage: { modelCalls: 0 },
      })}`,
    }),
  });

  await assert.rejects(
    () => adapter.send({ prompt: "start", runId: "r-first-400", agentId: "grok-build" }),
    (error) => {
      assert.equal(error.code, "GROK_BUILD_FAILED");
      assert.equal(error.sessionId, null);
      assert.equal(error.tentativeSessionId, sessionId);
      assert.equal(error.sessionResumable, false);
      assert.equal(error.successfulModelCalls, 0);
      assert.match(error.message, /首次模型调用时返回 HTTP 400/);
      assert.match(error.message, /未确认创建可恢复的原生会话/);
      assert.doesNotMatch(error.message, /已确认保留/);
      return true;
    },
  );
});

test("spawn 失败会结算为明确拒绝且不提升 tentative session", async () => {
  const sessionId = "01a0034a-771d-7b62-b97d-bf7089aaa07d";
  const adapter = new GrokBuildAdapter({
    eventStore: { emit: async () => {} },
    cwd: ".",
    sessionIdFactory: () => sessionId,
    runProcessImpl: async () => { throw Object.assign(new Error("spawn grok ENOENT"), { code: "ENOENT" }); },
  });
  await assert.rejects(
    () => adapter.send({ prompt: "start", runId: "r-spawn-failed", agentId: "grok-build" }),
    (error) => {
      assert.equal(error.code, "ENOENT");
      assert.equal(error.submissionRejected, true);
      assert.equal(error.nativeTurnSettled, true);
      assert.equal(error.sessionId, null);
      assert.equal(error.tentativeSessionId, sessionId);
      assert.equal(error.sessionResumable, false);
      return true;
    },
  );
});

test("预分配 session 不能把 exit 0 但缺 end 的截断输出误判为成功或可恢复", async () => {
  const sessionId = "01a0034a-771d-7b62-b97d-bf7089aaa07c";
  const adapter = new GrokBuildAdapter({
    eventStore: { emit: async () => {} },
    cwd: ".",
    sessionIdFactory: () => sessionId,
    runProcessImpl: async () => ({ code: 0, stderr: "" }),
  });
  await assert.rejects(
    () => adapter.send({ prompt: "continue", runId: "r-no-end", agentId: "grok-build" }),
    (error) => error.code === "GROK_BUILD_FAILED"
      && error.sessionId === null
      && error.tentativeSessionId === sessionId
      && error.sessionResumable === false
      && /without an end event/.test(error.message),
  );
});

test("既有 session 即使 exit 0 缺 end 仍可恢复，但不会被误判为成功", async () => {
  const sessionId = "01a0034a-771d-7b62-b97d-bf7089aaa07e";
  const adapter = new GrokBuildAdapter({
    eventStore: { emit: async () => {} },
    cwd: ".",
    runProcessImpl: async () => ({ code: 0, stderr: "" }),
  });
  await assert.rejects(
    () => adapter.send({ sessionId, prompt: "continue", runId: "r-existing-no-end", agentId: "grok-build" }),
    (error) => error.code === "GROK_BUILD_FAILED"
      && error.sessionId === sessionId
      && error.sessionResumable === true
      && /已确认保留/.test(error.message),
  );
});

test("收到 end 后若进程非零退出，不发布正常答复或完成事件", async () => {
  const events = [];
  const sessionId = "01a0034a-771d-7b62-b97d-bf7089aaa07f";
  const adapter = new GrokBuildAdapter({
    eventStore: { emit: async (type, data) => { events.push([type, data]); } },
    cwd: ".",
    sessionIdFactory: () => sessionId,
    runProcessImpl: async (_command, _args, { onStdout }) => {
      onStdout('{"type":"text","data":"not final"}\n');
      onStdout(`{"type":"end","stopReason":"EndTurn","sessionId":"${sessionId}"}\n`);
      return { code: 1, stderr: "provider wrapper failed after end" };
    },
  });
  await assert.rejects(
    () => adapter.send({ prompt: "go", runId: "r-end-nonzero", agentId: "grok-build" }),
    (error) => error.code === "GROK_BUILD_FAILED" && error.sessionId === sessionId && error.sessionResumable === true,
  );
  assert.equal(events.some(([type]) => type === "assistant.message"), false);
  assert.equal(events.some(([type]) => type === "grok.completed"), false);
});
