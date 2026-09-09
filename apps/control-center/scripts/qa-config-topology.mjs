#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "..", "..");
// 产物（png + report.json）留在仓库内 —— 它们是给人看的证据，路径必须稳定。
const outputRoot = resolve(appRoot, ".qa-output", "config-topology");
// 运行时 fixture 走系统临时目录，与 qa-ui-fixture.mjs / qa-config-walkthrough.mjs 一致。
//
// 为什么不能沿用 .qa-output 下的固定路径（2026-09-05 实测）：烛(Codex CLI) 在沙箱里跑过
// 这套 QA 后，`.qa-output/config-topology/runtime-home/.claude.json` 的属主变成
// `LANNINY\CodexSandboxOnl...`，当前用户连 `Get-Acl` / `icacls` 都被拒（文件属性是正常的
// Archive，**不是** ReadOnly —— 此前记录的「只读 fixture 残留」这个说法不成立）。
// 于是每次启动的 `writeJson(claudeConfigPath, ...)` 都 EPERM，整套 QA 在第 48 行就崩，
// 配置页从此拿不到独立交叉验证。
//
// 「启动时先 rm 清残留」这条修法已被实测判死：当前用户（非管理员，takeown 亦被拒）
// 连删都删不掉，那只会把 EPERM 从 open 移到 unlink。唯一根治是不再依赖被占用的路径。
const fixtureRoot = await mkdtemp(join(tmpdir(), "514cc-qa-config-topology-"));
const dataRoot = resolve(fixtureRoot, "runtime");
const runtimeHome = resolve(fixtureRoot, "runtime-home");
const capabilityConfigPath = resolve(dataRoot, "agent-capabilities.json");
const quarantinePath = resolve(dataRoot, "mcp-quarantine.json");
const claudeConfigPath = resolve(runtimeHome, ".claude.json");
const QA_MCP_NAME = "qa-fault-domain";
const qaToken = randomBytes(32).toString("base64url");
const healthyCapabilityConfig = { agents: {} };
const healthyQuarantine = { servers: {} };
const healthyClaudeConfig = {
  mcpServers: {
    [QA_MCP_NAME]: {
      command: "node",
      args: ["qa-fault-domain-server.mjs"],
    },
  },
};

await Promise.all([
  mkdir(outputRoot, { recursive: true }),
  mkdir(dataRoot, { recursive: true }),
  mkdir(runtimeHome, { recursive: true }),
]);

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function resetFaultDomainFixtures() {
  await Promise.all([
    writeJson(capabilityConfigPath, healthyCapabilityConfig),
    writeJson(quarantinePath, healthyQuarantine),
    writeJson(claudeConfigPath, healthyClaudeConfig),
  ]);
}

await resetFaultDomainFixtures();

let serverError = "";
let bootstrapUrl = "";
let origin = "";
let browser = null;
const findings = [];
let sharedToken = qaToken;
const server = spawn(process.execPath, ["--experimental-sqlite", "server.mjs", "--port=0"], {
  cwd: appRoot,
  env: {
    ...process.env,
    CONTROL_CENTER_REPO_ROOT: repoRoot,
    CONTROL_CENTER_DATA_DIR: dataRoot,
    CONTROL_CENTER_RUNTIME_HOME: runtimeHome,
    CONTROL_CENTER_OPEN: "0",
    CONTROL_CENTER_TEST_MODE: "1",
    CONTROL_CENTER_TOKEN: qaToken,
    USERPROFILE: runtimeHome,
    HOME: runtimeHome,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => { serverError += chunk; });

function waitForBootstrapUrl() {
  return new Promise((resolveReady, rejectReady) => {
    let stdout = "";
    const cleanup = () => {
      clearTimeout(timer);
      server.stdout?.off("data", onStdout);
      server.off("exit", onExit);
      server.off("error", onError);
    };
    const finish = (callback, value) => {
      cleanup();
      callback(value);
    };
    const onStdout = (chunk) => {
      stdout += chunk;
      const match = stdout.match(/514cc Control Center: (http:\/\/[^\s]+)/);
      if (match) finish(resolveReady, match[1]);
    };
    const onExit = (code) => finish(rejectReady, new Error(`server exited before ready (${code}): ${serverError}`));
    const onError = (error) => finish(rejectReady, new Error(`server failed to start: ${error.message}; ${serverError}`));
    const timer = setTimeout(
      () => finish(rejectReady, new Error(`server start timed out: ${serverError}`)),
      30_000,
    );
    server.stdout?.setEncoding("utf8");
    server.stdout?.on("data", onStdout);
    server.once("exit", onExit);
    server.once("error", onError);
  });
}

function serverExited() {
  return server.exitCode !== null || server.signalCode !== null;
}

function waitForServerExit(timeoutMs) {
  if (serverExited()) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const cleanup = () => {
      clearTimeout(timer);
      server.off("exit", onExit);
    };
    const onExit = () => {
      cleanup();
      resolveExit(true);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolveExit(false);
    }, timeoutMs);
    server.once("exit", onExit);
  });
}

