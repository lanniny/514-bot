/**
 * assistant-wiring.test.mjs — 桌面助手 A1–A5 的**接线门禁**。
 *
 * 为什么单独一道门禁（第二次了）：2026-09-11 的会话收件箱已经证明过一次——
 * 路由、API 客户端常量、渲染器、HTML 挂载点四件套全部就位，但 `public/app.js`
 * 只有 import、没有任何调用点，面板永远 hidden，而**没有任何单测会变红**
 * （见 tests/bot-ops-inbox-wiring.test.mjs 的卷首语）。当时的结论是"必须由静态
 * 断言把谁调用谁钉死"。
 *
 * 2026-09-18 原样复发：`public/api.js` 里 8 条 assistant/checkpoint/distill 路由
 * 全有常量，`public/app.js` 与 `public/modules/*.js` 里一条都没被调用过；
 * `data-bot-distill-workflow` 按钮渲染了但没有任何点击处理器；
 * `chatMemoryPrompt` 只有 adapter 在读、全仓没有一个写入方。
 * 本文件把这几条线钉死：删掉任何一处调用，这里必红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

async function source(path) {
  return (await readFile(`${appRoot}/${path}`, "utf8")).replace(/\r\n/g, "\n");
}

/** 前端「真实调用面」= public/ 下除 api.js 以外的所有 js（api.js 只是常量表）。 */
async function frontendCallSurface() {
  const dir = `${appRoot}/public/modules`;
  const names = (await readdir(dir)).filter((name) => name.endsWith(".js"));
  const modules = await Promise.all(names.map((name) => source(`public/modules/${name}`)));
  return (await source("public/app.js")) + "\n" + modules.join("\n");
}

test("A4/A5 的 API 常量必须有真实调用点，而不是只躺在 api.js 里", async () => {
  const surface = await frontendCallSurface();
  const declarations = await source("public/api.js");

  // 本波真正接上的线。A4 的 checkpoints/evidence-matrix/deliverable 三个独立端点
  // 当前没有独立 UI（它们经结算卡聚合展示），属于"后端有、前端不调"的**已知**
  // 状态，登记在 src/api-contract.mjs 的 KNOWN_UI_LESS 里，由 api:audit 管，
  // 不在这里假装已接线。
  for (const constant of [
    "assistantResidence",
    "assistantHeartbeat",
    "assistantDismissHint",
    "assistantResumeRun",
    "runDistillWorkflow",
  ]) {
    assert.match(declarations, new RegExp(`\\b${constant}:`), `api.js 里没有 ${constant} —— 名字写错了`);
    assert.ok(
      new RegExp(`\\bAPI\\.${constant}\\b`).test(surface),
      `${constant} 只有声明没有调用：路由在、能力在、UI 上没有入口`,
    );
  }
});

