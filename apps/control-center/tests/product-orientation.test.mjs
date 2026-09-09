import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NAV_ITEMS } from "../public/modules/nav-config.js";
import {
  BOT_PALETTE_ACTIONS,
  BOT_SETTINGS_TABS,
  listStaticPaletteCatalog,
} from "../public/modules/palette-catalog.js";
import {
  BOT_ORIENTATION_SPOTLIGHT,
  PRODUCT_TOUR_DISMISS_KEY,
  PRODUCT_TOUR_STEPS,
  capabilityMapMarkup,
  listCapabilityMapItems,
  listProductTourSteps,
  productTourStepMarkup,
  productTourStepModel,
  readProductTourDismissed,
  resolveOrientationRef,
  shouldAutoStartProductTour,
  writeProductTourDismissed,
} from "../public/modules/product-orientation.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

function memoryStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (key) => (Object.hasOwn(store, key) ? store[key] : null),
    setItem: (key, value) => {
      store[key] = String(value);
    },
    removeItem: (key) => {
      delete store[key];
    },
    dump: () => ({ ...store }),
  };
}

test("tour dismiss uses the existing 514cc-* localStorage prefs key and stays dismissed", () => {
  const storage = memoryStorage();
  assert.equal(PRODUCT_TOUR_DISMISS_KEY, "514cc-product-tour-dismissed");
  assert.equal(shouldAutoStartProductTour(storage), true);
  assert.equal(readProductTourDismissed(storage), false);
  assert.equal(writeProductTourDismissed(true, storage), true);
  assert.equal(storage.dump()[PRODUCT_TOUR_DISMISS_KEY], "1");
  assert.equal(shouldAutoStartProductTour(storage), false);
  assert.equal(readProductTourDismissed(storage), true);
  assert.equal(writeProductTourDismissed(false, storage), true);
  assert.equal(storage.dump()[PRODUCT_TOUR_DISMISS_KEY], undefined);
  assert.equal(shouldAutoStartProductTour(storage), true);
});

test("tour dismiss write failure does not invent a second prefs store", () => {
  const storage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {
      throw new Error("blocked");
    },
  };
  assert.equal(readProductTourDismissed(storage), false);
  assert.equal(writeProductTourDismissed(true, storage), false);
  assert.equal(shouldAutoStartProductTour(storage), true);
});

test("capability map lists real palette-catalog / nav-config destinations", () => {
  const catalogIds = new Set(listStaticPaletteCatalog().map((item) => item.id));
  const items = listCapabilityMapItems({ settlementPresent: true, channelStatus: "ready" });
  assert.ok(items.length >= 6, `map only resolved ${items.length} items`);
  for (const item of items) {
    assert.ok(item.ref && item.label && item.id, `incomplete map row ${item.ref}`);
    if (item.ref.startsWith("nav:")) {
      assert.ok(Object.hasOwn(NAV_ITEMS, item.view), `map nav ${item.ref} missing from NAV_ITEMS`);
      assert.ok(catalogIds.has(item.view), `map nav ${item.view} missing from palette catalog`);
    } else if (item.ref.startsWith("action:")) {
      assert.ok(catalogIds.has(item.id), `map action ${item.id} missing from palette catalog`);
      assert.ok(BOT_PALETTE_ACTIONS.some((action) => action.id === item.id), `map action ${item.id} not in BOT_PALETTE_ACTIONS`);
    } else if (item.ref.startsWith("settings:")) {
      const tab = item.ref.slice("settings:".length);
      assert.ok(BOT_SETTINGS_TABS.some((entry) => entry.id === tab), `map settings ${tab} missing`);
    } else if (item.ref === "surface:settlement-evidence") {
      assert.equal(item.action, "bot:evidence");
    } else {
      assert.fail(`unexpected map ref ${item.ref}`);
    }
  }
  const spotlightRefs = new Set(BOT_ORIENTATION_SPOTLIGHT.map((item) => item.ref));
  for (const item of items) {
    assert.ok(spotlightRefs.has(item.ref), `map emitted unregistered ${item.ref}`);
  }
});

test("capability map and tour stay honest when channels are gated", () => {
  const gated = listCapabilityMapItems({ channelStatus: "gated", settlementPresent: true });
  const channel = gated.find((item) => item.gate === "channels");
  assert.ok(channel, "channels spotlight missing");
  assert.equal(channel.available, false);
  assert.equal(channel.status, "gated");
  assert.match(channel.reason, /门闸/);
  const html = capabilityMapMarkup(gated);
  assert.match(html, /is-gated/);
  assert.match(html, /暂不可用/);
  assert.match(html, /data-capability-action="view:security"/);
  assert.doesNotMatch(html, /已接通 Telegram/);

  const step = productTourStepModel(PRODUCT_TOUR_STEPS.findIndex((item) => item.id === "routines-channels"), {
    channelStatus: "gated",
    settlementPresent: true,
  });
  assert.equal(step.status, "gated");
  assert.match(productTourStepMarkup(step), /门闸/);
});

test("settlement tour/map rows drop when the evidence surface is absent", () => {
  const withSurface = listProductTourSteps({ settlementPresent: true });
  const withoutSurface = listProductTourSteps({ settlementPresent: false });
  assert.ok(withSurface.some((step) => step.id === "settlement"));
  assert.ok(!withoutSurface.some((step) => step.id === "settlement"));
  const map = listCapabilityMapItems({ settlementPresent: false, channelStatus: "empty" });
  assert.ok(!map.some((item) => item.ref === "surface:settlement-evidence"));
  const emptyChannels = map.find((item) => item.gate === "channels");
  assert.equal(emptyChannels.status, "empty");
  assert.equal(emptyChannels.available, true);
});

test("every tour spotlight resolves to a live registry destination", () => {
  for (const step of listProductTourSteps({ settlementPresent: true })) {
    const resolved = resolveOrientationRef(step.spotlight);
    assert.ok(resolved, `tour step ${step.id} spotlight ${step.spotlight} is stale`);
    assert.ok(resolved.label);
  }
  const first = productTourStepModel(0, { settlementPresent: true });
  assert.equal(first.isFirst, true);
  assert.equal(first.index, 0);
  assert.match(productTourStepMarkup(first), /1 \/ /);
});

test("Bot shell wires tour persist, palette/help entries, and capability map overlay", async () => {
  const [app, html, catalog, css] = await Promise.all([
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/modules/palette-catalog.js`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-grok-parity.css`, "utf8"),
  ]);
  assert.match(catalog, /id: "bot:product-tour"/);
  assert.match(catalog, /id: "bot:capability-map"/);
  assert.match(html, /id="bot-product-tour-dialog"/);
  assert.match(html, /id="bot-capability-map-dialog"/);
  assert.match(html, /data-bot-action="product-tour"/);
  assert.match(html, /data-bot-action="capability-map"/);
  assert.match(html, /data-bot-action="product-tour-reset"/);
  assert.match(app, /from "\.\/modules\/product-orientation\.js"/);
  assert.match(app, /function openProductTour\(/);
  assert.match(app, /function openCapabilityMap\(/);
  assert.match(app, /function maybeStartProductTour\(/);
  assert.match(app, /writeProductTourDismissed\(true\)/);
  assert.match(app, /shouldAutoStartProductTour\(\)/);
  assert.match(app, /case "bot:product-tour"/);
  assert.match(app, /case "bot:capability-map"/);
  assert.match(app, /label: "产品导览"/);
  assert.match(app, /label: "能力地图"/);
  assert.match(app, /REMOTE_GATE_BLOCKED/);
  assert.match(css, /Phase C3：产品导览/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.bot-capability-card/);
});
