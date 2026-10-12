/**
 * bot-ops-inbox-wiring.test.mjs — 会话协作收件箱（方案 B）的**接线门禁**。
 *
 * 为什么单独一道门禁：2026-09-11 的实测故障形态是——路由、API 客户端、渲染器、
 * HTML 挂载点四件套**全部就位**，但 app.js 只有 import、没有任何调用点，
 * 面板永远 hidden。这种「读起来像功能、实际零消费者」的缺口不会让任何单测变红，
 * 所以必须由静态断言把「谁调用谁」钉死。命名出现的次数就是它的机械承载。
 *
 * 守六件事：
 *  1. HTML 挂载点存在（#bot-ops-inbox / -list / -count），且默认 hidden 不闪烁。
 *  2. app.js 对渲染器和取数函数是**调用**而非仅 import。
 *  3. renderBotOpsRail（右栏枢纽）同时挂了渲染与取数。
 *  4. botRenderAgent 触发 renderBotOpsRail —— 否则切换会话时旧会话待办会留在栏里。
 *  5. 失败/降级/取消/展开重取的机械承载。
 *  6. W6 实时层：SSE 事件 → 去抖 force 刷新（2026-09-11）。事件闸收窄 + 只认当前会话
 *     + 视图闸——三条缺一，就会退回评审警告过的「每事件 32 次总线读」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

async function source(path) {
  return (await readFile(`${appRoot}/${path}`, "utf8")).replace(/\r\n/g, "\n");
}

/** 取一个顶层函数体（约定：函数以列 0 的 `}` 收尾，内部块均缩进）。 */
function functionBody(text, name) {
  const match = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(text);
  assert.ok(match, `app.js 中找不到函数 ${name} —— 函数被改名/删除时本门禁必须变红，不得静默跳过`);
  return match[0];
}

test("收件箱挂载点存在且默认隐藏（不闪空面板）", async () => {
  const html = await source("public/index.html");
  assert.match(html, /id="bot-ops-inbox"[^>]*\shidden/);
  assert.match(html, /id="bot-ops-inbox-list"[^>]*aria-live="polite"/);
  assert.match(html, /id="bot-ops-inbox-count"/);
});

