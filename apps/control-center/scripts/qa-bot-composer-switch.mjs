#!/usr/bin/env node

// Composer 运行选项会话跟随 QA（LO 2026-09-12 实测回归）：
// 切换会话时，「直接发送给 / 团队 / 模型 / Effort / 权限 / 预算」必须跟随当前会话，
// 不允许把上一个会话的 DOM 残值带进下一次发送。守卫点：
//   1. direct 会话 A(claude-fable, 席位模型 fable) → B(grok-build, 无默认模型)：
//      切到 B 后模型下拉必须回到「跟随运行席位」(value="")，不得残留 A 的 fable。
//   2. 权限/预算按会话记忆：A 改 build/$20，切 B 回默认 plan/$5，切回 A 恢复 build/$20。
//   3. 群聊的「直接发送给」默认空选择（广播全体），占位 option 必须存在且选中，
//      不得静默预选第一个成员把群消息定向成点对点。

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "../tests/server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const token = "bot-composer-switch-qa-token-0123456789";

function removeTree(path) {
  return rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}

async function writeConfig(repoRoot) {
  await mkdir(resolve(repoRoot, "config/control-center"), { recursive: true });
  await writeFile(resolve(repoRoot, "config/app.json"), '{"enabled":true}\n');
  await writeFile(resolve(repoRoot, "config/control-center/models.json"), JSON.stringify({
    version: 1,
    profiles: testModelProfiles(),
  }));
  await writeFile(resolve(repoRoot, "config/control-center/routing.json"), JSON.stringify({
    version: 1,
    primaryCoordinator: "claude-fable",
    technicalExecutor: "codex-technical",
    maxRounds: 6,
    maxDepth: 2,
    maxParallelAgents: 4,
    requireHealthyProvider: false,
    failOnUnavailableExplicitProvider: false,
    weights: { quality: 0.44, speed: 0.26, health: 0.22, cost: 0.08 },
    rules: [],
    independentPass: { requiredFor: [], mustDifferFromPrimary: true },
  }));
  await writeFile(resolve(repoRoot, "config/control-center/permissions.json"), JSON.stringify({
    version: 1,
    defaultMode: "plan",
    modes: {
      plan: { write: false, approvalRequired: false },
      build: { write: "workspace", approvalRequired: true },
    },
    limits: { maxRounds: 6, maxBudgetUsdPerTurn: 2, turnTimeoutMs: 10_000 },
    approval: { ttlMs: 60_000 },
  }));
  await writeFile(resolve(repoRoot, "config/control-center/sources.json"), JSON.stringify({
    version: 1,
    explicit: [
      { id: "control.models", path: "config/control-center/models.json", label: "models", kind: "json", scope: "repo", critical: true },
      { id: "control.routing", path: "config/control-center/routing.json", label: "routing", kind: "json", scope: "repo", critical: true },
      { id: "control.permissions", path: "config/control-center/permissions.json", label: "permissions", kind: "json", scope: "repo", critical: true },
      { id: "control.sources", path: "config/control-center/sources.json", label: "sources", kind: "json", scope: "repo", critical: true },
    ],
    discover: [],
    runtime: [],
  }));
}