test("沉淀为工作流：按钮渲染与点击处理必须成对存在", async () => {
  const [app, settlement] = await Promise.all([
    source("public/app.js"),
    source("public/modules/bot-settlement.js"),
  ]);

  // 渲染侧：按钮带 data 属性（能力本体的可见入口）
  assert.match(settlement, /data-bot-distill-workflow=/);

  // 处理侧：定义 + 至少一处委托分支（两处委托：view-bot 与 bot-collab-panel）
  assert.match(app, /async function botDistillWorkflowFromRun\(/);
  const calls = [...app.matchAll(/botDistillWorkflowFromRun\(/g)].length;
  assert.ok(calls >= 3, `期望定义 + 两处委托调用，实际出现 ${calls} 次`);
  assert.match(app, /closest\("\[data-bot-distill-workflow\]"\)/);

  // 不得静默直存：草稿必须经用户确认（saveAsRoutine 显式传 false）
  assert.match(app, /saveAsRoutine: false/);

  // 预填走 routine 表单，且开放 prefill 通道
  const panel = await source("public/modules/bot-routines-panel.js");
  assert.match(panel, /export function openRoutineDialog\(dialog, \{ draft = null \} = \{\}\)/);
  assert.match(panel, /function applyRoutineDraft\(/);
});

test("A5 会话驻留：挂载点存在、默认隐藏、渲染器被调用、失败不假装有数据", async () => {
  const [html, app] = await Promise.all([source("public/index.html"), source("public/app.js")]);

  assert.match(html, /id="bot-residence-hints"[^>]*\shidden/, "挂载点必须默认 hidden，否则首帧闪空条");
  assert.match(html, /id="bot-residence-hints"[^>]*aria-label="上次会话恢复提示"/);

  // 渲染器：import 是裸标识符，带括号才算调用
  assert.match(app, /import \{ residenceRecoveryMarkup \} from "\.\/modules\/residence-recovery\.js"/);
  assert.equal([...app.matchAll(/residenceRecoveryMarkup\(/g)].length, 1, "渲染器只能有一个调用点");

  // 取数必须挂到会话渲染路径上（否则加载函数存在但永不执行）
  const render = /function botRenderAgent\([^)]*\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.ok(render, "找不到 botRenderAgent —— 改名时本门禁必须变红");
  assert.match(render, /loadBotResidenceHints\(\)/);
  assert.match(render, /botResidenceHeartbeat\(\)/);

  // 心跳必须节流：每渲染一次打一次 HTTP = 按键级流量
  const load = /async function loadBotResidenceHints\([\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.match(load, /if \(botResidenceHintsLoaded && !force\) return;/);
  assert.match(load, /generation !== botResidenceGeneration/, "晚到的旧响应不得覆盖新状态");
  const heartbeat = /function botResidenceHeartbeat\([\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.match(heartbeat, /BOT_RESIDENCE_HEARTBEAT_MS/);
  assert.match(heartbeat, /botResidenceHeartbeatAt/, "节流必须有时间锚点");

  // 文案不得承诺续跑（服务端 claimRecoveryHint 只导航、不重放）。
  // 注意只断言**渲染出来的文案**，不要去 match 源码里那句"绝不能写恢复执行"的注释。
  const recovery = await source("public/modules/residence-recovery.js");
  assert.match(recovery, /data-bot-residence-open=/);
  assert.match(recovery, />回到会话</);
  assert.match(recovery, /data-bot-residence-dismiss=/);
  assert.match(recovery, />忽略</);
  assert.match(recovery, /回到会话只是导航——上一步不会自动重跑/);
});

test("A5 长期记忆：写入方（orchestrator）与消费方（adapter）必须同时存在", async () => {
  const [orchestrator, adapter, history] = await Promise.all([
    source("src/orchestrator.mjs"),
    source("src/adapters/api-chat.mjs"),
    source("src/api-chat-history.mjs"),
  ]);

  // 消费侧本来就存在：adapter 读 input.chatMemoryPrompt，history 落成 system 消息
  assert.match(adapter, /input\.chatMemoryPrompt/);
  assert.match(history, /memoryPrompt/);

  // 生产侧：这才是缺失了很久的那一半
  assert.match(orchestrator, /this\.assistantMemory = assistantMemory/);
  assert.match(orchestrator, /getPromptChunk\(\)/);
  assert.match(orchestrator, /chatMemoryPrompt: memoryPrompt/);

  // 顺序纪律：记忆必须先取到、并和有记忆的校验同源，
  // 否则"先校验后注入"会把超限推迟到 adapter（提交后才失败）。
  const memoryAt = orchestrator.indexOf("await this.assistantMemory.getPromptChunk()");
  const admitAt = orchestrator.indexOf("apiChatRequestMessages(chatMessages, memberPrompt || \"\", memoryPrompt)");
  assert.ok(memoryAt > 0 && admitAt > 0, "找不到记忆取用或准入校验");
  assert.ok(memoryAt < admitAt, "记忆必须在准入校验之前取到并一起校验");
});

test("来源卡片 URL 判据只有一份实现，内联那份必须已删除", async () => {
  const app = await source("public/app.js");

  assert.match(app, /import \{ validateClientWebUrl \} from "\.\/modules\/web-evidence-url\.js"/);
  assert.match(app, /validateClientWebUrl\(/);
  // 旧内联判据的指纹：既漏 169.254/::1，又多拦全部 172.*
  assert.doesNotMatch(app, /host\.startsWith\("172\."\)/, "内联判据必须已被单一真源取代");
  assert.doesNotMatch(app, /host !== "localhost" && !host\.endsWith\("\.local"\)/);

  // 与实现一致的文案：没有取网就不许叫"网络来源证据"
  assert.match(app, /未经系统抓取核验/);
});
