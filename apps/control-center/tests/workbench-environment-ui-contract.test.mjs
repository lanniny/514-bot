import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createWorkbenchEnvironmentPanel } from "../public/environment-panel.js";

const root = fileURLToPath(new URL("..", import.meta.url));

async function source(path) {
  // Windows 工作区源码是 CRLF：统一归一化为 LF，避免多行正则里的 \n 匹配不到（config-topology-state 同根因）
  return (await readFile(`${root}/${path}`, "utf8")).replace(/\r\n/g, "\n");
}

test("workbench environment dock exposes the five reference tools and explicit recipient side chat", async () => {
  const [html, railTools] = await Promise.all([source("public/index.html"), source("public/rail-tools.js")]);
  // 工具入口 2026-08-08 由 index.html 的静态按钮迁到 RAIL_TOOLS 定义（右栏标签条 ➕ 菜单与空态选择器共用）
  for (const id of ["review", "terminal", "browser", "files", "side-chat"]) {
    assert.match(railTools, new RegExp(`id: "${id}"`), `RAIL_TOOLS 缺少工具 ${id}`);
  }
  // 侧栏终端占标签；侧边对话仍转发为浮层
  assert.doesNotMatch(railTools, /id: "terminal",[^}]*external: true/);
  assert.match(railTools, /id: "side-chat",[^}]*external: true/);
  assert.match(html, /data-tool-panel="terminal"/);
  assert.match(html, /id="rail-terminal-container"/);
  assert.match(html, /id="terminal-drawer"/);
  assert.match(html, /id="mission-environment-panel"/);
  assert.match(html, /id="mission-side-chat-title"/);
  assert.match(html, />直接收件人</);
  assert.match(html, /id="workbench-git-dialog"/);
  assert.match(html, /id="workbench-browser-dialog"/);
});

test("environment UI uses real API actions, typed Git confirmation, and honest agent naming", async () => {
  const [app, panel, api] = await Promise.all([
    source("public/app.js"),
    source("public/environment-panel.js"),
    source("public/api.js"),
  ]);
  assert.match(api, /workbenchEnvironment:\s*"\/api\/workbench\/environment"/);
  assert.match(api, /workbenchGitPlan:\s*"\/api\/workbench\/git\/plan"/);
  assert.match(api, /workbenchGitExecute:\s*"\/api\/workbench\/git\/execute"/);
  assert.match(app, /confirmationText:\s*plan\.confirmation/);
  assert.match(app, /mission-side-chat-input/);
  assert.match(app, /openWorkspace/);
  assert.match(panel, /智能体活动/);
  assert.doesNotMatch(panel, /子智能体/);
  assert.match(panel, /任务来源/);
  assert.match(panel, /待发送附件/);
});

