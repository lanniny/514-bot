// live 配置热加载：live 回读 → 漂移清单 → 对话框按 live 预填 + 双向切换 → 轮询归属。
// 根因场景（LO 2026-08-13）：~/.grok/config.toml 已是 grok-4.6，供应商编辑框仍显示 grok-4.5。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const [appSource, html, css, stateSource, apiSource, serverSource] = await Promise.all([
  readFile(`${appRoot}/public/app.js`, "utf8"),
  readFile(`${appRoot}/public/index.html`, "utf8"),
  readFile(`${appRoot}/public/styles.css`, "utf8"),
  readFile(`${appRoot}/public/state.js`, "utf8"),
  readFile(`${appRoot}/public/api.js`, "utf8"),
  readFile(`${appRoot}/server.mjs`, "utf8"),
]);

function sourceSection(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return appSource.slice(start, end);
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

/** 装载被测的三个纯函数，注入假 state/elements。 */
function loadLiveDriftKit({ live = {}, targetApp = "grokbuild", inputs = {} } = {}) {
  const elements = {};
  for (const [id, seed] of Object.entries(inputs)) elements[id] = { value: seed };
  const bar = { innerHTML: "", hidden: true, dataset: {} };
  elements["provider-live-drift"] = bar;
  const state = {
    providersData: { live },
    providerDialogTargetApp: targetApp,
    providerDialogLiveDrift: [],
  };
  const factory = new Function("state", "elements", "escapeHtml", `
    ${sourceSection("const PROVIDER_LIVE_FIELD_INPUTS", "/** 拖拽排序（HTML5 DnD）")}
    ${sourceSection("function applyProviderLiveDriftValues", "/** 端点列表渲染")}
    return { PROVIDER_LIVE_FIELD_INPUTS, providerLiveDriftOf, applyProviderLiveDriftValues, renderProviderLiveDriftNotice };
  `);
  return { state, elements, bar, ...factory(state, elements, escapeHtml) };
}

const GROK_LIVE = {
  grokbuild: {
    baseUrl: "https://514claude.xyz/v1",
    model: "grok-4.6",
    profile: "grok-4.6",
    apiBackend: "responses",
    contextWindow: 500000,
    matchedProviderId: "p-514",
    official: false,
    drift: [
      { field: "profile", label: "客户端模型档位", live: "grok-4.6", stored: "grok-4.5" },
      { field: "model", label: "默认模型", live: "grok-4.6", stored: "grok-4.5" },
    ],
  },
};

test("providerLiveDriftOf：只有 live 认亲到这个档案才算漂移", () => {
  const kit = loadLiveDriftKit({ live: GROK_LIVE });
  assert.deepEqual(kit.providerLiveDriftOf("p-514", "grokbuild").map((entry) => entry.field), ["profile", "model"]);
  assert.deepEqual(kit.providerLiveDriftOf("p-other", "grokbuild"), []); // 认亲的是别人
  assert.deepEqual(kit.providerLiveDriftOf(null, "grokbuild"), []); // 新建档案
  assert.deepEqual(kit.providerLiveDriftOf("p-514", "codex"), []); // live 里没这个 app
  assert.deepEqual(kit.providerLiveDriftOf("p-514", null), []);

  // 没有对应对话框控件的字段一律滤掉——不能报一个用户改不到的漂移
  const unmappable = loadLiveDriftKit({
    live: { grokbuild: { matchedProviderId: "p-514", drift: [{ field: "somethingElse", label: "x", live: "a", stored: "b" }] } },
  });
  assert.deepEqual(unmappable.providerLiveDriftOf("p-514", "grokbuild"), []);
});

test("applyProviderLiveDriftValues：live↔档案 双向写入表单，只碰漂移字段", () => {
  const kit = loadLiveDriftKit({
    live: GROK_LIVE,
    inputs: {
      "provider-grokbuild-profile": "grok-4.5",
      "provider-grokbuild-model": "grok-4.5",
      "provider-grokbuild-backend": "responses",
      "provider-baseurl-input": "https://514claude.xyz/v1",
    },
  });
  kit.state.providerDialogLiveDrift = kit.providerLiveDriftOf("p-514", "grokbuild");

  kit.applyProviderLiveDriftValues("live");
  assert.equal(kit.elements["provider-grokbuild-profile"].value, "grok-4.6");
  assert.equal(kit.elements["provider-grokbuild-model"].value, "grok-4.6");
  assert.equal(kit.elements["provider-grokbuild-backend"].value, "responses"); // 未漂移字段不动
  assert.equal(kit.elements["provider-baseurl-input"].value, "https://514claude.xyz/v1");

  kit.applyProviderLiveDriftValues("stored");
  assert.equal(kit.elements["provider-grokbuild-profile"].value, "grok-4.5");
  assert.equal(kit.elements["provider-grokbuild-model"].value, "grok-4.5");

  // 控件缺席不炸（对话框里某个 app 的字段没渲染时）
  const partial = loadLiveDriftKit({ live: GROK_LIVE, inputs: { "provider-grokbuild-model": "x" } });
  partial.state.providerDialogLiveDrift = partial.providerLiveDriftOf("p-514", "grokbuild");
  partial.applyProviderLiveDriftValues("live");
  assert.equal(partial.elements["provider-grokbuild-model"].value, "grok-4.6");
});

test("renderProviderLiveDriftNotice：差异逐条摆出来，never 静默采用", () => {
  const kit = loadLiveDriftKit({ live: GROK_LIVE });
  kit.state.providerDialogLiveDrift = kit.providerLiveDriftOf("p-514", "grokbuild");

  kit.renderProviderLiveDriftNotice("live");
  assert.equal(kit.bar.hidden, false);
  assert.equal(kit.bar.dataset.source, "live");
  // live 值与档案值都必须出现——只显示一边就是在骗人
  assert.match(kit.bar.innerHTML, /live grok-4\.6/);
  assert.match(kit.bar.innerHTML, /档案 grok-4\.5/);
  assert.match(kit.bar.innerHTML, /客户端模型档位/);
  assert.match(kit.bar.innerHTML, /默认模型/);
  assert.match(kit.bar.innerHTML, /填充 2 个字段/);
  // 按钮切到反向状态，给一键还原
  assert.match(kit.bar.innerHTML, /data-provider-live-drift="stored"[^>]*>改回档案值</);

  kit.renderProviderLiveDriftNotice("stored");
  assert.equal(kit.bar.dataset.source, "stored");
  assert.match(kit.bar.innerHTML, /data-provider-live-drift="live"[^>]*>采用 live 值</);
  assert.match(kit.bar.innerHTML, /2 项不一致/);

  // 无漂移 = 通知条彻底收起，不留空壳
  const clean = loadLiveDriftKit({ live: { grokbuild: { matchedProviderId: "p-514", drift: [] } } });
  clean.state.providerDialogLiveDrift = [];
  clean.renderProviderLiveDriftNotice("live");
  assert.equal(clean.bar.hidden, true);
  assert.equal(clean.bar.innerHTML, "");
});

test("live 漂移值经 escapeHtml 出栈——config.toml 是外部可写文件，不能当可信 HTML", () => {
  const kit = loadLiveDriftKit({
    live: {
      grokbuild: {
        matchedProviderId: "p-514",
        drift: [{ field: "model", label: "默认模型", live: '<img src=x onerror="alert(1)">', stored: "grok-4.5" }],
      },
    },
  });
  kit.state.providerDialogLiveDrift = kit.providerLiveDriftOf("p-514", "grokbuild");
  kit.renderProviderLiveDriftNotice("live");
  assert.doesNotMatch(kit.bar.innerHTML, /<img/);
  assert.match(kit.bar.innerHTML, /&lt;img/);
});

test("对话框在配置预览干跑之前完成 live 预填，预览显示的才是保存后会写入的值", () => {
  const fill = sourceSection("function fillProviderDialog", "/** 把漂移字段整批写成");
  const driftAt = fill.indexOf("state.providerDialogLiveDrift = providerLiveDriftOf(");
  const previewAt = fill.indexOf("void loadProviderConfigPreview()");
  assert.notEqual(driftAt, -1);
  assert.notEqual(previewAt, -1);
  assert.ok(driftAt < previewAt, "live 预填必须早于配置预览干跑");
  assert.match(fill, /applyProviderLiveDriftValues\("live"\)/);
  assert.match(fill, /renderProviderLiveDriftNotice\("live"\)/);
  assert.match(stateSource, /providerDialogLiveDrift:\s*\[\]/);
  assert.match(html, /id="provider-live-drift"[^>]*hidden/);
  assert.match(css, /\.provider-live-drift\s*\{/);
  assert.match(css, /\.provider-badge\.is-live-drift\s*\{/);
});

test("通知条按钮走对话框事件委托，只改表单不落盘", () => {
  assert.match(appSource, /const driftToggle = event\.target\.closest\("\[data-provider-live-drift\]"\)/);
  assert.match(appSource, /applyProviderLiveDriftValues\(next\);\s*\n\s*renderProviderLiveDriftNotice\(next\);/);
  // 切换后重算预览；但不得触发保存/切换类请求
  const handler = sourceSection('const driftToggle = event.target.closest("[data-provider-live-drift]")', "const endpointRemove");
  assert.match(handler, /loadProviderConfigPreview\(\)/);
  assert.doesNotMatch(handler, /API\.provider(Switch|s)\b|method: "P(OST|UT)"/);
});

test("live 轮询：只在供应商面可见时开，远程配置目标生效时不开，后台不空转", () => {
  const poll = sourceSection("function providerLiveViewVisible", "function providerById");
  assert.match(poll, /state\.view === "config"/);
  assert.match(poll, /state\.configSurface === "sources"/);
  assert.match(poll, /state\.runtimeWorkspaceMode === "seats"/);
  assert.match(poll, /!state\.configHostId/);
  assert.match(poll, /document\.visibilityState !== "hidden"/);
  // 只换 live 段，不动档案列表；内容没变就不重画（避免每 8 秒销毁一次焦点）
  assert.match(poll, /state\.providersData\.live = payload\.live/);
  assert.match(poll, /JSON\.stringify\(state\.providersData\.live \?\? \{\}\) === JSON\.stringify\(payload\.live\)/);
  assert.match(poll, /if \(providerLiveInFlight \|\| !state\.providersData \|\| state\.providersData\.error\) return/);
  // 轮询失败静默重试，不弹 toast 打扰
  assert.doesNotMatch(poll, /toast\(/);
  // 开停归属挂在视图/面板切换与前后台切换上
  assert.match(appSource, /reconcileProviderLivePoll\(\); \/\/ 离开配置页即停轮询/);
  assert.match(appSource, /reconcileProviderLivePoll\(\); \/\/ 席位连接区进出即开停 live 轮询/);
  assert.match(appSource, /document\.addEventListener\("visibilitychange", \(\) => \{\s*\n\s*reconcileProviderLivePoll\(\);/);
  assert.match(appSource, /window\.addEventListener\("focus", \(\) => \{\s*\n\s*if \(providerLiveViewVisible\(\)\) void refreshProviderLive\(\);/);
});

test("行徽标文案自解释：不用 ≠ 这类符号，沿用 live 行同一语汇", () => {
  // LO 2026-08-14 一眼没读懂 "live≠档案 2"——徽标不能靠 hover 才说得清自己
  const badge = appSource.match(/is-live-drift"[\s\S]{0,400}?>([^<]*)<\/span>/)?.[1] ?? "";
  assert.notEqual(badge, "");
  assert.match(badge, /live \$\{drift\.length\} 项不同/);
  assert.doesNotMatch(badge, /≠|!=|<>/);
  // 悬浮仍给逐字段全文（徽标短、title 全）
  assert.match(appSource, /live 配置与档案不一致：\$\{drift\.map/);
  // 同页用词统一：live 行也用 "live" 而不是别的叫法
  assert.match(appSource, /`live：\$\{escapeHtml\(liveInfo\.baseUrl\)\}/);
});

test("live 轮询端点只回 live 段，且排在 :id 路由之前", () => {
  assert.match(apiSource, /providerLive: "\/api\/providers\/live"/);
  assert.match(serverSource, /pathname === "\/api\/providers\/live"\) \{\s*\n\s*return json\(response, 200, \{ live: await state\.providers\.liveStatus\(\) \}\);/);
  const liveAt = serverSource.indexOf('pathname === "/api/providers/live"');
  const idAt = serverSource.indexOf("/api/providers/${");
  assert.notEqual(liveAt, -1);
  if (idAt !== -1) assert.ok(liveAt < idAt, "literal live 路由必须先于 :id 匹配");
});
