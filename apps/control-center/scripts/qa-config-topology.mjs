#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "..", "..");
const outputRoot = resolve(appRoot, ".qa-output", "config-topology");
const dataRoot = resolve(outputRoot, "runtime");
const runtimeHome = resolve(outputRoot, "runtime-home");
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
      providerTitleWidth: document.querySelector("#provider-deck-title")?.getBoundingClientRect().width ?? null,
      providerControlsOffscreen: expected === "sources"
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
  if (surface === "sources" && snapshot.providerTitleWidth < Math.min(180, page.viewportSize().width * 0.6)) {
    throw new Error(`provider heading was squeezed: ${JSON.stringify(snapshot)}`);
  }
  if (snapshot.providerControlsOffscreen.length) throw new Error(`provider controls are offscreen: ${JSON.stringify(snapshot)}`);
  return snapshot;
}

async function inspect(name, viewport, theme) {
  const { page, errors } = await openPage({ viewport, theme, route: "config/sources" });
  await waitForTopology(page);
  const screenshots = [];
  for (const surface of ["sources", "capabilities", "hooks", "local-runtime"]) {
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
    await skillToggle.click();
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
      await resetFaultDomainFixtures();
    }
  }
}
