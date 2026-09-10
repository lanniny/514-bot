import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

async function source(path) {
  // Windows 工作区源码是 CRLF：统一归一化为 LF，避免多行正则里的 \n 匹配不到（config-topology-state 同根因）
  return (await readFile(`${root}/${path}`, "utf8")).replace(/\r\n/g, "\n");
}

// LO 2026-08-10 严格归属制：团队树下只挂显式归属本团队的项目——此前"未归属在所有团队
// 可见"会让任何团队的树都被几十个历史项目灌满（LO：团队下面只应该显示其对应项目）。
// 08-08 的底线保留：未归属/失效归属的项目进「未归属」虚拟组兜底，不整片消失。
test("team tree is strict about ownership with an unassigned fallback group", async () => {
  const [app, css] = await Promise.all([source("public/app.js"), source("public/styles.css")]);
  assert.match(app, /function explicitProjectTeamId\(project\)/);
  assert.match(app, /return pref\.teamId && teamById\(pref\.teamId\) \? pref\.teamId : null;/);
  // 树过滤严格归属：只有显式归属本团队的项目进团队节点
  assert.match(app, /if \(explicitTeamId === selected\.id\) \{/);
  // 未归属与归属已失效团队（旧数据）的都进「未归属」虚拟组兜底——不消失
  assert.match(app, /explicitTeamId === null \|\| !knownTeamIds\.has\(explicitTeamId\)\) \{\s*\n\s*unassignedProjects\.push\(project\);/);
  assert.match(app, /const UNASSIGNED_TEAM_NODE_ID = "__unassigned__";/);
  assert.match(app, /function unassignedNodeMarkup\(projects\)/);
  assert.match(app, /if \(!projects\.length\) return "";/, "未归属组为空时不渲染");
  // 创建任务选了目录：未归属项目自动归属创建团队（已归属他团队的不抢）
  assert.match(app, /function assignCwdProjectToTeam\(cwd, teamId\)/);
  assert.match(app, /if \(!project \|\| explicitProjectTeamId\(project\) !== null\) return;/);
  assert.match(app, /if \(submission\.cwd && !botSubmission\?\.ephemeralTeam\) assignCwdProjectToTeam\(submission\.cwd, composerTarget\.teamId \|\| state\.selectedTeamId\);/);
  // 分组视觉压暗；旧的行级"未归属"徽标已随混显语义一起退役
  assert.match(css, /\.is-unassigned-team > \.project-row \.team-toggle \{/);
  assert.ok(!app.includes("unassigned-badge"), "行级未归属徽标还在渲染路径上");
  assert.ok(!app.includes('class="project-empty">无从属项目'), "旧的「无从属项目」兜底文案仍在渲染路径上");
});

// 烛侧栏审查 2026-08-16：置顶/归档分区与项目树的互斥与兜底纪律——
// H1 未归属项目/会话置顶后不得从侧栏消失；M1 pinned+interrupted 只进「正在工作」不双列；
// M2 置顶会话只进置顶区、树中不重复渲染；M3 团队块折叠由 team-tree-toggle 单管并持久化；
// L6 折叠按钮不得吞 heading 语义（button 内 h2 → span[role=heading]）。
test("pinned and archived rail sections share the tree's unassigned fallback discipline", async () => {
  const [app, chrome, html, railMeta] = await Promise.all([
    source("public/app.js"),
    source("public/workbench-chrome.js"),
    source("public/index.html"),
    source("public/modules/rail-meta-sections.js"),
  ]);
  // M1：interrupted 归「正在工作」区，pinned 的 interrupted 不再双列双计数
  assert.match(railMeta, /const pinnedRuns = getRuns\(\)\.filter\(\s*\(run\) => !run\.archived && run\.pinned && !ACTIVE_RUN_STATES\.has\(run\.status\) && run\.status !== "interrupted"/);
  // H1：置顶/归档分区的团队过滤与树「未归属」兜底同律（显式归属命中本团队或未归属 null 都收）
  assert.match(app, /inRailTeam: \(explicitTeamId\) => explicitTeamId === railTeamId\(\) \|\| explicitTeamId === null/);
  assert.match(railMeta, /return pref\.pinned && !pref\.hidden && inRailTeam\(explicitProjectTeamId\(project\)\);/);
  // M2：置顶会话只进置顶区——树内会话过滤排除 pinned（项目普通组与跨团队 loose 组同律）
  assert.match(app, /&& !pref\.pinned \/\/ 置顶会话只进置顶区/);
  assert.match(app, /!pref\.archived && !pref\.pinned\) \{/);
  // M3：团队块折叠单控件单状态源——chrome 分组折叠不再注入 team 条目；toggle 持久化到同 key
  assert.ok(!chrome.includes('selector: ".rail-block-team"'), "workbench-chrome 仍在给团队块注入第二套折叠 chevron");
  assert.match(app, /applyTeamTreeCollapsed/);
  assert.match(app, /514cc-rail-groups/);
  // L6：折叠按钮不再吞 heading 语义
  assert.ok(!html.includes('<h2 id="team-rail-title">'), "team-tree-toggle 内仍是 h2");
  assert.match(html, /<span class="pane-title" id="team-rail-title" role="heading" aria-level="2">/);
  assert.match(html, /<span class="pane-title" id="archived-rail-title" role="heading" aria-level="2">/);
});

// LO 2026-08-16「编辑历史对话返回上一个对话继续编辑」：用户消息 hover 铅笔 → 原文回填 composer →
// 编辑后发送走既有 /messages 续聊（EventStore/turns append-only、CLI 原生会话不可回滚，不改写历史）。
// 入口复用 workbench-chrome 行操作钮机制（复制钮同款注入），经 CustomEvent 桥回 app.js（chrome 无 state 通道）。
// 护栏：priorDraft 取消恢复；文本不全（服务端只给声明长度）不回填残文；切 run/预览自动退出编辑态。
test("a user message can be edited back into the composer as a follow-up", async () => {
  const [app, chrome, html, css, forgeCss, state, sprite] = await Promise.all([
    source("public/app.js"),
    source("public/workbench-chrome.js"),
    source("public/index.html"),
    source("public/styles.css"),
    source("public/forge/workbench.css"),
    source("public/state.js"),
    source("public/lucide-sprite.svg"),
  ]);
  // 入口：chrome 行操作注入——复制钮全行、编辑铅笔仅用户行；点击读 data-stream-key 经 CustomEvent 桥给 app.js
  assert.match(chrome, /if \(row\.classList\.contains\("is-user"\)\) \{/);
  assert.match(chrome, /editButton\.className = "msg-row-copy msg-row-edit";/);
  assert.match(chrome, /const streamKey = row\?\.dataset\.streamKey \?\? "";/);
  assert.match(chrome, /document\.dispatchEvent\(new CustomEvent\("514cc:edit-message", \{ detail: \{ streamKey \} \}\)\)/);
  assert.match(sprite, /<symbol id="lucide-pencil" /, "铅笔图标未进 lucide sprite");
  // 桥接与反查：app.js 监听 CustomEvent；反查限协作 run 流（历史预览/无选中 run 不给出），残文不回填
  assert.match(app, /document\.addEventListener\("514cc:edit-message", \(event\) => startEditMessage\(event\.detail\?\.streamKey\)\)/);
  assert.ok(!app.includes("data-edit-message"), "旧方案 data-edit-message 委托/属性仍有残留");
  assert.match(app, /if \(!run \|\| state\.sessionPreview \|\| !streamKey\) return null;/);
  assert.match(app, /historyMessagesForRun\(run, null, events\) : fallbackRunMessages\(run\)/);
  assert.match(app, /if \(message\.textLength && message\.textLength > message\.text\.length\) return null;/);
  // 编辑态生命周期：进入暂存草稿、取消恢复、发送成功终结、切 run/预览收敛
  assert.match(state, /editingMessage: null,/);
  assert.match(app, /function startEditMessage\(streamKey\)/);
  assert.match(app, /priorDraft: captureComposerDraft\(\)/);
  assert.match(app, /function exitEditMessage\(\{ restore = false \} = \{\}\)/);
  assert.match(app, /if \(restore\) applyComposerDraft\(editing\.priorDraft\);/);
  assert.match(app, /exitEditMessage\(\{ restore: false \}\); \/\/ 编辑态随发送成功终结/);
  assert.match(app, /state\.editingMessage && \(state\.sessionPreview \|\| state\.editingMessage\.runId !== \(run\?\.id \?\? null\)\)/);
  // Esc 取消（@// 菜单 Esc 优先）+ 取消按钮
  assert.match(app, /event\.key === "Escape" && !event\.isComposing && state\.editingMessage/);
  assert.match(app, /elements\["composer-editing-cancel"\]\?\.addEventListener\("click", \(\) => exitEditMessage\(\{ restore: true \}\)\)/);
  // DOM 与样式：composer 顶条（追加不改写语义）+ 铅笔与复制钮并排定位
  assert.match(html, /<div class="composer-editing-bar" id="composer-editing-bar" role="status" hidden>/);
  assert.match(css, /\.composer-editing-bar \{/);
  assert.match(forgeCss, /\.msg-row-edit \{\s*\n\s*right: 28px;\s*\n\}/);
});

// LO 2026-08-10：项目树内按逻辑会话聚合——Console run 的 sessions 映射（成员→原生会话 id）
// 是跨 CLI 唯一硬关联；被引用的原生会话按 run 分组挂在 CLI 分组之前。裸 CLI 会话不猜不并。
test("project tree aggregates native sessions by collaboration run", async () => {
  const [app, css] = await Promise.all([source("public/app.js"), source("public/styles.css")]);
  // 关联索引：run.sessions 数组/对象两形态都归一；过短 id 不收（防误匹配）
  assert.match(app, /function runSessionsMap\(run\)/);
  assert.match(app, /function runSessionLinkIndex\(\)/);
  assert.match(app, /if \(id\.length >= 8 && !index\.has\(id\)\) index\.set\(id, \{ run, memberId \}\);/);
  // 匹配：精确（kimi ses_*）+ 后缀（codex rollout 文件名尾巴是 thread uuid）
  assert.match(app, /if \(id\.endsWith\(rid\)\) return link;/);
  // 分组：run 组按最近活跃排序、挂在 CLI 组前；未关联会话仍走 CLI 分组（块化合成，供截断整块收编）
  assert.match(app, /sort\(\(a, b\) => runGroupLatestMs\(b\) - runGroupLatestMs\(a\)\)/);
  assert.match(app, /blocks\.push\(\.\.\.cliSessionGroupBlocks\(project, unlinked\)\);/);
  // Codex 式截断（LO 2026-08-11）：超 TREE_SESSIONS_CAP 的块折叠为「展开显示」行，点击进 showAllSessions 集合
  assert.match(app, /const TREE_SESSIONS_CAP = 6;/);
  assert.match(app, /state\.showAllSessions\.has\(project\.id\)/);
  assert.match(app, /data-sessions-showmore="\$\{escapeHtml\(project\.id\)\}"/);
  assert.match(app, /event\.target\.closest\("\[data-sessions-showmore\]"\)/);
  // 一致化（LO 2026-08-10）：组头与成员行点击都直接进 run 完整视图（与会话列表一致），
  // 不再落原生只读预览；仅独立 chevron 按钮折叠/展开成员列表（收起态内存记账）
  assert.match(app, /data-run-group-toggle="\$\{escapeHtml\(run\.id\)\}"/);
  assert.match(app, /state\.collapsedRunGroups\.has\(run\.id\)/);
  assert.match(app, /aria-expanded="\$\{!collapsed\}" aria-controls="\$\{escapeHtml\(membersId\)\}"/);
  assert.match(app, /class="run-group-toggle" type="button" data-run-group-toggle/);
  assert.match(app, /class="run-group-head\$\{selected \? " is-selected" : ""\}" type="button" data-run-select="\$\{escapeHtml\(run\.id\)\}"/);
  assert.match(app, /class="session-link run-member-link" type="button"\s*\n\s*data-run-select="\$\{escapeHtml\(run\.id\)\}"/);
  assert.match(app, /runMemberLabel\(run, memberId\)/);
  assert.match(app, /run\.teamRoster\?\.find\(\(member\) => member\?\.id === memberId\)\?\.label/);
  // 折叠委托：hidden 切换 + aria 同步，不做全量重渲染（保焦点纪律）
  assert.match(app, /event\.target\.closest\("\[data-run-group-toggle\]"\)/);
  assert.match(app, /if \(members\) members\.hidden = !wasCollapsed;/);
  // run 列表更新必须带动树内聚合翻页（commitMarkup 幂等，不抢焦点）
  assert.match(app, /railMetaSections\.render\(\);\s*\n\s*renderProjects\(\); \/\/ run\.sessions 变了/);
  // 样式
  for (const rule of [".run-group-toggle {", ".run-group-head {", ".run-group-head.is-selected {", ".run-member-chip {", ".run-session-row .session-link {", ".run-group-members {", '.run-group-toggle[aria-expanded="true"] .chevron {']) {
    assert.ok(css.includes(rule), `缺少样式 ${rule}`);
  }
});

// LO 2026-08-08 参考图波：右栏是工具标签栏（任务上下文/审阅/浏览器/文件），
// 终端回到底部抽屉由右上角图标开合，标签全关时露出工具选择列表。
test("the rail is a closable tool tab strip with a picker empty state", async () => {
  const [html, railTools, app] = await Promise.all([
    source("public/index.html"),
    source("public/rail-tools.js"),
    source("public/app.js"),
  ]);
  for (const id of ["rail-tabs", "rail-tab-add", "rail-tool-menu", "rail-tool-panels", "rail-tool-picker", "rail-empty-state"]) {
    assert.match(html, new RegExp(`id="${id}"`), `右栏缺少 ${id}`);
  }
  for (const panel of ["mission", "review", "terminal", "browser", "files"]) {
    assert.match(html, new RegExp(`data-tool-panel="${panel}"`), `缺少工具页 ${panel}`);
  }
  // 任务上下文页必须真的包住环境舱与五页，否则 514cc 的任务上下文会随改版丢失
  const missionPanel = html.slice(html.indexOf('data-tool-panel="mission"'), html.indexOf('data-tool-panel="review"'));
  assert.match(missionPanel, /id="mission-environment-panel"/);
  assert.match(missionPanel, /data-registry-tab="tasks"/);
  assert.match(missionPanel, /data-registry-tab="connections"/);
  // ➕ 菜单与空态选择器同源，避免"菜单有、空态没有"的漂移
  assert.match(railTools, /picker\.innerHTML = RAIL_TOOLS/);
  assert.match(railTools, /menu\.innerHTML = RAIL_TOOLS/);
  assert.match(app, /createRailTools\(\{/);
  assert.match(app, /createRailPanels\(\{/);
  // 换 run 不触发标签激活：每个 selectRun 出口都必须让当前工具页重新对账，否则审阅/文件会停在旧任务
  assert.match(app, /function syncRailToActiveRun\(\)/);
  const selectRunCalls = app.match(/missionControlDock\?\.selectRun\([^\n]*\);\n\s*syncRailToActiveRun\(\);/g) ?? [];
  const allSelectRun = app.match(/missionControlDock\?\.selectRun\(/g) ?? [];
  assert.equal(selectRunCalls.length, allSelectRun.length, "有 selectRun 出口没有同步右栏工具页");
  assert.match(railTools, /aria-controls=\"\$\{panelId\}\"/);
  assert.match(railTools, /panel\.setAttribute\("aria-labelledby", `rail-tab-\$\{id\}`\)/);
  assert.match(railTools, /event\.key === "ArrowRight" \|\| event\.key === "ArrowDown"/);
  assert.match(railTools, /event\.key === "Home"/);
  assert.match(railTools, /onActivate\?\.\(activeId\);/, "关闭最后一个标签也必须通知面板取消其在途工作");
  assert.match(app, /railPanels\?\.activate\(id\)/);
});

test("terminal drawer reveal cannot reopen after a close wins the race", async () => {
  const chrome = await source("public/workbench-chrome.js");
  assert.match(chrome, /let openGeneration = 0;/);
  assert.match(chrome, /const generation = \+\+openGeneration;/);
  assert.match(chrome, /if \(generation !== openGeneration \|\| !open\) return;/);
});

// 抽屉会在启动时恢复上次的打开态并立刻挂载，比 token 自举更早，
// 不等 apiReady 就发 /api/pty 会拿 401 并被渲染成「终端服务异常」。
test("terminal mount waits for token bootstrap and offers a retry", async () => {
  const [terminal, server] = await Promise.all([
    source("public/terminal-panel.js"),
    source("server.mjs"),
  ]);
  // 实际挂载体是 mountOnce（mount 只做串行化），token 自举必须在它的第一条语句上
  assert.match(terminal, /async function mountOnce\(\) \{\n(?:\s*\/\/[^\n]*\n)*\s*await apiReady;/);
  assert.match(terminal, /data-terminal-retry/);
  assert.match(terminal, /addEventListener\("click", \(\) => void mount\(\), \{ once: true \}\)/);
  // 错误文案来自后端，进 innerHTML 前必须转义
  assert.match(terminal, /escapeHtml\(String\(error\?\.message/);
  assert.match(terminal, /import \{ escapeHtml \} from "\.\/utils\.js"/);
  assert.match(await source("src/static-assets.mjs"), /"\/utils\.js": "utils\.js"/);
});

// LO 2026-08-08：打开终端后打不出字。输入失败被 `.catch(() => {})` 静默吞掉，
// 表象就是"终端坏了"；xterm 在隐藏容器里的焦点也会丢，重新展开后必须重新聚焦。
test("terminal input failures surface and focus is restored on reopen", async () => {
  const [terminal, chrome] = await Promise.all([
    source("public/terminal-panel.js"),
    source("public/workbench-chrome.js"),
  ]);
  // 只约束 input 一条路径：resize 失败不阻断可用性且高频，刻意不提示（见该处注释）
  const inputCall = terminal.slice(terminal.indexOf("term.onData("), terminal.indexOf("const observer = new ResizeObserver"));
  assert.ok(!inputCall.includes("catch(() => {})"), "输入失败仍被静默吞掉");
  assert.match(terminal, /\[输入未送达：/);
  assert.match(terminal, /tab\.inputBroken/);
  assert.match(terminal, /paneEl\.addEventListener\("mousedown", \(\) => term\.focus\(\)\)/);
  assert.match(terminal, /function focusActive\(\)/);
  // 返回面已扩展（沉浸罩层驱动）：dispose + attach/activate/close/activeTabId 供成员条切换
  assert.match(terminal, /return \{ mount, root, focusActive, dispose, attach: attachSession, activate: activateTab, close: closeTab, activeTabId \}/);
  assert.match(chrome, /panel\.focusActive\?\.\(\)/);
  // Nerd Font 候选：oh-my-posh 字形没有它会显示成方块
  assert.match(terminal, /Nerd Font/);
});

// LO 2026-08-08：打开终端看到同一份首屏重复很多条。每条 SSE 连接都会重放整个环形缓冲，
// 重复挂载/重复 attach 留下的残留订阅会把同一段输出一遍遍写进终端。
test("terminal mounting is idempotent so replayed buffers cannot stack", async () => {
  const terminal = await source("public/terminal-panel.js");
  // mount 串行化：抽屉展开、重试按钮、宿主自举都可能触发，不加锁会各自 spawn 一个 shell
  assert.match(terminal, /if \(mounting\) return mounting;/);
  assert.match(terminal, /mounting = mountOnce\(\)\.finally\(/);
  // 重挂载前释放旧订阅；同 id 重复 attach 先拆旧的
  assert.match(terminal, /for \(const tab of tabs\.values\(\)\) disposeTab\(tab\);\n\s*tabs\.clear\(\);/);
  assert.match(terminal, /const existing = tabs\.get\(session\.id\);\n\s*if \(existing\) \{\n\s*disposeTab\(existing\);/);
  // 关闭与重复挂载共用同一条释放路径，避免两处各漏一半
  assert.match(terminal, /function disposeTab\(tab\)/);
  assert.match(terminal, /disposeTab\(tab\); \/\/ 与重复挂载走同一条释放路径/);
  // 孤儿面板（已出 tabs Map 但 DOM 还在）必须按 DOM 全量清 is-active，否则会与当前面板同时可见
  assert.match(terminal, /for \(const pane of root\.querySelectorAll\("\.terminal-pane"\)\) pane\.classList\.remove\("is-active"\);/);
});

// LO 2026-08-08：反复拉伸/收缩终端外框会出现重复显示。
// ConPTY 每收到一次 resize 就让 shell 重绘整屏，拖动时逐帧上报会把几十份重绘追加进缓冲。
test("terminal resize is debounced and skipped when the size did not change", async () => {
  const terminal = await source("public/terminal-panel.js");
  // fit 立即执行保证视觉跟手，上报去抖
  assert.match(terminal, /window\.clearTimeout\(tab\.resizeTimer\);\n\s*tab\.resizeTimer = window\.setTimeout\(/);
  // 尺寸没变就完全不打扰 ConPTY
  assert.match(terminal, /const size = `\$\{term\.cols\}x\$\{term\.rows\}`;\n\s*if \(size === tab\.lastSize\) return;/);
  assert.match(terminal, /tab\.lastSize = size;/);
  // 初值与服务端已知尺寸对齐，首帧不做无谓上报
  assert.match(terminal, /lastSize: `\$\{session\.cols \?\? 0\}x\$\{session\.rows \?\? 0\}`/);
  // 去抖中的 resize 不能打到已释放的会话上
  assert.match(terminal, /window\.clearTimeout\(tab\.resizeTimer\); \/\/ 去抖中的 resize/);
  // body 传对象，不再自己 stringify（否则 cols/rows 会被整个丢掉）
  assert.match(terminal, /body: \{ cols: term\.cols, rows: term\.rows \}/);
});

test("workbench splitters remain reachable in the desktop two-column layout", async () => {
  const [splitter, desktop, workbench] = await Promise.all([
    source("public/splitter.js"),
    source("public/forge/codex-desktop.css"),
    source("public/forge/workbench.css"),
  ]);
  assert.match(splitter, /columns = 3/);
  assert.match(splitter, /columns: 2/);
  assert.match(splitter, /attachSplitter\(shell, \{ side: "left"/);
  assert.doesNotMatch(splitter, /attachSplitter\(shell, \{ side: "right"/);
  assert.doesNotMatch(desktop, /grid-template-columns: var\(--codex-task-rail\) minmax\(0, 1fr\) !important;/);
  assert.doesNotMatch(desktop, /\.workbench-shell > \.forge-splitter-handle\s*\{\s*display: none;/);
  assert.match(workbench, /\.forge-splitter-handle \{[\s\S]*touch-action: none;/);
});

// 流一断就永久失联 = 输入发得出去但收不到回显（"终端打不出字"）；
// 重连时若仍重放缓冲 = 每断一次多一整份首屏（"打开终端有很多条"）。
test("terminal stream reconnects without replaying the buffer again", async () => {
  const [terminal, routes] = await Promise.all([
    source("public/terminal-panel.js"),
    source("src/pty/routes.mjs"),
  ]);
  assert.match(terminal, /const query = attempt === 0 \? "" : "\?replay=0";/);
  assert.match(terminal, /async function reconnectStream\(sessionId, tab, attempt, reason\)/);
  assert.match(terminal, /if \(attempt >= 5\)/);
  assert.match(terminal, /Math\.min\(8000, 400 \* 2 \*\* attempt\)/);
  // 正常收尾（进程退出）不该触发重连
  assert.match(terminal, /if \(!tab\.exited && !tab\.streamCtl\.signal\.aborted\) \{/);
  // 重试用尽才如实写进终端，不静默假死
  assert.match(terminal, /请关闭该标签后重开/);
  // 服务端必须认这个开关，否则重连仍会重放
  assert.match(routes, /replay: url\.searchParams\.get\("replay"\) !== "0"/);
});

// 根因（探针实证）：终端视图容器原本页面一加载就无条件 mount，白起一个 pwsh；
// 随后底部抽屉 attach 同一会话，同一个 PTY 上挂两条 SSE、各重放一次缓冲。
// 改为可见才挂载后，探针实测 SSE 连接数 2 → 1、首屏出现次数 1。
test("terminal view mounts only when visible so it cannot double-subscribe", async () => {
  const terminal = await source("public/terminal-panel.js");
  assert.match(terminal, /new IntersectionObserver\(\(entries\) => \{/);
  assert.match(terminal, /if \(!entries\.some\(\(entry\) => entry\.isIntersecting\)\) return;/);
  assert.match(terminal, /observer\.disconnect\(\);\n\s*void apiReady\.then\(\(\) => createTerminalPanel\(root\)\.mount\(\)\);/);
  assert.match(terminal, /observer\.observe\(root\);/);
  // 自举不得再无条件挂载
  assert.ok(
    !/const start = \(\) => void apiReady\.then\(\(\) => \{[\s\S]*?createTerminalPanel\(root\)\.mount\(\)/.test(terminal),
    "终端视图又回到了页面加载即挂载",
  );
});

test("rail tool panels stay honest about worktree-less runs and keep escape scoped", async () => {
  const [panels, railTools] = await Promise.all([
    source("public/modules/rail-panels.js"),
    source("public/rail-tools.js"),
  ]);
  // 没有隔离工作树时直接报边界，不发注定 422 的 diff 请求
  assert.match(panels, /没有隔离工作树/);
  // Escape 必须在 capture 阶段消费并 preventDefault，否则关菜单会连带折叠整条右栏
  assert.match(railTools, /document\.addEventListener\("keydown", handleKeydown, true\)/);
  assert.match(railTools, /event\.preventDefault\(\);\n\s*setMenuOpen\(false\);/);
  // 浏览器页不内嵌网页视图，打开一律交给宿主的系统浏览器出口
  assert.match(panels, /openSystemBrowser\?\.\(url\)/);
  assert.ok(!panels.includes("<iframe"), "浏览器页不得内嵌 iframe 网页视图");
});

test("both right-rail file entry points edit through the guarded workspace PUT", async () => {
  const [panels, mission, app, styles, sprite] = await Promise.all([
    source("public/modules/rail-panels.js"),
    source("public/mission-control.js"),
    source("public/app.js"),
    source("public/styles.css"),
    source("public/lucide-sprite.svg"),
  ]);

  // 独立「文件」工具页与任务上下文的内嵌文件浏览器都必须读取 editable/revision，
  // 保存复用同一 PUT + expectedRevision 乐观锁，不能出现一处能改、一处仍只读。
  assert.match(panels, /file\.editable === true/);
  assert.match(panels, /method: "PUT"/);
  assert.match(panels, /expectedRevision: snapshot\.revision/);
  assert.match(panels, /editor: "rail-files-editor"/);
  assert.match(panels, /\.\.\.fileIds/);
  assert.match(panels, /#\$\{files\.editor\}/);
  assert.match(app, /fileIds: \{[\s\S]*path: "bot-ops-files-path"/);
  assert.match(mission, /file\.editable === true/);
  assert.match(mission, /expectedRevision: snapshot\.revision/);
  assert.match(mission, /#mission-workspace-editor/);
  assert.match(app, /saveWorkspace: \(runId, path, payload, signal\) => request\(/);
  assert.match(app, /\{ method: "PUT", body: payload, signal \}/);

  // Ctrl/Cmd+S、保存中反馈和版本冲突反馈属于可感知闭环；动态按钮仍只引用 Lucide。
  assert.match(mission, /event\.key\.toLowerCase\(\) === "s"/);
  assert.match(mission, /正在保存/);
  assert.match(mission, /WORKSPACE_VERSION_CONFLICT/);
  assert.match(mission, /#lucide-\$\{lucideName\}/);
  assert.match(sprite, /id="lucide-save"/);
  assert.match(sprite, /id="lucide-rotate-ccw"/);
  assert.match(styles, /\.workspace-file-editor \{/);
  assert.match(styles, /\.workspace-file-save \{/);
});

test("rail tool shortcut labels are wired and do not hijack browser-reserved keys", async () => {
  const [railTools, app] = await Promise.all([
    source("public/rail-tools.js"),
    source("public/app.js"),
  ]);
  assert.doesNotMatch(railTools, /shortcut: "Ctrl\+(?:T|P)"/);
  assert.match(railTools, /shortcut: "Ctrl\+Alt\+B"/);
  assert.match(railTools, /shortcut: "Ctrl\+Alt\+F"/);
  assert.match(app, /event\.altKey && !event\.shiftKey && event\.key\.toLowerCase\(\) === "b"/);
  assert.match(app, /handleWorkbenchEnvironmentAction\("browser"\)/);
  assert.match(app, /event\.altKey && !event\.shiftKey && event\.key\.toLowerCase\(\) === "f"/);
  assert.match(app, /handleWorkbenchEnvironmentAction\("files"\)/);
});

test("terminal is a bottom drawer again with no persistent bar", async () => {
  const [html, chrome, app] = await Promise.all([
    source("public/index.html"),
    source("public/workbench-chrome.js"),
    source("public/app.js"),
  ]);
  assert.match(html, /id="terminal-drawer"/);
  assert.match(html, /id="terminal-drawer-close"/);
  assert.match(html, /id="workbench-terminal-container"/);
  assert.match(chrome, /function bootTerminalDrawer\(\)/);
  assert.match(chrome, /bootTerminalDrawer\(\);/);
  // 撤掉的是常驻折叠条与底部启动条，不是终端本身
  assert.ok(!html.includes("terminal-dock-bar"), "终端常驻折叠条又回来了");
  assert.ok(!html.includes("terminal-dock-hint"), "终端常驻提示条又回来了");
  assert.ok(!html.includes("mission-tool-launcher"), "底部工具启动条仍在 index.html 中");
  assert.ok(!chrome.includes("bootDockTerminalTab"), "右栏终端标签控制器仍在");
  // 折叠钮必须挂常驻的标签条动作区，挂进任务上下文页会随标签切换消失
  assert.match(chrome, /rail-tabbar-actions"\)\?\.appendChild\(collapseButton\)/);
  // LO 2026-08-08：终端要在操作台下方。conversation-pane 的孩子都钉了显式 grid-row，
  // 抽屉丢掉行号就会被 auto-placement 塞进 recovery-bar 隐藏后的空位、跑到输入框上方。
  const railCss = await source("public/forge/rail-tools.css");
  assert.match(railCss, /\.terminal-drawer \{[^}]*grid-row: -2 \/ -1;/s);
  assert.match(app, /function openBottomTerminal\(/);
  assert.match(app, /function ensureViewTerminal\(/);
  assert.match(app, /setView\("terminal"\)/);
  assert.match(chrome, /forge:open-bottom-terminal/);
  assert.match(chrome, /getElementById\("global-terminal-toggle"\)/);
});

test("removed docks leave no orphan selectors behind", async () => {
  const files = ["public/styles.css", "public/forge/workbench.css", "public/forge/codex-desktop.css"];
  for (const file of files) {
    const css = await source(file);
    assert.ok(!css.includes("terminal-dock"), `${file} 仍引用已删除的底部终端 dock`);
    assert.ok(!css.includes("mission-tool-launcher"), `${file} 仍引用已删除的底部工具启动条`);
    let depth = 0;
    for (const char of css) {
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      assert.ok(depth >= 0, `${file} 花括号失衡`);
    }
    assert.equal(depth, 0, `${file} 花括号未闭合`);
  }
  const styles = await source("public/styles.css");
  assert.match(styles, /\.registry-terminal-body \.terminal-shell \{/);
  assert.match(styles, /\.registry-tab-menu \{/);
  assert.match(styles, /\.registry-tab\.is-tool \{/);
});


// LO 2026-08-09 报障：点「确认恢复并继续」后恢复条挂了整整一轮不消失。
// 根因：直接续聊的 HTTP 要等整轮 turn 跑完才返回（orchestrator continue 返回 tracked），期间
// state.runs 停在 recovery_required 旧快照，SSE 每次重渲染 renderSelectedRun 都把恢复条画回去。
// 修复：run 列表重载闸覆盖状态敏感事件，让真实状态尽快翻页，恢复条只跟随 live 状态。
test("recovery bar follows live status and keeps provider failures readable", async () => {
  const [app, styles, html] = await Promise.all([
    source("public/app.js"),
    source("public/styles.css"),
    source("public/index.html"),
  ]);
  // 重载闸必须包含：状态翻页（recovery 进出）、轮次退还、用户消息落盘、轮开始
  const reloadGate = app.match(/if \(\/(.*?)\/i\.test\(event\.type\)\) scheduleRunsReload\(\);/s);
  assert.ok(reloadGate, "找不到 scheduleRunsReload 的事件闸");
  const gated = reloadGate[1];
  for (const type of ["recovery_required", "round_refunded", "turn_started", "turn_completed", "user\\.message", "assistant\\.message"]) {
    assert.ok(gated.includes(type), `runs 重载闸缺少 ${type}——恢复条/轮次 meta 会停在旧快照`);
  }
  // 显隐契约：非 recovery_required 一律隐藏并消费确认标记；acked 文案只在确认后、发送前出现
  assert.match(app, /if \(!run \|\| run\.status !== "recovery_required"\) \{/);
  assert.match(app, /state\.recoveryAckRunId = null; \/\/ 状态已翻页，确认标记失效/);
  assert.match(app, /const acked = state\.recoveryAckRunId === run\.id;/);
  assert.ok(app.includes("下次发送将自动继续"), "acked 文案缺失");
  const recoveryFn = app.slice(app.indexOf("function renderRecoveryBar"), app.indexOf("function acknowledgeRecovery"));
  assert.match(recoveryFn, /run\.error/, "恢复条必须露出 adapter 真因，不能只画 recoveryNote 套话");
  assert.match(recoveryFn, /run\.recoveryNote/);
  assert.match(recoveryFn, /class="recovery-bar-content"/);
  assert.match(recoveryFn, /class="recovery-bar-actions"/);
  assert.match(recoveryFn, /bar\.classList\.toggle\("is-acked", acked\)/);
  assert.match(recoveryFn, /acked \? "" : `<div class="recovery-reasons">/);
  assert.match(app, /providerFailurePresentation\(content\)/, "assistant 里的 API 5xx 必须走有界错误卡，不能渲染为正文墙");
  assert.match(app, /function providerFailureMessageMarkup\(/);
  assert.match(styles, /\.recovery-bar \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\) auto;[^}]*min-width: 0;/s);
  assert.match(styles, /\.recovery-bar-content,[^}]*\.recovery-bar-actions \{[^}]*min-width: 0;/s);
  assert.match(styles, /@media \(max-width: 640px\) \{[\s\S]*?\.recovery-bar \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(styles, /\.resume-hint-row \{[^}]*display: grid;[^}]*minmax\(0, 1fr\)/s);
  assert.match(styles, /\.conversation-pane\.has-recovery:not\(\.has-recovery-acked\) \.conversation-stream/);
  assert.match(styles, /\.conversation-pane\.has-recovery-acked \.composer-target-tabs,[^}]*\.composer-cli-console \{[^}]*display: none;/s);
  assert.match(html, /id="recovery-bar" role="alert" aria-live="assertive" aria-atomic="true" hidden/);
});


// LO 2026-08-09 需求：composer 发送框要有 Codex 桌面式权限模式选择器（pill + 上弹菜单）。
// 契约：`<select id="task-permission">` 仍是唯一状态源（提交/自动化/statusline 链路全部不动），
// pill/menu 只做镜像；菜单文案如实对应 permissions.json 的 modes，不虚构后端没有的能力档。
test("permission pill mirrors the task-permission select as single source of truth", async () => {
  const [html, app, css] = await Promise.all([
    source("public/index.html"),
    source("public/app.js"),
    source("public/styles.css"),
  ]);
  // 结构：原 select 隐藏保留在 task-permission-pick 内，pill 与 menu 同容器
  const pick = html.match(/<div class="model-pick permission-pick" id="task-permission-pick"[^>]*>([\s\S]*?)<\/div>\s*<span class="composer-session-controls"/);
  assert.ok(pick, "找不到 task-permission-pick 容器");
  assert.match(pick[1], /<select id="task-permission"[^>]*hidden>/);
  assert.match(pick[1], /class="permission-pill" id="permission-pill"/);
  assert.match(pick[1], /class="permission-menu" id="permission-menu" role="menu"/);
  // 状态源契约：pill 只读 select，点选回写 select 并走既有 change 链路
  assert.match(app, /const PERMISSION_MODE_META = \{/);
  for (const mode of ["plan", "review", "build", "ask", "auto", '"full-access"', "config", '"native:auto"', '"native:acceptEdits"', '"native:always-approve"']) {
    assert.ok(PERMISSION_MODE_META_BLOCK(app).includes(`${mode}:`), `PERMISSION_MODE_META 缺少 ${mode}`);
  }
  // Codex 官方档文案与桌面批准菜单逐字对齐
  for (const label of ["请求批准", "帮我批准", "完全访问权限", "自定义 (config.toml)"]) {
    assert.ok(app.includes(label), `官方档文案缺失：${label}`);
  }
  // 官方档开关：adapter 声明 danger-full-access（预设族标记位）时 composer 才出官方四档
  assert.match(app, /if \(permissionModes\.includes\("danger-full-access"\)\) \{/);
  assert.match(app, /"workspace-write:on-failure": "auto"/);
  assert.match(app, /"danger-full-access": "full-access"/);
  assert.match(app, /"config-default": "config"/);
  assert.match(app, /function syncPermissionPill\(\)/);
  assert.match(app, /function setPermissionMenuOpen\(open\)/);
  assert.match(app, /data-permission-option/);
  assert.match(app, /select\.value = option\.getAttribute\(`data-\$\{optionAttr\}`\)/);
  assert.match(app, /select\.dispatchEvent\(new Event\("change"\)\)/);
  // select 重渲染后必须回同步 pill：统一走 syncComposerPickSurfaces（静态/discovery + change）
  assert.match(app, /function syncComposerPickSurfaces\(\)/);
  const syncCalls = app.match(/syncComposerPickSurfaces\(\);/g) || [];
  assert.ok(syncCalls.length >= 3, `syncComposerPickSurfaces 调用点不足（${syncCalls.length}），静态/discovery 渲染后 pill 会失同步`);
  // 样式：pill 是圆角 ghost 按钮，菜单上弹
  assert.match(css, /\.permission-pill \{/);
  assert.match(css, /\.permission-menu \{[^}]*bottom: calc\(100% \+ 6px\);/s);
  assert.match(css, /\.permission-menu-row\.is-active \{/);
});

// T6（2026-08-27）：权限下拉追加 Grok 原生模式组——传统三档钉在最上方，原生组仅在目录声明
// native:*（provenance: cli-native）时出现，值原样透传不改名；提交时 native:* 经 create-run 的
// permission 字段透传（治理位钉 Build），普通档维持原路径。#task-permission select 仍是唯一状态源。
test("grok native permission group renders from catalog and submits via the permission channel", async () => {
  const [app, css] = await Promise.all([source("public/app.js"), source("public/styles.css")]);
  // 分组常量：标签 / 语义说明 / 原生值顺序钉死（说明项明示只读轮边界）；顺序含全部 CLI 的原生档
  assert.match(app, /const NATIVE_PERMISSION_GROUP_LABEL = "CLI 原生模式";/);
  assert.match(app, /const NATIVE_PERMISSION_GROUP_NOTE = "原生模式仅作用于只读轮；Build 写盘轮仍走审批白名单。写盘轮的 default\/ask 模式请 \/cli 附着交互 TUI。";/);
  assert.match(
    app,
    new RegExp(
      'const NATIVE_PERMISSION_GROUP_ORDER = Object\\.freeze\\(\\[\\s*' +
        '"native:auto", "native:acceptEdits", "native:always-approve",\\s*' +
        '"native:bypassPermissions", "native:autoEdit", "native:yolo", "native:build",\\s*' +
      '\\]\\);',
    ),
  );
  // 运行时行为：抽出 runPermissionOptions 实测——grok 席位三档+三个原生档，普通席位无原生组
  const scope = {
    permissionModeMeta: (id) => ({ title: `t-${id}`, desc: id, risk: id === "native:auto" ? "write" : "approval-required" }),
    NATIVE_PERMISSION_GROUP_LABEL: "CLI 原生模式",
    NATIVE_PERMISSION_GROUP_NOTE: "原生模式仅作用于只读轮；Build 写盘轮仍走审批白名单。写盘轮的 default/ask 模式请 /cli 附着交互 TUI。",
    NATIVE_PERMISSION_GROUP_ORDER: Object.freeze([
      "native:auto", "native:acceptEdits", "native:always-approve",
      "native:bypassPermissions", "native:autoEdit", "native:yolo", "native:build",
    ]),
  };
  const runPermissionOptions = extractFunctionForTest(app, "runPermissionOptions", scope);
  const grokOptions = runPermissionOptions(["plan", "read-only", "workspace-write", "native:auto", "native:acceptEdits", "native:always-approve"]);
  assert.deepEqual(
    grokOptions.map((option) => option.id),
    ["plan", "review", "build", "native:auto", "native:acceptEdits", "native:always-approve", "native-note"],
    "grok 席位 = 传统三档在最上方 + 三个原生档 + 不可选说明项",
  );
  for (const mode of ["native:auto", "native:acceptEdits", "native:always-approve"]) {
    const row = grokOptions.find((option) => option.id === mode);
    assert.equal(row.group, "CLI 原生模式", `${mode} 必须进原生分组`);
    assert.equal(row.id, mode, "原生值必须原样透传不改名");
  }
  const note = grokOptions.find((option) => option.id === "native-note");
  assert.equal(note.disabled, true, "说明项必须不可选");
  assert.ok(note.label.includes("只读轮"), "说明项必须明示只读轮边界");
  // 泛化（LO 2026-08-27）：claude/gemini/kimi/opencode 也按各自 CLI 声明原生档进组
  const claudeNativeOptions = runPermissionOptions(["plan", "read-only", "workspace-write", "native:acceptEdits", "native:bypassPermissions"]);
  assert.deepEqual(
    claudeNativeOptions.filter((option) => option.group && !option.note).map((option) => option.id),
    ["native:acceptEdits", "native:bypassPermissions"],
    "claude 席位的原生档必须原样透传进组",
  );
  const plainClaudeOptions = runPermissionOptions(["plan", "read-only", "workspace-write"]);
  assert.deepEqual(plainClaudeOptions.map((option) => option.id), ["plan", "review", "build"], "未声明原生档的席位不得出现原生组");
  assert.ok(plainClaudeOptions.every((option) => !option.group), "普通席位选项不得带分组标记");
  // 下拉渲染通道：optgroup 分组 + disabled 说明项；pill 镜像仍只读 select 并过滤说明项（唯一状态源不变）
  assert.match(app, /<optgroup label="\$\{escapeHtml\(group\)\}">/);
  assert.match(app, /\[\.\.\.select\.options\]\.filter\(\(option\) => !option\.disabled\)/);
  // 选中态回显：run 带原生 override 时下拉回显原生档本身（静态/动态目录两条路径同源）
  assert.match(app, /function continuingPermissionValueFor\(run\)/);
  const echoCalls = app.match(/continuingPermissionValueFor\(continuingRun\)/g) || [];
  assert.ok(echoCalls.length >= 2, `静态/动态目录路径都必须用同一续聊权限回显（当前 ${echoCalls.length}）`);
  // 热改：原生值走 PATCH 的 permission 通道（与创建同源校验），不碰 permissionMode 治理位
  assert.match(app, /\? \{ permission: value \} \/\/ 原生透传档走 override 通道/);
  // 提交链路：native:* 拆为治理位 build + permission 透传字段；普通档不带 permission 字段
  assert.match(app, /function composerPermissionSubmission\(permissionValue\)/);
  assert.match(app, /if \(value\.startsWith\("native:"\)\) return \{ permissionMode: "build", permission: value \};/);
  assert.match(app, /\.\.\.composerPermissionSubmission\(submission\.permissionMode\)/);
  // risk=approval-required 的原生档在菜单标「需审批」徽标；分组标题与徽标样式落 CSS
  assert.match(app, /permission-menu-risk">需审批<\/span>/);
  assert.match(css, /\.permission-menu-group \{/);
  assert.match(css, /\.permission-menu-risk \{[^}]*border-radius: 999px;/s);
});

// 契约测试辅助：按花括号配平抽出顶层函数源码，注入 stub 作用域后实跑（不引入新依赖）
function extractFunctionForTest(source, name, scope = {}) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `找不到函数：${name}`);
  let depth = 0;
  let end = source.indexOf("{", start);
  for (; end < source.length; end += 1) {
    if (source[end] === "{") depth += 1;
    else if (source[end] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const keys = Object.keys(scope);
  return new Function(...keys, `return (${source.slice(start, end + 1)});`)(...keys.map((key) => scope[key]));
}

// LO 2026-08-10：会话配置不应一刀切固化。模型（per-turn 覆盖）、Effort（codex turn/start 与
// spawn argv 都是每轮参数）与权限白名单迁移（降档 / Codex ask↔auto 同 sandbox）可会话中热改、
// 下一轮生效；Codex 沙箱轴绑原生 thread 真固化，不开口子。热改必须过服务端校验并落审计事件。
// recovery_required 时确认恢复可随热改一次性携带（acknowledgeRecovery），与 continue() 同语义。
test("hot control updates are wired end-to-end with a strict transition whitelist", async () => {
  const [app, orchestrator, server] = await Promise.all([
    source("public/app.js"),
    source("src/orchestrator.mjs"),
    source("server.mjs"),
  ]);
  // 后端：白名单表 + 更新入口 + 审计事件 + 闸与 continue 准入对齐
  assert.match(orchestrator, /const PERMISSION_HOT_TRANSITIONS = Object\.freeze\(\{/);
  for (const pair of ['review: ["plan"]', 'build: ["review", "plan"]', 'ask: ["auto"]', 'auto: ["ask"]']) {
    assert.ok(orchestrator.includes(pair), `PERMISSION_HOT_TRANSITIONS 缺少 ${pair}`);
  }
  // 原生审批档降档链：服务端与前端同源把守（只放开收缩方向，升档必须新建任务）；
  // patch.permission 分支不得只过白名单不校验转换方向（治理缺口：可经 API 直接升档）
  for (const source of [orchestrator, app]) {
    for (const pair of ['"native:auto": []', '"native:acceptEdits": ["native:auto"]', '"native:always-approve": ["native:acceptEdits", "native:auto"]']) {
      assert.ok(source.includes(pair), `前后端 PERMISSION_HOT_TRANSITIONS 同源表缺少 ${pair}`);
    }
  }
  assert.match(orchestrator, /PERMISSION_HOT_TRANSITIONS\[current\] \|\| \[\]\)\.includes\(next\)/);
  assert.match(orchestrator, /permission override \$\{current\} → \$\{next\} is not hot-switchable/);
  assert.match(orchestrator, /async updateRunControls\(id, patch = \{\}, \{ actor = "operator", acknowledgeRecovery = false \} = \{\}\)/);
  assert.match(orchestrator, /run\.control_changed/);
  // 恢复确认通道：原子放弃 claim + 改档，审计事件不静默
  assert.match(orchestrator, /run\.recovery_acknowledged/);
  assert.match(orchestrator, /run\.status === "waiting_approval"/);
  assert.match(orchestrator, /run\.status === "recovery_required"/);
  // HTTP：PATCH /api/runs/:id/controls（body.acknowledgeRecovery 随热改携带一次性恢复确认）
  assert.match(server, /\/api\\\/runs\\\/\(\[\^\/\]\+\)\\\/controls\$/);
  assert.match(server, /updateRunControls\(/);
  assert.match(server, /acknowledgeRecovery: acknowledgeRecovery === true/);
  // 前端：续聊只隐藏模型，Effort/权限放开；选项随当前档收窄；改动走 PATCH 并回滚于失败
  assert.match(app, /const PERMISSION_HOT_TRANSITIONS = Object\.freeze\(\{/);
  assert.match(app, /function continuingPermissionOptions\(currentMode\)/);
  assert.match(app, /async function applyRunControlChange\(controlId, value\)/);
  assert.match(app, /`\/api\/runs\/\$\{encodeURIComponent\(run\.id\)\}\/controls`/);
  // 恢复条确认后热改携带一次性 acknowledgeRecovery，成功后消费确认标记
  assert.match(app, /patch\.acknowledgeRecovery = true/);
  assert.match(app, /state\.recoveryAckRunId = null; \/\/ 确认标记一次性消费/);
  assert.match(app, /elements\["task-effort-pick"\]\.hidden = effortUnsupported;/);
  assert.match(app, /elements\["task-permission-pick"\]\.hidden = false;/);
  // 模型同样热改：Codex turn/start 实测接受 per-turn model，picker 续聊不再隐藏
  assert.match(app, /elements\["task-model-pick"\]\.hidden = modelUnsupported;/);
  assert.match(app, /controlId === "task-model"\s*\n\s*\? \{ model: value \}/);
  // Adapter 必须把 model 带进 turn/start；无 override 不下发
  const codexAdapter = await source("src/adapters/codex-app-server.mjs");
  assert.match(codexAdapter, /\.\.\.\(model \? \{ model \} : \{\}\),/);
  // SSE 重载闸必须覆盖 run.control_changed，否则 pill/meta 停在旧档
  assert.match(app, /control_changed\)\|task/);
  // 文案如实：不再笼统宣称"会话配置已固化"
  assert.ok(!app.includes("会话配置已固化"), "一刀切的固化文案还在");
  assert.ok(app.includes("Codex 沙箱轴随原生会话固化；模型、Effort、权限降档与 ask↔auto 可热调"), "分层文案缺失");
});

function PERMISSION_MODE_META_BLOCK(app) {
  return app.match(/const PERMISSION_MODE_META = \{([\s\S]*?)\};/)?.[1] || "";
}

// LO 2026-08-10：审批后长期不输出（刷新才恢复）的根因——分批挂载任何一步抛异常都会让
// aria-busy 永久 true，SSE 的 selectedRun 更新被 busy 闸无限空转。两层防线：
// 挂载异常清闸放行（根治）+ busy 闸等待帧数上限、超时强制复位重渲（防御）。
test("a failed conversation mount cannot deadlock the live stream", async () => {
  const app = await source("public/app.js");
  // 根治：batched 挂载主体包 try/catch——异常时 release ownership、清 aria-busy、落诊断
  const mount = app.slice(app.indexOf("async function replaceConversationStreamBatched"), app.indexOf("// conversation window functions → modules/conversation-window.js"));
  assert.ok(mount.includes("} catch (error) {"), "batched 挂载缺异常兜底");
  assert.ok(mount.includes('stream.removeAttribute("aria-busy");'), "异常路径未清挂载闸");
  assert.ok(mount.includes("会话流分批挂载失败（已放开渲染闸）"), "异常未落诊断");
  // 防御：busy 闸等待有帧数上限；超时作废旧挂载代际（stillOwned 令其自殁）、清闸、完整重渲
  assert.ok(app.includes("const STREAM_BUSY_WAIT_MAX_FRAMES = 600;"), "busy 闸缺超时上限");
  assert.ok(app.includes("streamBusyWaitFrames < STREAM_BUSY_WAIT_MAX_FRAMES"), "busy 等待未计数");
  assert.ok(app.includes("会话流挂载闸超时，已强制复位并重渲"), "超时复位未落诊断");
  assert.ok(app.includes("conversationRenderGeneration += 1;"), "超时未作废旧挂载代际");
});

// LO 2026-08-10：多轮审批后流尾堆一列「动作审批已批准」——已决议行按结果聚合成一行，
// 审计语义保留（次数 + 最近时间），拒绝单独成行（fail-closed 信号不折叠进批准里）。
test("resolved inline approvals aggregate into one line per decision", async () => {
  const app = await source("public/app.js");
  // 决议记录带时间戳（聚合一行的「最近时间」来源），并统一通过有界 helper 写入
  // 本地投影，避免按钮路径绕过 ownership/容量门。
  assert.match(app, /rememberInlineApprovalOutcome\(\{\s*\n\s*runId: item\.runId,\s*\n\s*decision,\s*\n\s*resolvedAt: new Date\(\)\.toISOString\(\),/);
  // 按 approve/deny 分组各出一行；次数 >1 带 ×N；同一 run 的 data-stream-key 稳定（重渲染幂等）
  assert.match(app, /\["approve", "deny"\]\.map\(\(decision\) => \{/);
  assert.match(app, /group\.length > 1 \? ` ×\$\{group\.length\}` : ""/);
  assert.match(app, /data-stream-key="approval-result:\$\{decision\}:\$\{escapeHtml\(run\.id\)\}"/);
  // 不再逐条展开 outcomes（旧的 .entries().map 堆叠路径已退役）
  const fn = app.slice(app.indexOf("function inlineApprovalsMarkup"), app.indexOf("// 内联审批决议"));
  assert.ok(!fn.includes("inlineApprovalOutcomes.entries()"), "已决议仍在逐条堆叠");
});

// LO 2026-08-15：新消息入场动画只能播一次——streaming 期间整段流用 innerHTML 重写，
// 若不按 data-stream-key 去重，动画会在每个 SSE 帧全部重播（闪烁灾难）。契约：首屏只登记不播，
// 之后才新出现的 key 打一次 is-entering，切走再切回不重播，run 清除时释放 key 集合。
test("message entrance animation dedupes by data-stream-key across stream rewrites", async () => {
  const [app, css, motion] = await Promise.all([
    source("public/app.js"),
    source("public/forge/codex-desktop.css"),
    source("public/forge/motion.css"),
  ]);
  // 去重闸：按 renderContext 记住已展示 key；首屏（firstPresent）只登记不播动画
  assert.ok(app.includes("const seenConversationStreamKeys = new Map();"), "缺 per-context 已见 key 集合");
  assert.ok(app.includes("if (firstPresent) continue; // 首屏历史：只登记，不播动画"), "首屏没有只登记不播动画");
  assert.ok(app.includes("if (!key || seen.has(key)) continue;"), "缺按 key 去重");
  assert.ok(app.includes('node.classList.add("is-entering");'), "缺 is-entering 标记");
  assert.ok(app.includes('node.addEventListener("animationend", () => node.classList.remove("is-entering"), { once: true });'), "缺动画结束摘类");
  // 有界：context 超过上限淘汰最旧，run 清除时释放其 key（避免长会话无界增长）
  assert.ok(app.includes("const SEEN_CONVERSATION_CONTEXT_LIMIT = 32;"), "缺 context 上限");
  assert.ok(app.includes("function forgetConversationStreamKeysForRun(runId)"), "缺 run 清除时的 key 释放");
  assert.ok(app.includes("forgetConversationStreamKeysForRun(runId);"), "run 清除路径未调用 key 释放");
  // 两条渲染路径（全量 + 分批）都在渲染后标记——漏接任何一条，那一条的新消息就不会入场
  const calls = app.split("markConversationStreamEntries(stream);").length - 1;
  assert.ok(calls >= 2, `标记只接入 ${calls} 处渲染路径，应覆盖全量与分批两条`);
  // CSS：淡入 + 4px 上浮（不缩放变高行），仅在非 reduced-motion 下生效
  assert.ok(motion.includes("@keyframes forge-fade-rise"), "缺 forge-fade-rise keyframe");
  assert.match(css, /\.conversation-stream \.is-entering \{\s*\n\s*animation: forge-fade-rise/);
});