async function stopQaServer() {
  if (serverExited()) return;
  if (origin && sharedToken) {
    try {
      const response = await fetch(new URL("/api/test/shutdown", origin), {
        method: "POST",
        headers: { authorization: `Bearer ${sharedToken}` },
        signal: AbortSignal.timeout(2_000),
      });
      await response.arrayBuffer().catch(() => {});
      if (response.status === 202 && await waitForServerExit(5_000)) return;
    } catch {
      // The owned child fallback below handles startup/browser failures without a token.
    }
  }
  if (!server.kill() && !serverExited()) throw new Error(`QA server pid ${server.pid} refused termination`);
  if (!await waitForServerExit(5_000)) throw new Error(`QA server pid ${server.pid} did not exit after termination`);
}

async function openPage({ viewport, theme, route }) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !/^Failed to load resource:/.test(message.text())) errors.push(`console: ${message.text()}`);
  });
  await page.addInitScript(({ token, selectedTheme }) => {
    if (token) sessionStorage.setItem("514cc-control-token", token);
    localStorage.setItem("514cc-control-theme", selectedTheme);
  }, { token: sharedToken, selectedTheme: theme });

  if (sharedToken) {
    await page.goto(`${origin}/#${route}`, { waitUntil: "domcontentloaded" });
  } else {
    await page.goto(bootstrapUrl, { waitUntil: "domcontentloaded" });
  }
  await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 30_000 });
  if (!sharedToken) {
    sharedToken = await page.evaluate(() => sessionStorage.getItem("514cc-control-token") ?? "");
    if (!sharedToken) throw new Error("bootstrap did not issue a session token");
    await page.evaluate((nextRoute) => { location.hash = nextRoute; }, route);
  }
  await page.waitForSelector("#view-config:not([hidden])", { timeout: 10_000 });
  return { page, errors };
}

async function waitForTopology(page) {
  await page.waitForFunction(() => {
    const values = [
      document.querySelector("#config-topology-provider-count")?.textContent,
      document.querySelector("#config-topology-capability-count")?.textContent,
      document.querySelector("#config-topology-source-count")?.textContent,
    ];
    return values.every((value) => value && !/读取中|扫描中/.test(value));
  }, null, { timeout: 30_000 });
}

async function refreshCapabilities(page) {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/capabilities" && response.request().method() === "GET";
  });
  await page.locator("#capabilities-refresh-button").click();
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`capability refresh failed with HTTP ${response.status()}`);
  return response.json();
}

