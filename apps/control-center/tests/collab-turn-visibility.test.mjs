// 协作台每一轮「发生了什么」必须自己说清楚——LO 2026-08-14 报障（run d63b839d）的可见性契约。
// 现场：第 1 轮能写盘、第 3–6 轮全被降成只读却毫无提示；第 5 轮 provider 报 cancelled 被记成
// 「第 5 轮完成」的空白气泡；同一句话被回答两遍。三件事在界面上全都看不出来，只能靠读磁盘。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const publicRoot = resolve(import.meta.dirname, "../public");

test("写权限降级与无产出轮各有一条注记，不静默", async () => {
  const eventMarkup = await readFile(resolve(publicRoot, "modules/conversation-event-markup.js"), "utf8");
  // Wave B slice 16：GOVERNANCE_EVENTS 已抽取到 modules/conversation-event-markup.js
  // 降级注记：说清是哪个成员、为什么、怎么恢复——只说"降级了"等于没说
  assert.match(eventMarkup, /"run\.write_degraded":\s*\{/);
  assert.match(eventMarkup, /本轮降为只读/);
  assert.match(eventMarkup, /CAPABILITY_LEASE_INACTIVE"\s*\?\s*"执行租约已过期或被吊销"/);
  assert.match(eventMarkup, /BUILD_APPROVAL_INVALID"\s*\?\s*"Build 审批已失效/);
  // 无产出轮：轮次与 token 真实消耗了，必须说明预算已花掉，而不是留一个空白气泡
  assert.match(eventMarkup, /"agent\.turn_unproductive":\s*\{/);
  assert.match(eventMarkup, /没有产出内容/);
  assert.match(eventMarkup, /已有部分输出仅供排查，未形成交付/);
  assert.match(eventMarkup, /该轮预算已消耗/);
  assert.match(eventMarkup, /任务不会按成功结算/);
  assert.match(eventMarkup, /provider 收束原因：\$\{data\.stopReason\}/);
  // 两条都是需要人注意的异常态，不能用中性 tone 混进正常流水
  const degraded = eventMarkup.slice(eventMarkup.indexOf('"run.write_degraded"'), eventMarkup.indexOf('"agent.turn_unproductive"'));
  assert.match(degraded, /tone: "amber"/);
});

test("轮次统计行标出本轮能不能写盘", async () => {
  const eventMarkup = await readFile(resolve(publicRoot, "modules/conversation-event-markup.js"), "utf8");
  // Wave B slice 16：turnMetaText 已抽取到 modules/conversation-event-markup.js
  const meta = eventMarkup.slice(eventMarkup.indexOf("function turnMetaText"), eventMarkup.lastIndexOf("return {"));
  assert.match(meta, /data\.permissionMode === "workspace-write"/);
  assert.match(meta, /parts\.push\("可写盘"\)/);
  // plan/read-only 不标注（本来就不写盘），其余非常规档位如实显示原值
  assert.match(meta, /data\.permissionMode !== "plan" && data\.permissionMode !== "read-only"/);
});

test("重复提交被拦时给的是人话，不是英文 code", async () => {
  const app = await readFile(resolve(publicRoot, "app.js"), "utf8");
  const sendError = app.slice(app.indexOf("function sendErrorText"), app.indexOf("function sendErrorText") + 2000);
  assert.match(sendError, /code === "DUPLICATE_MESSAGE"/);
  assert.match(sendError, /已经在队列里了/);
  assert.doesNotMatch(sendError.slice(sendError.indexOf("DUPLICATE_MESSAGE"), sendError.indexOf("DUPLICATE_MESSAGE") + 300), /already queued or in flight/);
});

test("Grok 上游失败但原生 session 已保留时优先允许继续当前会话", async () => {
  const app = await readFile(resolve(publicRoot, "app.js"), "utf8");
  const failure = app.slice(app.indexOf("function failedRunResumableOwner"), app.indexOf("function runDiffButtonMarkup"));
  assert.match(failure, /const sessionMap = runSessionsMap\(run\)/);
  assert.match(failure, /run\.executionOwnerId/);
  assert.match(failure, /attempt\?\.protocol === "grok-headless-resume" \? attempt\.sessionResumable === true : true/);
  assert.match(failure, /failedRunResumableOwner\(run, sessionMap\)/);
  assert.match(failure, /data-focus-failed-session/);
  assert.match(failure, /继续当前会话/);
  assert.match(failure, /以同一任务重新发起/);
  const clickHandler = app.slice(app.indexOf('const failedSession = event.target.closest("[data-focus-failed-session]")'));
  assert.match(clickHandler.slice(0, 400), /selectComposerTarget\(failedSession\.dataset\.focusFailedSession, \{ focusInput: true \}\)/);
});

test("HTTP 续聊强制 waitForTurn=false，客户端不能把同步等待塞回来", async () => {
  const server = await readFile(resolve(publicRoot, "../server.mjs"), "utf8");
  const handler = server.slice(server.indexOf("/(cancel|interrupt|messages)"));
  assert.match(handler, /delete input\.waitForTurn/);
  assert.match(handler, /waitForTurn: false/);
});

test("侧边聊天在提交在途时明确告知并清空草稿，不留下诱导重发的旧文本", async () => {
  const app = await readFile(resolve(publicRoot, "app.js"), "utf8");
  const handler = app.slice(app.indexOf('byId("mission-side-chat-form")?.addEventListener("submit"'));
  const body = handler.slice(0, handler.indexOf("});") + 3);
  assert.match(body, /if \(composerSubmitInFlight \|\| attachmentUploadInFlight\(\)\) return toast\(/);
  assert.match(body, /sideInput\.value = "";/);
  // 清空必须发生在把草稿交给主提交路径之后
  assert.ok(body.indexOf('elements["submit-task-button"]?.click()') < body.indexOf('sideInput.value = "";'));
});
