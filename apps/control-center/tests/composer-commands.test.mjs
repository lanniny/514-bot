import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  bindClipboardImagePaste,
  queueClipboardImageUploads,
} from "../public/modules/clipboard-attachments.js";

const publicRoot = resolve(import.meta.dirname, "../public");

function extractFunction(source, name, nextMarker) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const end = source.indexOf(nextMarker, start);
  assert.notEqual(end, -1, `missing end marker after ${name}: ${nextMarker}`);
  return source.slice(start, end);
}

/** 与 config-topology-state 同思路：刮出纯函数源码，注入依赖后执行。 */
async function loadAppFunction(name, nextMarker, dependencies = {}, extraSource = "") {
  const app = await readFile(resolve(publicRoot, "app.js"), "utf8").then((text) => text.replace(/\r\n/g, "\n"));
  const body = extractFunction(app, name, nextMarker);
  const names = Object.keys(dependencies);
  const factory = new Function(...names, `${extraSource}${body}\nreturn ${name};`);
  return factory(...names.map((key) => dependencies[key]));
}

test("composer slash: continue mode keeps runtime commands for hot-change", async () => {
  const [app, slashModule] = await Promise.all([
    readFile(resolve(publicRoot, "app.js"), "utf8").then((text) => text.replace(/\r\n/g, "\n")),
    readFile(resolve(publicRoot, "modules/slash-menu.js"), "utf8").then((text) => text.replace(/\r\n/g, "\n")),
  ]);
  const section = extractFunction(slashModule, "slashCommandsForContext", "function hideSlashMenu");
  // 续聊不再短路成本地命令：模型/Effort/权限热改经 change → applyRunControlChange PATCH /controls
  assert.doesNotMatch(section, /if\s*\(\s*continuing\s*\)\s*return/);
  assert.match(section, /fallbackRuntimeSlashCommands/);
  assert.match(section, /applyRuntimeSlashControl/);
  assert.match(app, /LOCAL_SLASH_COMMANDS[\s\S]{0,1200}id:\s*"stop"[\s\S]{0,200}interruptSelectedRun/);
});