async function main() {
  const root = await mkdtemp(resolve(tmpdir(), "514cc-qa-composer-switch-"));
  const repoRoot = resolve(root, "repo");
  const dataRoot = resolve(root, "data");
  const fakeHome = resolve(root, "home");
  await writeConfig(repoRoot);
  await mkdir(fakeHome, { recursive: true });

  const child = spawnTestServer({
    env: {
      CONTROL_CENTER_TOKEN: token,
      CONTROL_CENTER_REPO_ROOT: repoRoot,
      CONTROL_CENTER_DATA_DIR: dataRoot,
      CONTROL_CENTER_PORT: "0",
      HOME: fakeHome,
      USERPROFILE: fakeHome,
    },
  });
  let browser;
  try {
    const bootstrapUrl = await waitForUrl(child);
    const origin = new URL(bootstrapUrl).origin;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const api = async (path, { method = "GET", body } = {}) => {
      const response = await fetch(new URL(path, origin), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const payload = await response.json();
      assert.ok(response.ok, `${method} ${path} failed (${response.status}): ${JSON.stringify(payload)}`);
      return payload;
    };
    const createConversation = async (body) => (await api("/api/conversations", { method: "POST", body })).conversation;

    const convA = await createConversation({ kind: "direct", title: "A fable 单聊", directMemberId: "claude-fable" });
    const convB = await createConversation({ kind: "direct", title: "B grok 单聊", directMemberId: "grok-build" });
    const project = (await api("/api/projects", {
      method: "POST",
      body: { title: "Composer switch workspace", cwd: repoRoot },
    })).project;
    const groupConv = await createConversation({
      kind: "workspace_group",
      title: "群聊广播默认",
      projectId: project.projectId ?? project.id,
      roomRole: "task",
      memberIds: ["claude-fable", "grok-build"],
    });

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !/^Failed to load resource:/.test(message.text())) consoleErrors.push(message.text());
    });
    await page.addInitScript((accessToken) => {
      sessionStorage.setItem("514cc-control-token", accessToken);
      localStorage.setItem("514cc-product-tour-dismissed", "1");
    }, token);
    await page.goto(`${origin}/#bot`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true,
      null,
      { timeout: 30_000 },
    );

    const row = (id) => page.locator(`[data-bot-conversation="${id}"]`).first();
    for (const id of [convA.id, convB.id, groupConv.id]) {
      await row(id).waitFor({ state: "visible", timeout: 20_000 });
    }

    const composerState = () => page.evaluate(() => ({
      recipient: document.querySelector("#bot-composer-recipient")?.value ?? null,
      recipientLabel: document.querySelector("#bot-composer-recipient")?.selectedOptions?.[0]?.textContent?.trim() ?? null,
      hasBroadcastOption: [...(document.querySelector("#bot-composer-recipient")?.options || [])]
        .some((option) => option.value === "" && option.textContent.includes("当前会话成员")),
      model: document.querySelector("#bot-next-model")?.value ?? null,
      effort: document.querySelector("#bot-next-effort")?.value ?? null,
      permission: document.querySelector("#workspace-next-permission")?.value ?? null,
      budget: document.querySelector("#workspace-next-budget")?.value ?? null,
    }));
    const openConversation = async (id) => {
      await row(id).click();
      await page.waitForFunction(
        (conversationId) => document.querySelector(`[data-bot-conversation="${conversationId}"]`)?.classList.contains("is-active") === true,
        id,
        { timeout: 10_000 },
      );
    };
    // 权限/预算在折叠的「运行选项」面板里：展开一次，后续 selectOption 才可点。
    await page.evaluate(() => { const panel = document.querySelector("#bot-composer-overflow"); if (panel) panel.open = true; });

    // 1) 会话 A：recipient 归属 claude-fable，模型跟随其席位默认 fable，权限/预算为全局默认。
    await openConversation(convA.id);
    const stateA1 = await composerState();
    assert.equal(stateA1.recipient, "claude-fable", JSON.stringify(stateA1));
    assert.equal(stateA1.model, "fable", JSON.stringify(stateA1));
    assert.equal(stateA1.permission, "plan", JSON.stringify(stateA1));
    assert.equal(stateA1.budget, "5", JSON.stringify(stateA1));

    // 2) 在 A 里改权限/预算（change 监听应写入会话级存储）。
    await page.selectOption("#workspace-next-permission", "build");
    await page.selectOption("#workspace-next-budget", "20");

    // 3) 切到 B：模型必须回到「跟随运行席位」——旧实现会把 A 的 fable 残留到 B。
    await openConversation(convB.id);
    const stateB1 = await composerState();
    assert.equal(stateB1.recipient, "grok-build", JSON.stringify(stateB1));
    assert.equal(stateB1.model, "", JSON.stringify(stateB1));
    assert.equal(stateB1.permission, "plan", JSON.stringify(stateB1));
    assert.equal(stateB1.budget, "5", JSON.stringify(stateB1));

    // 4) B 里改预算，再切回 A：A 的 build/$20 必须按会话恢复，B 的改动不得串扰。
    await page.selectOption("#workspace-next-budget", "3");
    await openConversation(convA.id);
    const stateA2 = await composerState();
    assert.equal(stateA2.recipient, "claude-fable", JSON.stringify(stateA2));
    assert.equal(stateA2.model, "fable", JSON.stringify(stateA2));
    assert.equal(stateA2.permission, "build", JSON.stringify(stateA2));
    assert.equal(stateA2.budget, "20", JSON.stringify(stateA2));
    await openConversation(convB.id);
    const stateB2 = await composerState();
    assert.equal(stateB2.budget, "3", JSON.stringify(stateB2));

    // 5) 群聊：recipient 默认空选择（广播全体），占位 option 存在且选中。
    await openConversation(groupConv.id);
    const stateGroup = await composerState();
    assert.equal(stateGroup.recipient, "", JSON.stringify(stateGroup));
    assert.equal(stateGroup.hasBroadcastOption, true, JSON.stringify(stateGroup));
    assert.equal(stateGroup.permission, "plan", JSON.stringify(stateGroup));
    assert.equal(stateGroup.budget, "5", JSON.stringify(stateGroup));

    // 6) 再回 A：会话记忆仍在。
    await openConversation(convA.id);
    const stateA3 = await composerState();
    assert.equal(stateA3.permission, "build", JSON.stringify(stateA3));
    assert.equal(stateA3.budget, "20", JSON.stringify(stateA3));

    assert.deepEqual(pageErrors, [], `page errors: ${JSON.stringify(pageErrors)}`);
    assert.deepEqual(consoleErrors, [], `console errors: ${JSON.stringify(consoleErrors)}`);
    console.log("PASS qa-bot-composer-switch: composer 运行选项随会话切换/恢复/广播默认全部符合预期");
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopTestServer(child, { token }).catch(() => {});
    await removeTree(root).catch(() => {});
  }
}

main().catch((error) => {
  console.error("FAIL qa-bot-composer-switch:", error?.message ?? error);
  process.exit(1);
});
