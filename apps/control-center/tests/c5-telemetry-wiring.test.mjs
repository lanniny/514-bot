/**
 * C5 接线契约：关键导航/动作必须落到现有 ProductTelemetry 栈，
 * 不得另起第二套 analytics，也不得把 prompt/消息体带进埋点。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PRODUCT_ACTION_IDS, REGISTERED_CAPABILITIES, REGISTERED_VIEWS } from "../public/modules/product-telemetry-catalog.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

test("catalog 与 nav 同步，动作 id 都是 slug 安全标识符", () => {
  assert.ok(REGISTERED_VIEWS.includes("bot"));
  assert.ok(REGISTERED_VIEWS.includes("channels"));
  assert.ok(REGISTERED_VIEWS.length >= 14);
  for (const id of REGISTERED_CAPABILITIES) {
    assert.match(id, /^[A-Za-z0-9._:-]+$/);
  }
  assert.deepEqual(
    Object.values(PRODUCT_ACTION_IDS).sort(),
    [...REGISTERED_CAPABILITIES].sort(),
  );
});

test("app.js 把 C5 动作接到 trackProductAction，且不传 prompt/消息体", async () => {
  const app = await readFile(`${appRoot}/public/app.js`, "utf8");
  assert.match(app, /telemetry\.trackView\(view\)/);
  assert.match(app, /function trackProductAction\(/);
  assert.match(app, /PRODUCT_ACTION_IDS\.paletteInvoke/);
  assert.match(app, /PRODUCT_ACTION_IDS\.tourDismiss/);
  assert.match(app, /PRODUCT_ACTION_IDS\.tourComplete/);
  assert.match(app, /PRODUCT_ACTION_IDS\.skillSave/);
  assert.match(app, /PRODUCT_ACTION_IDS\.kickoffSend/);
  assert.match(app, /PRODUCT_ACTION_IDS\.channelOpen/);
  assert.match(app, /PRODUCT_ACTION_IDS\.valueProofLink/);
  assert.match(app, /onTrack: trackProductAction/);
  assert.match(app, /onOpen:\s*\(\)\s*=>\s*trackProductAction\(PRODUCT_ACTION_IDS\.paletteInvoke\)/);
  assert.match(app, /dismissProductTour\(\{ completed: true \}\)/);
  assert.doesNotMatch(app, /trackProductAction\([^)]*prompt/);
  assert.doesNotMatch(app, /trackAction\([^)]*prompt/);
});

test("命令面板只在打开时回调，不在输入路径埋点", async () => {
  const palette = await readFile(`${appRoot}/public/command-palette.js`, "utf8");
  assert.match(palette, /_onOpen = typeof opts\.onOpen === "function"/);
  assert.match(palette, /if \(!alreadyOpen\) \{\s*try \{ _onOpen\?\.\(\); \}/);
  assert.doesNotMatch(palette, /function onInput[\s\S]{0,400}_onOpen/);
});

test("健康看板消费 unusedViews / unusedCapabilities", async () => {
  const [panel, html] = await Promise.all([
    readFile(`${appRoot}/public/modules/product-health-panel.js`, "utf8"),
    readFile(`${appRoot}/public/index.html`, "utf8"),
  ]);
  assert.match(panel, /viewCoverageFromSummary/);
  assert.match(panel, /unusedViews/);
  assert.match(panel, /ph-actions-body/);
  assert.match(html, /id="ph-actions-body"/);
  assert.match(html, /id="ph-views-body"/);
});