async function faultDomainSnapshot(page) {
  return page.evaluate((mcpName) => {
    const skillToggles = [...document.querySelectorAll("[data-skill-toggle]")];
    const mcpButton = document.querySelector(`[data-mcp-toggle^="${mcpName}::"]`);
    return {
      topologyError: document.querySelector("#config-topology-capabilities")?.classList.contains("is-error") ?? false,
      workspaceStatus: document.querySelector("#config-workspace-status")?.textContent ?? "",
      skillSummary: document.querySelector("#cap-skills-summary")?.textContent ?? "",
      mcpSummary: document.querySelector("#cap-mcp-summary")?.textContent ?? "",
      skillToggleCount: skillToggles.length,
      enabledSkillToggleCount: skillToggles.filter((input) => !input.disabled).length,
      disabledSkillToggleCount: skillToggles.filter((input) => input.disabled).length,
      mcpOperation: mcpButton
        ? {
            action: mcpButton.dataset.mcpToggle,
            disabled: mcpButton.disabled,
            label: mcpButton.textContent?.trim() ?? "",
          }
        : null,
    };
  }, QA_MCP_NAME);
}

function requireQa(condition, message, evidence = null) {
  if (!condition) throw new Error(`${message}${evidence ? `: ${JSON.stringify(evidence)}` : ""}`);
}

async function assertSurface(page, surface) {
  const snapshot = await page.evaluate((expected) => {
    const mainContent = document.querySelector(".main-content");
    return {
      hash: location.hash,
      visiblePanels: [...document.querySelectorAll("[data-config-surface-panel]")]
        .filter((panel) => !panel.hidden)
        .map((panel) => panel.dataset.configSurfacePanel),
      selectedTabs: [...document.querySelectorAll("[data-config-surface]")]
        .filter((tab) => tab.getAttribute("aria-selected") === "true")
        .map((tab) => tab.dataset.configSurface),
      bodyOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
      mainContentOverflow: mainContent ? mainContent.scrollWidth - mainContent.clientWidth : null,
      providerOwner: document.querySelector("#runtime-connection-deck")?.closest("[data-config-surface-panel]")?.id,
      providerControlsOffscreen: expected === "providers"
        ? [...document.querySelectorAll(".provider-deck-heading button, .provider-deck-heading select")]
            .filter((control) => control instanceof HTMLElement && control.offsetParent !== null)
            .filter((control) => {
              const rect = control.getBoundingClientRect();
              return rect.left < -1 || rect.right > innerWidth + 1;
            })
            .map((control) => control.id || control.getAttribute("aria-label") || control.tagName)
        : [],
      expected,
    };
  }, surface);
  if (snapshot.visiblePanels.length !== 1 || snapshot.visiblePanels[0] !== surface) {
    throw new Error(`surface ownership mismatch: ${JSON.stringify(snapshot)}`);
  }
  if (snapshot.selectedTabs.length !== 1 || snapshot.selectedTabs[0] !== surface) {
    throw new Error(`tab ownership mismatch: ${JSON.stringify(snapshot)}`);
  }
  if (snapshot.bodyOverflow > 2) throw new Error(`body horizontal overflow: ${JSON.stringify(snapshot)}`);
  if (snapshot.mainContentOverflow == null || snapshot.mainContentOverflow > 2) {
    throw new Error(`main content horizontal overflow: ${JSON.stringify(snapshot)}`);
  }
  if (snapshot.providerOwner !== "config-surface-providers") {
    throw new Error(`provider owner mismatch: ${JSON.stringify(snapshot)}`);
  }
  if (snapshot.providerControlsOffscreen.length) throw new Error(`provider controls are offscreen: ${JSON.stringify(snapshot)}`);
  return snapshot;
}

