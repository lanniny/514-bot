/**
 * boot-auth-race.test.mjs — 启动期**凭据竞态**的真浏览器门禁。
 *
 * 为什么必须有这一层：这是 2026-09-11 LO 报障「重启后立刻跳认证警告」的根因——
 * `start()` 把凭据兑换放在 ~300 行 UI 初始化之后，于是 `initBotShell` 与各面板自举
 * 在 token 到手前就发了请求：**实测 8 条 401，全部早于 token 落定约 300ms**。
 *
 * 这个缺陷对**其它所有测试都是隐形的**：
 *   - 假 ctx 单测看不到浏览器启动时序；
 *   - `qa-bot-grok-parity` 只断言"最终渲染正确"，而请求**最终确实成功了**；
 *   - 源码静态断言只看得见"有调用"，看不见"调用发生在何时"。
 * 所以这里必须**真浏览器 + 计时**：不变量是「任何 /api 请求都不得在没有 Authorization 头时发出」。
 *
 * 判据不使用绝对耗时（机器快慢无关），只比较**两条时间线的先后**与**请求头的有无**。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { spawnTestServer, stopTestServer, waitForUrl } from "./server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

test("启动期不得在凭据到手前发出任何 /api 请求", { timeout: 120_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-boot-auth-race-"));
  const token = "boot-auth-race-token";
  const child = spawnTestServer({
    env: { CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_DATA_DIR: dataRoot, CONTROL_CENTER_PORT: "0" },
  });

  let browser;
  t.after(async () => {
    await browser?.close();
    await stopTestServer(child, { token }).catch(() => {});
    await rm(dataRoot, { recursive: true, force: true });
  });

  // 与桌面壳交付给 webview 的形态一致：完整 URL（含 bootstrap 凭据）
  const fullUrl = await waitForUrl(child);
  assert.match(fullUrl, /[?#]bootstrap=/, "测试前提：URL 必须带 bootstrap 凭据，否则测的不是这条路径");

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  // 打桩记录每个 /api 请求**发出时**是否已带 Authorization 头
  await page.addInitScript(() => {
    const original = window.fetch;
    window.__apiCalls = [];
    window.fetch = function patched(input, init) {
      try {
        const target = String(typeof input === "string" ? input : input?.url ?? "");
        if (target.includes("/api/")) {
          const headers = new Headers(init?.headers ?? (typeof input === "object" ? input.headers : undefined));
          window.__apiCalls.push({ url: target, hasAuth: headers.has("Authorization") });
        }
      } catch { /* 打桩不得影响被测行为 */ }
      return original.apply(this, arguments);
    };
  });

  const unauthorized = [];
  page.on("response", (response) => {
    if (response.status() === 401) unauthorized.push(response.url());
  });

  await page.goto(fullUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8000);

  const calls = await page.evaluate(() => window.__apiCalls ?? []);
  const withoutAuth = calls.filter((call) => !call.hasAuth);

  assert.ok(calls.length > 0, "应至少观测到若干 /api 请求——一条都没记到说明打桩失效，本门禁会假绿");
  assert.deepEqual(
    withoutAuth.map((call) => call.url),
    [],
    "任何 /api 请求都不得在无 Authorization 头时发出（凭据必须在初始化之前兑换）",
  );
  assert.deepEqual(unauthorized, [], "启动期不得出现 401——那正是「重启后立刻跳认证警告」的现场");
});
