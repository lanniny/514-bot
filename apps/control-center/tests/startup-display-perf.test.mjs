import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, waitForUrl } from "./server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

test("启动首帧壁纸态即刻激活且无白底阻塞", { timeout: 60_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-startup-perf-"));
  const token = "startup-perf-token";
  const child = spawnTestServer({
    env: { CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_DATA_DIR: dataRoot, CONTROL_CENTER_PORT: "0" },
  });

  let browser;
  t.after(async () => {
    await browser?.close();
    await stopTestServer(child, { token }).catch(() => {});
    await rm(dataRoot, { recursive: true, force: true });
  });

  const fullUrl = await waitForUrl(child);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  // 预设用户已配置了极光预设壁纸
  await context.addInitScript(() => {
    localStorage.setItem("514cc-global-wallpaper", JSON.stringify({
      preset: "aurora",
      fit: "cover",
      overrideTeam: true,
      hasCustom: false,
    }));
  });

  const page = await context.newPage();
  const started = Date.now();
  await page.goto(fullUrl, { waitUntil: "domcontentloaded" });
  const dclTime = Date.now() - started;

  // 1. 断言 DOMContentLoaded 时（Frame 0）壁纸激活态已先行成立
  const snapshot = await page.evaluate(() => {
    const htmlActive = document.documentElement.classList.contains("team-bg-active");
    const bodyActive = document.body.classList.contains("team-bg-active");
    const stage = document.querySelector(".atelier-stage");
    const stageDisplay = stage ? getComputedStyle(stage).display : "none";
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    return {
      htmlActive,
      bodyActive,
      stageDisplay,
      bodyBg,
      htmlTeamBg: document.documentElement.dataset.teamBg,
      bodyTeamBg: document.body.dataset.teamBg,
    };
  });

  assert.equal(snapshot.htmlActive, true, "首帧 html 必须带有 team-bg-active");
  assert.equal(snapshot.bodyActive, true, "首帧 body 必须带有 team-bg-active");
  assert.equal(snapshot.stageDisplay, "block", "首帧 .atelier-stage 必须为 display: block，不得被白底隐藏");
  assert.match(snapshot.bodyBg, /rgba\(0,\s*0,\s*0,\s*0\)|transparent/, "首帧 body 背景必须透明透出壁纸舞台");
  assert.equal(snapshot.htmlTeamBg, "aurora", "首帧 data-team-bg 必须正确预置");
  assert.equal(snapshot.bodyTeamBg, "aurora", "首帧 body data-team-bg 必须正确预置");

  // 2. 等待完整初始化
  await page.waitForSelector(".bot-composer-row", { timeout: 10_000 });
  const fullyReady = Date.now() - started;

  console.log(`[startup-display-perf] domcontentloaded=${dclTime}ms, fullReady=${fullyReady}ms`);
});