async function inspect(name, viewport, theme) {
  const { page, errors } = await openPage({ viewport, theme, route: "config/sources" });
  await waitForTopology(page);
  const screenshots = [];
  for (const surface of ["sources", "providers", "capabilities", "hooks", "local-runtime"]) {
    await page.locator(`[data-config-surface="${surface}"]`).click();
    await assertSurface(page, surface);
    if (surface === "local-runtime") await page.waitForSelector("#ccswitch-workbench .ccs-tabs");
    if (surface === "hooks") await page.waitForSelector("#hooks-workbench .hooks-heading");
    if (surface === "capabilities") await page.waitForSelector("#cap-skills-body tr");
    const file = `${name}-${theme}-${surface}.png`;
    await page.screenshot({ path: resolve(outputRoot, file), fullPage: true, animations: "disabled" });
    screenshots.push(file);
    if (surface === "capabilities") {
      await page.locator("#cap-workspace-mcp-tab").click();
      await page.waitForSelector("#cap-workspace-mcp:not([hidden])");
      const mcpFile = `${name}-${theme}-capabilities-mcp.png`;
      await page.screenshot({ path: resolve(outputRoot, mcpFile), fullPage: true, animations: "disabled" });
      screenshots.push(mcpFile);
      await page.locator("#cap-workspace-skills-tab").click();
      await page.waitForSelector("#cap-workspace-skills:not([hidden])");
    }
  }

  await page.locator('[data-config-surface="capabilities"]').focus();
  await page.keyboard.press("ArrowRight");
  await assertSurface(page, "hooks");
  await page.keyboard.press("ArrowRight");
  await assertSurface(page, "local-runtime");
  await page.keyboard.press("ArrowLeft");
  await assertSurface(page, "hooks");
  await page.keyboard.press("ArrowLeft");
  await assertSurface(page, "capabilities");

  const sourceButtons = page.locator("[data-capability-source-id]");
  if (!(await sourceButtons.count())) throw new Error("capability source actions are missing");
  await sourceButtons.first().click();
  await page.waitForSelector("#config-surface-sources:not([hidden])");
  await page.waitForFunction(() => !["正在加载", "未选择配置"].includes(document.querySelector("#editor-title")?.textContent ?? ""));
  const sourceJump = await page.evaluate(() => ({
    surface: document.querySelector('[data-config-surface][aria-selected="true"]')?.dataset.configSurface,
    path: document.querySelector("#editor-path")?.textContent,
  }));
  if (sourceJump.surface !== "sources" || !/SKILL\.md$/i.test(sourceJump.path ?? "")) {
    throw new Error(`capability source jump failed: ${JSON.stringify(sourceJump)}`);
  }

  findings.push({ name, viewport, theme, screenshots, sourceJump, errors });
  await page.close();
}

async function inspectLegacyAlias() {
  const { page, errors } = await openPage({ viewport: { width: 1280, height: 800 }, theme: "light", route: "capabilities" });
  await page.waitForSelector("#config-surface-capabilities:not([hidden])");
  const snapshot = await assertSurface(page, "capabilities");
  if (snapshot.hash !== "#capabilities") errors.push(`legacy hash was not preserved during alias resolution: ${snapshot.hash}`);
  findings.push({ name: "legacy-capabilities-alias", ...snapshot, errors });
  await page.close();
}

