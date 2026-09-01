import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeSeatManager } from "../public/modules/runtime-seat-manager.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("concurrent runtime-seat loads await one shared snapshot instead of returning early", async (t) => {
  const previousDocument = globalThis.document;
  const elements = new Map([
    ["runtime-seat-editor-empty", { hidden: true }],
    ["runtime-seat-form", { hidden: false }],
  ]);
  globalThis.document = {
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: () => [],
  };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });

  const templateRequest = deferred();
  const seatRequest = deferred();
  const requests = [];
  const state = {
    adapterTemplatesData: null,
    runtimeSeatsData: null,
    runtimeSeatsLoading: false,
    selectedRuntimeSeatId: null,
    configRuntimeFocusId: null,
  };
  const manager = createRuntimeSeatManager({
    state,
    api: { adapterTemplates: "/api/adapter-templates", runtimeSeats: "/api/runtime-seats" },
    request: (path) => {
      requests.push(path);
      return path === "/api/adapter-templates" ? templateRequest.promise : seatRequest.promise;
    },
    escapeHtml: String,
    toast: () => {},
    confirmAction: async () => true,
  });

  const first = manager.load({ fresh: true });
  const concurrent = manager.load();
  templateRequest.resolve({ templates: [] });
  seatRequest.resolve({ seats: [], runtimeProfiles: [] });

  assert.deepEqual(await Promise.all([first, concurrent]), [true, true]);
  assert.deepEqual(requests.sort(), ["/api/adapter-templates", "/api/runtime-seats"]);
  assert.equal(state.runtimeSeatsLoading, false);
  assert.deepEqual(state.adapterTemplatesData.templates, []);
  assert.deepEqual(state.runtimeSeatsData.seats, []);
});

test("failed fresh runtime-seat load invalidates the previous snapshot and remains retryable", async (t) => {
  const previousDocument = globalThis.document;
  const elements = new Map([
    ["runtime-seat-editor-empty", { hidden: true }],
    ["runtime-seat-form", { hidden: false }],
  ]);
  globalThis.document = {
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: () => [],
  };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });

  const state = {
    adapterTemplatesData: { templates: [] },
    runtimeSeatsData: { seats: [{ id: "stale-seat", enabled: true }], runtimeProfiles: [{ id: "stale-seat" }] },
    runtimeSeatsLoading: false,
    selectedRuntimeSeatId: null,
    configRuntimeFocusId: null,
  };
  let unavailable = true;
  const loadStates = [];
  const manager = createRuntimeSeatManager({
    state,
    api: { adapterTemplates: "/api/adapter-templates", runtimeSeats: "/api/runtime-seats" },
    request: async (path) => {
      if (path === "/api/adapter-templates") return { templates: [] };
      if (unavailable) throw new Error("runtime seats unavailable");
      return { seats: [], runtimeProfiles: [] };
    },
    escapeHtml: String,
    toast: () => {},
    confirmAction: async () => true,
    onLoadStateChanged: () => loadStates.push(state.runtimeSeatsLoading),
  });

  assert.equal(await manager.load({ fresh: true }), false);
  assert.deepEqual(state.runtimeSeatsData.seats, []);
  assert.equal(state.runtimeSeatsData.error, "runtime seats unavailable");
  assert.equal(loadStates[0], true);
  assert.equal(loadStates.at(-1), false);

  unavailable = false;
  assert.equal(await manager.load(), true, "error snapshots must not satisfy the non-fresh cache");
  assert.deepEqual(state.runtimeSeatsData.seats, []);
  assert.equal(state.runtimeSeatsData.error, undefined);
});