test("自定义壁纸偏好在首帧即刻激活且无白底", { timeout: 60_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-startup-perf-custom-"));
  const token = "startup-perf-custom-token";
  const child = spawnTestServer({
    env: { CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_DATA_DIR: dataRoot, CONTROL_CENTER_PORT: "0" },
  });

  let browser;
  t.after(async () => {
    await browser?.close();
    await stopTestServer(child, { token }).catch(() => {});
    await rm(dataRoot, { recursive: true, force: true });
  });

  const fullUrl = await waitForUrl(child);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  await context.addInitScript(() => {
    localStorage.setItem("514cc-global-wallpaper", JSON.stringify({
      preset: "custom",
      fit: "cover",
      overrideTeam: true,
      hasCustom: true,
    }));
  });

  const page = await context.newPage();
  await page.goto(fullUrl, { waitUntil: "domcontentloaded" });

  const snapshot = await page.evaluate(() => {
    return {
      htmlActive: document.documentElement.classList.contains("team-bg-active"),
      bodyActive: document.body.classList.contains("team-bg-active"),
      stageDisplay: getComputedStyle(document.querySelector(".atelier-stage")).display,
      htmlTeamBg: document.documentElement.dataset.teamBg,
      bodyTeamBg: document.body.dataset.teamBg,
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
  });

  assert.equal(snapshot.htmlActive, true, "自定义壁纸在首帧 html 必须激活 team-bg-active");
  assert.equal(snapshot.bodyActive, true, "自定义壁纸在首帧 body 必须激活 team-bg-active");
  assert.equal(snapshot.stageDisplay, "block", "自定义壁纸在首帧舞台必须为 block");
  assert.match(snapshot.bodyBg, /rgba\(0,\s*0,\s*0,\s*0\)|transparent/);
  assert.equal(snapshot.htmlTeamBg, "custom");
  assert.equal(snapshot.bodyTeamBg, "custom");
});

test("服务端持久化偏好在新端口/空 localStorage 首帧即刻水合（消灭两段式黑白屏闪烁）", { timeout: 60_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-startup-perf-boot-"));
  const token = "startup-perf-boot-token";
  // 模拟桌面壳在磁盘上已有已保存的偏好（浅色模式 + 极光壁纸）
  await writeFile(join(dataRoot, "preferences.json"), JSON.stringify({
    "514cc-control-theme": "light",
    "514cc-global-wallpaper": JSON.stringify({
      preset: "aurora",
      fit: "cover",
      overrideTeam: true,
      hasCustom: false,
    }),
  }), "utf8");

  const child = spawnTestServer({
    env: { CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_DATA_DIR: dataRoot, CONTROL_CENTER_PORT: "0" },
  });

  let browser;
  t.after(async () => {
    await browser?.close();
    await stopTestServer(child, { token }).catch(() => {});
    await rm(dataRoot, { recursive: true, force: true });
  });

  const fullUrl = await waitForUrl(child);
  browser = await chromium.launch();
  // 模拟全新端口/空白存储环境：不注入任何 localStorage！
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  await page.goto(fullUrl, { waitUntil: "domcontentloaded" });

  // 1. 断言在 DOMContentLoaded 时（0ms），来自服务端的偏好已在首帧水合到位
  const snapshot = await page.evaluate(() => {
    return {
      theme: document.documentElement.dataset.theme,
      htmlActive: document.documentElement.classList.contains("team-bg-active"),
      bodyActive: document.body.classList.contains("team-bg-active"),
      stageDisplay: getComputedStyle(document.querySelector(".atelier-stage")).display,
      htmlTeamBg: document.documentElement.dataset.teamBg,
      bodyTeamBg: document.body.dataset.teamBg,
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
  });

  assert.equal(snapshot.theme, "light", "首帧即为浅色，绝不回退至暗色骨架屏闪烁");
  assert.equal(snapshot.htmlActive, true, "空存储新端口首帧必须激活 team-bg-active");
  assert.equal(snapshot.bodyActive, true, "空存储新端口首帧 body 必须带有 team-bg-active");
  assert.equal(snapshot.stageDisplay, "block", "舞台首帧必须 display: block");
  assert.equal(snapshot.htmlTeamBg, "aurora", "壁纸预设首帧即成立");
  assert.match(snapshot.bodyBg, /rgba\(0,\s*0,\s*0,\s*0\)|transparent/);

  // 2. 等待完整初始化后，确认壁纸从未被剥离，主题也未发生抖动
  await page.waitForSelector(".bot-composer-row", { timeout: 10_000 });
  const steadySnapshot = await page.evaluate(() => {
    return {
      theme: document.documentElement.dataset.theme,
      htmlActive: document.documentElement.classList.contains("team-bg-active"),
      bodyActive: document.body.classList.contains("team-bg-active"),
      stageDisplay: getComputedStyle(document.querySelector(".atelier-stage")).display,
    };
  });

  assert.equal(steadySnapshot.theme, "light", "稳定态保持浅色");
  assert.equal(steadySnapshot.htmlActive, true, "稳定态壁纸保持激活状态，绝不剥离变白底");
  assert.equal(steadySnapshot.bodyActive, true);
  assert.equal(steadySnapshot.stageDisplay, "block");
});