async function inspectFaultDomainIsolation() {
  const { page, errors } = await openPage({
    viewport: { width: 1280, height: 900 },
    theme: "light",
    route: "config/capabilities",
  });
  const cases = [];

  try {
    await waitForTopology(page);

    // MCP 台账损坏：MCP 写操作 fail-closed，但独立的 Skill 配置仍必须可写。
    await writeFile(quarantinePath, '{"servers":', "utf8");
    const mcpDegradedPayload = await refreshCapabilities(page);
    await page.waitForFunction(() => document.querySelector("#cap-mcp-summary")?.textContent?.includes("MCP_QUARANTINE_CORRUPT"));
    const mcpDegraded = await faultDomainSnapshot(page);
    requireQa(mcpDegradedPayload.mcp?.configurationStatus?.code === "MCP_QUARANTINE_CORRUPT", "MCP degradation code missing from backend payload", mcpDegradedPayload.mcp?.configurationStatus);
    requireQa(mcpDegradedPayload.skills?.configurationStatus?.state === "ready", "Skill configuration should remain ready when MCP quarantine is corrupt", mcpDegradedPayload.skills?.configurationStatus);
    requireQa(mcpDegraded.topologyError, "topology node did not expose the MCP fault", mcpDegraded);
    requireQa(mcpDegraded.mcpSummary.includes("MCP_QUARANTINE_CORRUPT"), "MCP summary omitted the exact degradation code", mcpDegraded);
    requireQa(mcpDegraded.mcpOperation?.disabled === true, "writable MCP operation was not disabled", mcpDegraded);
    requireQa(mcpDegraded.enabledSkillToggleCount > 0, "MCP fault incorrectly froze every Skill checkbox", mcpDegraded);

    const skillToggle = page.locator("[data-skill-toggle]:not(:disabled)").first();
    const skillToken = await skillToggle.getAttribute("data-skill-toggle");
    requireQa(Boolean(skillToken), "no writable Skill checkbox was available for an end-to-end mutation");
    requireQa(await skillToggle.isChecked(), "fresh capability fixture should start with the selected Skill enabled", { skillToken });
    const skillMutationPromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/capabilities/agent-skill" && response.request().method() === "PUT");
    // 点 label 而非 input：矩阵里的 checkbox 是 opacity:0 + pointer-events:none 的
    // 视觉隐藏元素（实测 rect 0×0），可见控件是 label 内的 .cap-toggle-indicator。
    // 直接点 input 既 "outside of the viewport"，force 点也不触发 change ——
    // 表现为 waitForResponse 干等 30s 超时，看不出是选择器的问题。
    await page.locator(`label.cap-cell-toggle:has([data-skill-toggle="${skillToken}"])`).click();
    const skillMutation = await skillMutationPromise;
    requireQa(skillMutation.ok(), `Skill mutation failed with HTTP ${skillMutation.status()}`);
    await page.waitForFunction((token) => {
      const input = document.querySelector(`[data-skill-toggle="${token}"]`);
      return input && !input.disabled && !input.checked;
    }, skillToken);
    const [agentId, skill] = skillToken.split("::");
    const persistedCapabilities = JSON.parse(await readFile(capabilityConfigPath, "utf8"));
    requireQa(persistedCapabilities.agents?.[agentId]?.disabledSkills?.includes(skill), "Skill mutation did not reach agent-capabilities.json", { agentId, skill, persistedCapabilities });
    await page.screenshot({ path: resolve(outputRoot, "fault-mcp-degraded.png"), fullPage: true, animations: "disabled" });
    cases.push({
      name: "mcp-degraded-skill-ready",
      backend: {
        skillStatus: mcpDegradedPayload.skills.configurationStatus,
        mcpStatus: mcpDegradedPayload.mcp.configurationStatus,
      },
      ui: mcpDegraded,
      mutationEvidence: { agentId, skill, persistedDisabled: true },
      screenshot: "fault-mcp-degraded.png",
    });

    // Skill 配置损坏：Skill 声明 fail-closed，但 MCP 隔离事务仍必须可执行。
    await writeJson(quarantinePath, healthyQuarantine);
    await writeFile(capabilityConfigPath, '{"agents":', "utf8");
    const skillDegradedPayload = await refreshCapabilities(page);
    await page.waitForFunction(() => document.querySelector("#cap-skills-summary")?.textContent?.includes("能力配置已降级"));
    const skillDegraded = await faultDomainSnapshot(page);
    requireQa(skillDegradedPayload.skills?.configurationStatus?.code === "CAPABILITY_CONFIG_CORRUPT", "Skill degradation code missing from backend payload", skillDegradedPayload.skills?.configurationStatus);
    requireQa(skillDegradedPayload.mcp?.configurationStatus?.state === "ready", "MCP quarantine should remain ready when Skill configuration is corrupt", skillDegradedPayload.mcp?.configurationStatus);
    requireQa(skillDegraded.topologyError, "topology node did not expose the Skill fault", skillDegraded);
    requireQa(skillDegraded.skillSummary.includes("能力配置已降级"), "Skill summary omitted the degraded state", skillDegraded);
    requireQa(skillDegraded.skillToggleCount > 0 && skillDegraded.enabledSkillToggleCount === 0, "corrupt Skill configuration did not disable every Skill checkbox", skillDegraded);
    requireQa(skillDegraded.mcpOperation?.disabled === false, "Skill fault incorrectly froze the writable MCP operation", skillDegraded);

    await page.locator("#cap-workspace-mcp-tab").click();
    await page.waitForSelector("#cap-workspace-mcp:not([hidden]) .cap-mcp-card, #cap-workspace-mcp:not([hidden]) .cap-empty");
    const mcpToggle = page.locator(`[data-mcp-toggle="${QA_MCP_NAME}::disable"]`);
    requireQa(await mcpToggle.count() === 1, "writable MCP fixture action is missing", skillDegraded);
    await mcpToggle.click();
    await page.waitForSelector("#action-dialog[open]");
    const mcpMutationPromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/capabilities/mcp/toggle" && response.request().method() === "POST");
    const postMutationRefreshPromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/capabilities" && response.request().method() === "GET");
    await page.locator("#dialog-confirm-button").click();
    const mcpMutation = await mcpMutationPromise;
    requireQa(mcpMutation.ok(), `MCP mutation failed with HTTP ${mcpMutation.status()}`);
    const postMutationRefresh = await postMutationRefreshPromise;
    requireQa(postMutationRefresh.ok(), `post-mutation capability refresh failed with HTTP ${postMutationRefresh.status()}`);
    await page.waitForFunction((mcpName) => {
      const button = document.querySelector(`[data-mcp-toggle="${mcpName}::enable"]`);
      return button && !button.disabled;
    }, QA_MCP_NAME);
    const persistedClaude = JSON.parse(await readFile(claudeConfigPath, "utf8"));
    const persistedQuarantine = JSON.parse(await readFile(quarantinePath, "utf8"));
    requireQa(!persistedClaude.mcpServers?.[QA_MCP_NAME], "MCP disable did not remove the source entry", persistedClaude);
    requireQa(persistedQuarantine.servers?.[QA_MCP_NAME]?.entry?.command === "node", "MCP disable did not persist the recovery entry", persistedQuarantine);
    await page.screenshot({ path: resolve(outputRoot, "fault-skill-degraded.png"), fullPage: true, animations: "disabled" });
    cases.push({
      name: "skill-degraded-mcp-ready",
      backend: {
        skillStatus: skillDegradedPayload.skills.configurationStatus,
        mcpStatus: skillDegradedPayload.mcp.configurationStatus,
      },
      ui: skillDegraded,
      mutationEvidence: {
        removedFromClaudeConfig: true,
        recoveryEntryPersisted: true,
      },
      screenshot: "fault-skill-degraded.png",
    });
  } finally {
    await resetFaultDomainFixtures();
    await page.close();
  }

  findings.push({ name: "capability-fault-domain-isolation", cases, errors });
}