test("app.js 调用（而非仅 import）收件箱的渲染器与取数函数", async () => {
  const app = await source("public/app.js");
  // import 行是裸标识符（无圆括号），带括号才说明真的被调用
  assert.match(app, /import \{[^}]*\bbotOpsInboxMarkup\b[^}]*\} from "\.\/modules\/bot-workspace-chrome\.js"/s);
  assert.match(app, /import \{[^}]*\bfetchBotInbox\b[^}]*\} from "\.\/modules\/bot-collab-api\.js"/s);
  assert.equal([...app.matchAll(/botOpsInboxMarkup\(/g)].length, 1, "渲染器必须恰好有一个调用点（多份渲染=第二真源）");
  assert.equal([...app.matchAll(/botOpsInboxCount\(/g)].length, 1, "计数必须走词典同源的 helper，不在 app.js 里另算一遍");
  assert.equal([...app.matchAll(/fetchBotInbox\(/g)].length, 1, "取数必须只有一条通路");
  // 挂载点必须由 app.js 查询，且 id 与 HTML 一致
  assert.match(app, /byId\("bot-ops-inbox"\)/);
  assert.match(app, /byId\("bot-ops-inbox-list"\)/);
});

test("右栏枢纽同时挂渲染与取数，会话切换时整面换归属", async () => {
  const app = await source("public/app.js");
  const rail = functionBody(app, "renderBotOpsRail");
  assert.match(rail, /renderBotOpsInbox\(\)/);
  assert.match(rail, /loadBotOpsInbox\(\)/);

  // 会话切换路径必须触达右栏枢纽：botRenderAgent ← botSelectMember / botOpenConversation / botOpenGroupConversation
  assert.match(functionBody(app, "botRenderAgent"), /renderBotOpsRail\(\)/);
  for (const caller of ["botSelectMember", "botOpenConversation", "botOpenGroupConversation"]) {
    assert.match(functionBody(app, caller), /botRenderAgent\(/, `${caller} 必须经 botRenderAgent 才能带来右栏换归属`);
  }
});

test("失败与降级路径的机械承载：清载荷、跨会话不串味、展开时重取", async () => {
  const app = await source("public/app.js");
  const load = functionBody(app, "loadBotOpsInbox");
  // 读失败必须清掉载荷并写明原因（旧载荷留着 = 把陈旧当新鲜）
  assert.match(load, /catch \(error\) \{[\s\S]*?payload: null,[\s\S]*?error: error\?\.message/);
  // 跨会话守卫：缓存归属不匹配一律当没有（不得拿别的会话的收件箱充数）
  assert.match(load, /botInboxCache\.conversationId === conversationId \? botInboxCache : null/);
  assert.match(functionBody(app, "renderBotOpsInbox"), /botInboxCache\.conversationId === conversationId \? botInboxCache : null/);
  // generation 守卫：晚到的旧响应不得覆盖新会话
  assert.match(load, /generation !== botInboxLoadGeneration/);
  // 「空结果也是结果」：只用 payload/error 判真值会让 null 载荷击穿守卫
  // （会话还没跑过 / 404 折叠 → 两项皆假 → 每次渲染重发一次注定 404 的 GET。烛审计 S1）
  assert.match(load, /if \(!force && cached && \(cached\.loading \|\| cached\.resolved\)\) return;/);
  assert.equal(
    [...load.matchAll(/resolved: true/g)].length,
    2,
    "成功与失败都必须标记 resolved——两者都表示「问过了」",
  );
  // signal 必须真的递进去：全链路（inbox.mjs → routes.mjs → bot-collab-api.js）都透传，
  // 唯独调用点不给 = 「意图没有机械承载」——读起来支持取消，实际零消费者。
  assert.match(load, /fetchBotInbox\(conversationId, \{ signal: controller\.signal \}\)/);
  // force 也得先作废在途请求，否则反复开合叠加并发（generation 只保证最后写入的赢，拦不住流量）
  assert.match(load, /botInboxAbort\?\.abort\(\)[\s\S]*new AbortController\(\)/);
  // 主动取消不是故障，显示成「读取失败」是另一种假话
  assert.match(load, /error\?\.name === "AbortError"[\s\S]*return/);
  // details 的 toggle 不冒泡，必须挂元素本身；展开时重取，不让用户对着陈旧待办做决定
  assert.match(functionBody(app, "bindBotWorkspaceFolds"), /bot-ops-inbox[\s\S]*addEventListener\("toggle"[\s\S]*loadBotOpsInbox\(\{ force: true \}\)/);
});

test("W6 实时层：SSE 相关事件必须通向去抖刷新，且闸门三条齐全", async () => {
  const app = await source("public/app.js");

  // 一、事件闸存在且收窄：只放行 ask 生命周期的两个来源（总线消息 / 编排器等待态）。
  // 事件集扩大 = 更多 readTail 总线读，必须是有意为之的改动，不能顺手加。
  assert.match(app, /BOT_INBOX_PUSH_EVENTS = \/\^\(\?:bus\\\.\(\?:appended\|routed\)\|run\\\.\(\?:waiting_input\|recovery_required\)\)\$\//);

  // 二、pushEvent 必须真的接了这根管（runId 存在且命中事件集才调度）。
  // 「造了东西没人用」的本日第三次教训：函数在、线没接，任何单测都不会红。
  const push = functionBody(app, "pushEvent");
  assert.match(push, /if \(event\.runId && BOT_INBOX_PUSH_EVENTS\.test\(event\.type\)\) scheduleBotInboxRefreshForRun\(event\.runId\);/);

  // 三、调度器的三条闸门缺一不可：
  const schedule = functionBody(app, "scheduleBotInboxRefreshForRun");
  assert.match(schedule, /conversation\.activeRunId[\s\S]*runIds/, "必须只认当前会话（后台会话的 ask 不打这根管）");
  assert.match(schedule, /if \(botInboxPushTimer\) return;/, "必须去抖合并——一串事件一次刷新");
  assert.match(schedule, /state\.view !== "bot"\) return;/, "去抖到期必须复检视图，别在别的页签白跑总线读");
  assert.match(schedule, /loadBotOpsInbox\(\{ force: true \}\)/);
});