test("environment panel keeps the reference layout affordances without inventing process argv", async () => {
  const [panel, app, css, registry, api, server] = await Promise.all([
    source("public/environment-panel.js"),
    source("public/app.js"),
    source("public/forge/codex-desktop.css"),
    source("src/child-registry.mjs"),
    source("public/api.js"),
    source("server.mjs"),
  ]);
  // 参考图形态：可展开的本地/分支行、变更行内联刷新态、来源 ➕ 与查看全部、运行中头像堆叠
  assert.match(panel, /data-environment-expand="\$\{escapeHtml\(key\)\}"/);
  assert.match(panel, /expandRow\("workspace"/);
  assert.match(panel, /expandRow\("branch"/);
  assert.match(panel, /release-truth/);
  assert.match(panel, /没有当轮 readback，不能称为已激活/);
  assert.match(panel, /release-record/);
  assert.match(panel, /不自动 git add\/commit\/push/);
  assert.match(panel, /project-bridge/);
  assert.match(panel, /四面未齐，不能称为项目已接通/);
  assert.match(panel, /first-run/);
  assert.match(panel, /首次就绪/);
  assert.match(panel, /首次就绪读取失败/);
  assert.match(panel, /new Set\(\["first-run"\]\)/);
  assert.match(panel, /expandedRows\.clear\(\);\s*expandedRows\.add\("first-run"\)/);
  assert.match(server, /readiness-unavailable/);
  assert.match(server, /\/api\/release-record/);
  assert.match(server, /\/settlement\$/);
  assert.match(server, /state\.observability\.handoffs\(\{ limit: 80, strict: true \}\)/);
  assert.match(server, /state\.observability\.deltaLedger\(\{ recent: 80, strict: true \}\)/);
  assert.match(server, /handoffs: handoffs\.map\(\(file\) => \(\{ \.\.\.file, exists: true \}\)\)/);
  assert.match(server, /deltas: Array\.isArray\(deltaLedger\?\.deltas\)/);
  assert.match(api, /releaseRecord:\s*"\/api\/release-record"/);
  assert.match(api, /runSettlement:\s*\(runId\)\s*=>/);
  assert.match(panel, /run-settlement/);
  assert.match(panel, /不自动 merge/);
  assert.match(app, /准备交付/);
  assert.match(app, /remote-unsupported/);
  assert.match(app, /不会自动 merge/);
  assert.match(api, /projectBridge:\s*"\/api\/project-bridge"/);
  assert.match(api, /readiness:\s*"\/api\/readiness"/);
  assert.match(panel, /environment-state is-\$\{escapeHtml\(state\)\}/);
  assert.match(panel, /environment-inline-spinner/);
  assert.match(panel, /data-environment-action="sources-add"/);
  assert.match(panel, /查看全部/);
  assert.match(panel, /environment-avatar-strip/);
  assert.match(app, /renderAgentAvatar:/);
  assert.match(app, /action === "sources-add"/);
  assert.match(css, /\.environment-detail \{/);
  assert.match(css, /\.environment-avatar \{/);
  // 后台进程行只投影镜像名/PID/启动时间：台账刻意不保留 argv，UI 不得反向要求它保留
  assert.match(panel, /PID \$\{formatCount\(item\.pid\)\}/);
  assert.doesNotMatch(panel, /item\.(?:args|argv|commandLine)/);
  assert.match(registry, /Command arguments and environment values are intentionally never retained/);
});

test("environment panel coalesces repeated selection while the same run request is pending", async () => {
  const pending = [];
  const root = {
    innerHTML: "",
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
  };
  const panel = createWorkbenchEnvironmentPanel({
    root,
    loadEnvironment(runId, signal) {
      return new Promise((resolve, reject) => {
        const request = { runId, signal, resolve, reject };
        pending.push(request);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });

  panel.selectRun("run-a");
  panel.selectRun("run-a");
  assert.equal(pending.length, 1, "same-run selection must reuse the in-flight environment request");

  panel.selectRun("run-b");
  assert.equal(pending.length, 2);
  assert.equal(pending[0].signal.aborted, true, "changing runs must still cancel the stale request");
  pending[1].resolve({
    schema: "514cc.workbench.environment/v1",
    workspace: {},
    git: {},
    agents: {},
    processes: {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  panel.selectRun("run-b");
  assert.equal(pending.length, 2, "loaded same-run selection must stay idempotent");
});

test("environment routes are authenticated API branches and Git execution is argument-only", async () => {
  const [server, backend] = await Promise.all([
    source("server.mjs"),
    source("src/workbench-environment.mjs"),
  ]);
  assert.match(server, /pathname === "\/api\/workbench\/environment"/);
  assert.match(server, /pathname === "\/api\/workbench\/git\/plan"/);
  assert.match(server, /pathname === "\/api\/workbench\/git\/execute"/);
  assert.match(server, /\/api\\\/runs\\\/\(\[\^\/\]\+\)\\\/sources\$\//);
  assert.match(server, /"\/environment-panel\.js": "environment-panel\.js"/);
  // 根级 ESM 漏进白名单会 404 并让整页脚本停载（codex 2026-08-07 实测），每新增一个都必须锁住
  assert.match(server, /"\/rail-tools\.js": "rail-tools\.js"/);
  assert.match(server, /runForPublic\(await state\.automations\.trigger/);
  assert.match(server, /runForPublic\(await state\.automations\.cancel/);
  assert.match(backend, /gitArgs\(plan\.cwd, \["commit", "-m", plan\.message\]\)/);
  assert.match(backend, /"remote", "get-url", "--push", "--all", remote/);
  assert.match(backend, /signedPushTransport\(currentState\.pushTarget\)/);
  assert.match(backend, /`\$\{currentState\.headOid\}:\$\{currentState\.pushTarget\.remoteRef\}`/);
  assert.match(backend, /"--no-follow-tags"/);
  assert.match(backend, /"--recurse-submodules=no"/);
  assert.match(backend, /this\.plans\.delete\(plan\.id\);[\s\S]+await actionState/);
  assert.match(backend, /GIT_CONFIG_COUNT/);
  assert.doesNotMatch(backend, /`HEAD:\$\{currentState\.pushTarget\.remoteRef\}`/);
  assert.doesNotMatch(backend, /--force/);
  assert.doesNotMatch(backend, /\["add"/);
});