// ── 首屏 chrome 预算（棘轮门禁）────────────────────────────────────────────
// 为什么不维护 chrome 类名清单：清单对 **JS 运行时渲染** 的 chrome 完全失明。
// 2026-09-05 实测教训——hooks 面有四层 chrome（hooks-heading 96 + hooks-stores 68
// + search-field 33 + hooks-toolbar 57 = 254px，由 modules/hooks-panel.js:374-400
// 注入），而清单里没有任何 hooks-* 类名，于是 `#hooks-workbench` 这个容器本身
// 被当成"第一个非 chrome 块"，产出 21.4% —— 与更早一版把整个 panel 当正文块的
// 假探针**同值**。同一个 bug 发作两次，都没被数字异常暴露。
//
// 反转标记方向后定义上完备：ratio = 活跃 panel 内第一个可见 [data-surface-body]
// 的 top ÷ innerHeight，chrome ≡ 锚点之上的一切。新增 chrome 只有两种落点——
// 锚点之上 → 实测值上升 → 棘轮抓住；锚点之下 → 按定义它就是正文。
// 不需要任何人记得往清单里补一行，这才是机械承载。
//
// 基线外置在 scripts/chrome-budget-baseline.json：期望值来自人审过的 commit diff，
// 不来自被测代码自己（避开"拿表验表"）。判定三条：
//   ① 不许退化：ratio > high + regressionTolerance
//   ② 超目标须挂账：high > goal 且无 debt 字段
//   ③ 余量过大须收紧：high - ratio > slackBeforeTighten（防基线留陈旧空头额度）
const CHROME_BUDGET_BASELINE_PATH = resolve(appRoot, "scripts", "chrome-budget-baseline.json");
const CHROME_BUDGET_SURFACES = ["sources", "capabilities", "hooks", "local-runtime"];
const CHROME_BUDGET_VIEWPORTS = [{ width: 1600, height: 1000 }, { width: 1440, height: 900 }, { width: 1280, height: 800 }];
const CAPABILITY_BUS_OPEN_KEY = "514cc-capability-bus-open-v1";