test("composer slash: Codex-parity commands all have real entries", async () => {
  const app = await readFile(resolve(publicRoot, "app.js"), "utf8").then((text) => text.replace(/\r\n/g, "\n"));
  const block = app.slice(app.indexOf("const LOCAL_SLASH_COMMANDS"), app.indexOf("function applyRuntimeSlashControl"));
  // 14 条 Codex 对标命令必须注册
  for (const id of ["new", "clear", "stop", "resume", "rename", "archive", "diff", "copy",
    "permissions", "status", "mcp", "skills", "hooks", "memories", "review", "init"]) {
    assert.match(block, new RegExp(`id:\\s*"${id}"`), `missing /${id}`);
  }
  // 每条都接线到真实函数/表面，不许挂空占位
  const wiring = [
    [/enterNewTaskComposer\(\)/, "/new"],
    [/applyComposerDraft\(state\.composerNewTaskDraft\)/, "/clear"],
    [/interruptSelectedRun\(\)/, "/stop"],
    [/selectRun\(target\.id\)/, "/resume"],
    [/await renameRun\(run\)/, "/rename"],
    [/patchRunMeta\(run\.id,\s*\{ archived: true \}/, "/archive"],
    [/conversationHeader\.toggleRunDiff\(run\.id\)/, "/diff"],
    [/navigator\.clipboard\.writeText\(last\.innerText/, "/copy"],
    [/setPermissionMenuOpen\(true\)/, "/permissions"],
    [/setComposerCliOpen\(true\)/, "/status"],
    [/setCapabilityWorkspace\("mcp"/, "/mcp"],
    [/setCapabilityWorkspace\("skills"/, "/skills"],
    [/configSurface:\s*"hooks"/, "/hooks"],
    [/setView\("memory"\)/, "/memories"],
    [/prefillComposerPrompt\(/, "/review + /init"],
  ];
  for (const [pattern, name] of wiring) assert.match(block, pattern, `${name} not wired`);
  // 预填保护：非空输入不许被覆盖
  const prefill = extractFunction(app, "prefillComposerPrompt", "const LOCAL_SLASH_COMMANDS");
  assert.match(prefill, /textarea\.value\.trim\(\)/);
});

test("composer mention: query allows inner spaces for multi-word member labels", async () => {
  const mentionModule = await readFile(resolve(publicRoot, "modules/mention-menu.js"), "utf8").then((text) => text.replace(/\r\n/g, "\n"));
  const fnStart = mentionModule.indexOf("function mentionQueryAtCursor(textarea)");
  const fnEnd = mentionModule.indexOf("\n  function syncMentionActiveOption", fnStart);
  const fnBody = mentionModule.slice(fnStart, fnEnd);
  const mentionQueryAtCursor = new Function(`${fnBody}\nreturn mentionQueryAtCursor;`)();
  const textarea = (value, caret = value.length) => ({ value, selectionStart: caret });
  // 多词标签 "@Grok 搜索" 的前缀阶段都能保持查询
  assert.deepEqual(mentionQueryAtCursor(textarea("@Grok 搜")), { start: 0, end: 7, query: "grok 搜" });
  assert.deepEqual(mentionQueryAtCursor(textarea("请 @Kimi 前")), { start: 2, end: 9, query: "kimi 前" });
  assert.equal(mentionQueryAtCursor(textarea("普通文本")), null);
});

test("composer paste: mixed text+image keeps both sides", async () => {
  const listeners = new Map();
  const input = {
    value: "前文",
    selectionStart: 2,
    selectionEnd: 2,
    setRangeText(text, start, end) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
      this.selectionStart = this.selectionEnd = start + text.length;
    },
    dispatchEvent() {},
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener() {},
  };
  const images = [];
  bindClipboardImagePaste(input, (files) => { images.push(files); });
  let prevented = false;
  listeners.get("paste")({
    clipboardData: {
      items: [{ kind: "file", type: "image/png", getAsFile: () => ({ type: "image/png", size: 10 }) }],
      getData: (type) => (type === "text/plain" ? "贴文字" : ""),
    },
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(images.length, 1, "image side uploaded");
  assert.equal(input.value, "前文贴文字", "text side inserted at caret");
});

test("composer attachments: failed uploads do not consume quota", async () => {
  const context = { attachments: [], uploads: [] };
  const failUpload = async () => {
    throw Object.assign(new Error("boom"), { code: "UPLOAD_FAILED" });
  };
  const first = await queueClipboardImageUploads({
    files: Array.from({ length: 8 }, (_, index) => ({ type: "image/png", size: 10, name: `f${index}` })),
    context,
    upload: failUpload,
    onChange: () => {},
  });
  assert.equal(first.failed, 8);
  assert.equal(first.rejected, 0);
  // 全部失败后仍可接受新粘贴：失败项不再占 8 个配额
  const second = await queueClipboardImageUploads({
    files: [{ type: "image/png", size: 10, name: "new" }],
    context,
    upload: async () => ({ path: "/store/new.png", claimToken: "t" }),
    claim: async () => {},
    onChange: () => {},
  });
  assert.equal(second.rejected, 0, "failed uploads freed capacity");
  assert.equal(second.saved, 1);
  assert.equal(context.attachments.length, 1);
  assert.equal(context.uploads.filter((item) => item.status === "error").length, 8, "failed chips preserved for retry");
});

test("kimi adapter: hard failures declare native turn settled for auto-recovery", async () => {
  const { KimiCliAdapter } = await import("../src/adapters/kimi-cli.mjs");
  const failingRun = async () => ({ code: 1, stdout: "", stderr: "kimi exploded" });
  const adapter = new KimiCliAdapter({ cwd: process.cwd(), runProcessImpl: failingRun });
  const events = [];
  await assert.rejects(
    () => adapter.send({
      prompt: "hi",
      sessionId: "session_existing",
      runId: "run-1",
      onSessionStarted: () => {},
      onTurnSubmitting: () => {},
      eventSink: events,
    }).catch((error) => {
      assert.equal(error.nativeTurnSettled, true);
      assert.equal(error.interruptConfirmed, true);
      assert.equal(error.sessionResumable, true, "existing session stays resumable");
      throw error;
    }),
    /kimi exploded/,
  );
});

test("kimi adapter: process timeout marks settled and keeps session resumable", async () => {
  const { KimiCliAdapter } = await import("../src/adapters/kimi-cli.mjs");
  const timeoutRun = async () => {
    throw Object.assign(new Error("process timed out"), { code: "PROCESS_TIMEOUT" });
  };
  const adapter = new KimiCliAdapter({ cwd: process.cwd(), runProcessImpl: timeoutRun });
  await assert.rejects(
    () => adapter.send({
      prompt: "hi",
      sessionId: "session_existing",
      runId: "run-2",
      onSessionStarted: () => {},
      onTurnSubmitting: () => {},
    }),
    (error) => error.code === "PROCESS_TIMEOUT"
      && error.nativeTurnSettled === true
      && error.interruptConfirmed === true
      && error.sessionResumable === true,
  );
});

test("composer native passthrough: unmatched slash commands fail closed unless the member catalog allows them", async () => {
  const [app, slashModule] = await Promise.all([
    readFile(resolve(publicRoot, "app.js"), "utf8").then((text) => text.replace(/\r\n/g, "\n")),
    readFile(resolve(publicRoot, "modules/slash-menu.js"), "utf8").then((text) => text.replace(/\r\n/g, "\n")),
  ]);
  const renderSlash = extractFunction(slashModule, "renderSlashMenu", "function applySlashCommand");
  assert.match(renderSlash, /native-passthrough/);
  assert.match(renderSlash, /native-unsupported/);
  assert.match(renderSlash, /当前成员不支持这条原生命令/);
  const applySlash = extractFunction(slashModule, "applySlashCommand", "return {");
  assert.match(applySlash, /command\.native/);
  assert.match(applySlash, /state\.pendingNativeCommand = true/);
  assert.match(app, /message\.nativeCommand = true/);
  assert.match(app, /catalogMatchesMember/);
  assert.match(app, /catalog\?\.context\?\.memberId === agentId/);
  assert.match(app, /原生命令需要在一个已有会话中执行/);
  assert.match(app, /state\.pendingNativeCommand = false/);
  const stateSource = await readFile(resolve(publicRoot, "state.js"), "utf8");
  assert.match(stateSource, /pendingNativeCommand: false/);
});

test("run CLI handoff: one-key jump from UI to the live native CLI terminal", async () => {
  const [app, html, tabsModule] = await Promise.all([
    readFile(resolve(publicRoot, "app.js"), "utf8").then((text) => text.replace(/\r\n/g, "\n")),
    readFile(resolve(publicRoot, "index.html"), "utf8"),
    readFile(resolve(publicRoot, "modules/conversation-tabs.js"), "utf8").then((text) => text.replace(/\r\n/g, "\n")),
  ]);
  // 会话头按钮 + 快捷键 + /cli 命令三个入口都指到同一条链路
  assert.match(html, /id="run-cli-terminal-button"/);
  const handoff = extractFunction(app, "openRunCliTerminal", "/** 一键同步本机配置");
  assert.match(handoff, /\/cli-terminal/);
  assert.match(handoff, /result\?\.busy/, "warns when a turn is in flight");
  // 沉浸接续（LO 2026-08-17）：主列整体罩层变终端，不是只开底部抽屉；罩层已开再触发=收回
  assert.match(handoff, /closeCliImmersiveIfOpen\(\)/);
  assert.match(handoff, /forge:cli-immersive-open/);
  assert.match(app, /getElementById\("cli-immersive"\)/);
  assert.match(app, /forge:cli-immersive-close/);
  // 成员页签（同日追加）：handoff 把服务端全成员清单补展示名后随事件下发；罩层按成员切换/懒启动
  assert.match(handoff, /result\?\.members/);
  assert.match(handoff, /agentLabel\(member\.agentId\)/);
  assert.match(handoff, /activeAgentId: result\?\.spec\?\.agentId/);
  // 罩层宿主不在当前视图 → 切回 514 Bot 重开；CLI 会话不回底部抽屉（抽屉只放纯 shell）
  assert.match(handoff, /setView\("bot"/);
  assert.doesNotMatch(handoff, /\[data-view="workbench"\]/);
  assert.doesNotMatch(handoff, /openBottomTerminal\(\)/);
  // 切换会话页 / 新建任务都要收起罩层（罩层只属于它打开时的那条会话）
  const activate = extractFunction(tabsModule, "activateTab", "function closeTab");
  assert.match(activate, /closeCliImmersiveIfOpen\(\)/);
  assert.match(app, /function enterNewTaskComposer[\s\S]{0,260}?closeCliImmersiveIfOpen\(\)/);
  const panel = await readFile(resolve(publicRoot, "terminal-panel.js"), "utf8").then((text) => text.replace(/\r\n/g, "\n"));
  assert.match(panel, /export function openImmersiveTerminal/);
  assert.match(panel, /export function closeImmersiveTerminal/);
  assert.match(panel, /forge:cli-immersive-open/);
  // 罩层面板只挂指定会话（不列全量、不自起新 shell、不给裸 shell 入口）；dispose 断全局监听+释放 tab
  assert.match(panel, /fixedSessions/);
  assert.match(panel, /allowSpawn/);
  assert.match(panel, /onAllClosed/);
  assert.match(panel, /removeEventListener\("forge:pty-session-created"/);
  // 成员条：面板暴露 attach/activate/close/activeTabId 给罩层驱动；懒启动走 /cli-terminal 按 agentId 起 PTY
  assert.match(panel, /attach: attachSession/);
  assert.match(panel, /activate: activateTab/);
  assert.match(panel, /activeTabId/);
  assert.match(panel, /cli-member-chip/);
  assert.match(panel, /spawnMemberCli/);
  // 成员页签点名懒启动走严格模式：点名落空如实报错，不静默回落到别人的会话
  assert.match(panel, /strict: true/);
  // 通用面板（底部抽屉/终端视图）过滤 CLI 接续会话：下侧栏终端只显示项目路径下的纯 shell
  assert.match(panel, /session\.kind === "cli"/);
  assert.match(panel, /session\?\.kind !== "cli"/);
  // 双击 Esc 才收罩层：单按 Esc 透传给原生 TUI（opencode/claude 用它打断当前轮）
  assert.match(panel, /lastEscAt/);
  assert.match(panel, /双击 Esc 返回/);
  // 冷启动提示是罩层浮动 chip（不是 term.write——会被 TUI 清屏抹掉），首块输出到达即撤下
  assert.match(panel, /onFirstChunk/);
  assert.match(panel, /cli-immersive-boot/);
  // 服务端幂等：同一 run 同一席位复用在途 PTY，不重复 spawn 抢同一原生会话文件
  const serverSource = await readFile(resolve(publicRoot, "..", "server.mjs"), "utf8").then((text) => text.replace(/\r\n/g, "\n"));
  assert.match(serverSource, /dedupeKey: `run-cli:/);
  // 服务端：CLI 会话打 kind 标记 + 响应带全成员可接续清单
  assert.match(serverSource, /kind: "cli"/);
  assert.match(serverSource, /interactiveCliSpecsForRun\(run\)/);
  const wavegCss = await readFile(resolve(publicRoot, "forge", "waveg.css"), "utf8");
  assert.match(wavegCss, /\.cli-immersive \{/);
  assert.match(wavegCss, /\.cli-immersive-boot \{/);
  assert.match(wavegCss, /\.cli-member-chip \{/);
  assert.match(wavegCss, /\.cli-immersive \.terminal-tabs \{ display: none/);
  assert.match(app, /id:\s*"cli",\s*label:\s*"\/cli"/);
  assert.match(app, /event\.key === "o" \|\| event\.key === "O"/);
  assert.match(app, /run-cli-terminal-button"\]\?\.addEventListener\("click", \(\) => void openRunCliTerminal\(\)\)/);
  // 按钮启停跟原生会话存在性走（历史会话也能接续）
  assert.match(app, /run-cli-terminal-button"\]?\??\.disabled = Object\.keys\(run\.sessions \|\| \{\}\)\.length === 0/);
  // 深润（烛 2026-08-17 二轮）：CLI 退出/页签关闭 → 成员条映射同步还原，不留指向死会话的僵尸 chip
  assert.match(panel, /onSessionExited/);
  assert.match(panel, /onTabClosed/);
  assert.match(panel, /pruneMemberTab/);
  // dedupe 命中的 toast 说"接回仍在运行的"，与新开区分
  assert.match(handoff, /reused === true/);
  // 错误消息分清两种落空：没会话 vs 该 CLI 无 resume 通道——不能一律让人"先聊一轮"
  assert.match(serverSource, /hasNativeSessions/);
  assert.match(serverSource, /没有已验证的 resume 通道/);
  assert.match(serverSource, /先至少完成一轮对话/);
  // 启动提示粘性（等首块输出撤），失败提示 8s 自撤——错误等不来输出块
  assert.match(panel, /sticky: true/);
  assert.match(panel, /bootToken/);
  // 三轮收尾：状态徽标三态着色；未具名活跃态（queued/executing/…）兜底为"在途"而非误报"空闲"
  assert.match(panel, /cli-run-status/);
  assert.match(panel, /ACTIVE_RUN_STATES\.has\(run\?\.status\)/);
  // 系统终端是迁移语义不是分身：外部窗口起成功后收掉罩层内同名 PTY，不双写同一原生会话
  assert.match(panel, /cli-immersive-external/);
  assert.match(panel, /strict: true, external: true/);
  // 键盘循环：Ctrl+Alt+PgUp/PgDn 只在已接续页签间走（少于两页透传），不触发懒启动
  assert.match(panel, /PageDown/);
  assert.match(wavegCss, /\.cli-run-status\.is-busy/);
  assert.match(wavegCss, /\.cli-run-status\.is-idle/);
});