async function measureChromeRatio(page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  return page.evaluate(() => {
    // config-toolbar 是 sticky——未回到顶部时几何量会偏，先自证 scrollY。
    if (window.scrollY !== 0) return { error: `scrollY=${window.scrollY}，未回到顶部` };
    const panels = [...document.querySelectorAll("[data-config-surface-panel]")].filter((node) => !node.hidden);
    if (panels.length !== 1) return { error: `活跃 panel 数=${panels.length}，应恰好 1 个` };
    const bodies = [...panels[0].querySelectorAll("[data-surface-body]")]
      .filter((node) => node.getBoundingClientRect().height > 0);
    // fail-closed：锚点被删/重构丢失时必须报错，不许静默退化成恒真。
    if (!bodies.length) return { error: "找不到可见的 [data-surface-body] 正文锚点" };
    const rect = bodies[0].getBoundingClientRect();
    const chrome = [];
    let node = bodies[0];
    while (node && node !== panels[0]) {
      let sibling = node.previousElementSibling;
      while (sibling) {
        const box = sibling.getBoundingClientRect();
        if (box.height > 0) chrome.unshift(`${(sibling.className && sibling.className.toString().split(" ")[0]) || sibling.tagName}:${box.height.toFixed(0)}`);
        sibling = sibling.previousElementSibling;
      }
      node = node.parentElement;
    }
    return { ratio: Number((rect.top / window.innerHeight).toFixed(4)), top: Number(rect.top.toFixed(1)), chrome };
  });
}

async function inspectChromeBudget() {
  const errors = [];
  const cases = [];
  let baseline;
  try {
    baseline = JSON.parse(await readFile(CHROME_BUDGET_BASELINE_PATH, "utf8"));
  } catch (error) {
    findings.push({ name: "chrome-budget", errors: [`基线不可读：${error.message}（先跑 node scripts/qa-config-topology.mjs --update-chrome-baseline）`] });
    return;
  }
  const goal = baseline.goal ?? 0.4;
  const tolerance = baseline.regressionTolerance ?? 0.005;
  const slack = baseline.slackBeforeTighten ?? 0.05;
  const refresh = process.argv.includes("--update-chrome-baseline");
  const measured = {};

  for (const busOpen of [true, false]) {
    const { page } = await openPage({ viewport: CHROME_BUDGET_VIEWPORTS[0], theme: "light", route: "config/sources" });
    try {
      // 钉死 capability-bus 状态：不钉死则 capabilities 基线在两个值间摆动，棘轮失效。
      await page.evaluate(({ key, open }) => {
        try { localStorage.setItem(key, open ? "1" : "0"); } catch { /* 隐私模式下忽略 */ }
      }, { key: CAPABILITY_BUS_OPEN_KEY, open: busOpen });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 30_000 });
      await waitForTopology(page);

      for (const viewport of CHROME_BUDGET_VIEWPORTS) {
        await page.setViewportSize(viewport);
        for (const surface of CHROME_BUDGET_SURFACES) {
          await page.locator(`[data-config-surface="${surface}"]`).click();
          if (surface === "local-runtime") await page.waitForSelector("#ccswitch-workbench .ccs-tabs");
          if (surface === "hooks") await page.waitForSelector("#hooks-workbench .hooks-heading");
          if (surface === "capabilities") await page.waitForSelector("#cap-skills-body tr");
          const key = `${surface}@${viewport.width}x${viewport.height}@bus-${busOpen ? "open" : "closed"}`;
          const result = await measureChromeRatio(page);
          if (result.error) { errors.push(`${key}: ${result.error}`); continue; }
          measured[key] = result;
          if (refresh) continue;
          const entry = baseline.faces?.[key];
          if (!entry) { errors.push(`${key}: 基线缺此组合 —— 新增面/视口必须显式登记`); continue; }
          if (result.ratio > entry.high + tolerance) {
            errors.push(`${key}: chrome 占比退化 ${(entry.high * 100).toFixed(1)}% → ${(result.ratio * 100).toFixed(1)}%（新增 ${((result.ratio - entry.high) * 100).toFixed(1)} 个百分点）｜当前 chrome: ${result.chrome.join(" + ")}`);
          }
          if (entry.high > goal && !entry.debt) {
            errors.push(`${key}: 基线 ${(entry.high * 100).toFixed(1)}% 超目标 ${(goal * 100).toFixed(0)}% 却未挂 debt 说明`);
          }
          if (entry.high - result.ratio > slack) {
            errors.push(`${key}: 预算已有 ${((entry.high - result.ratio) * 100).toFixed(1)} 个百分点余量，请跑 --update-chrome-baseline 收紧（陈旧空头额度会让门禁名存实亡）`);
          }
          cases.push({ key, ratio: result.ratio, baseline: entry.high, goal, top: result.top, chrome: result.chrome, debt: entry.debt ?? null });
        }
      }
    } finally {
      await page.close();
    }
  }

  if (refresh) {
    const faces = {};
    for (const [key, value] of Object.entries(measured)) {
      const previous = baseline.faces?.[key] ?? {};
      const next = { high: value.ratio, chrome: value.chrome };
      if (value.ratio > goal) next.debt = previous.debt ?? "待压缩（刷新基线时未给说明）";
      faces[key] = next;
    }
    await writeFile(CHROME_BUDGET_BASELINE_PATH, `${JSON.stringify({ ...baseline, updatedAt: new Date().toISOString(), faces }, null, 2)}\n`, "utf8");
    process.stdout.write(`chrome 预算基线已刷新：${Object.keys(faces).length} 个组合\n`);
    findings.push({ name: "chrome-budget", cases: Object.entries(measured).map(([key, v]) => ({ key, ratio: v.ratio })), errors: [] });
    return;
  }

  findings.push({ name: "chrome-budget", cases, errors });
}


try {
  bootstrapUrl = await waitForBootstrapUrl();
  origin = new URL(bootstrapUrl).origin;
  browser = await chromium.launch({ headless: true });
  await inspect("desktop", { width: 1440, height: 1000 }, "light");
  await inspect("desktop", { width: 1440, height: 1000 }, "dark");
  await inspect("mobile", { width: 390, height: 844 }, "light");
  await inspect("mobile", { width: 390, height: 844 }, "dark");
  await inspectLegacyAlias();
  await inspectFaultDomainIsolation();
  await inspectChromeBudget();

  const report = {
    ok: findings.every((entry) => entry.errors.length === 0),
    origin,
    findings,
  };
  await writeFile(resolve(outputRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    try {
      await stopQaServer();
    } finally {
      // fixtureRoot 是本次运行独占的临时目录，直接整体删掉即可 —— 不再需要
      // resetFaultDomainFixtures() 把内容写回"干净态"给下一次运行复用。
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }
}
