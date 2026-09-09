import test from "node:test";
import assert from "node:assert/strict";
import { createControlConnectionState, connectionPresentation } from "../public/modules/control-connection-state.js";
import { controlConnection, request, requestBlob, setAccessToken, initializeAccessToken, ApiError } from "../public/api.js";

function ready(state) {
  for (const [path, payload] of [
    ["/api/bootstrap", {}], ["/api/projects?includeArchived=1", { projects: [] }],
    ["/api/conversations?includeDeleted=1", { conversations: [] }], ["/api/runs", { runs: [] }],
  ]) state.finish(state.begin(path), { status: 200, payload });
}

test("connectivity, authentication and required data are separate facts", () => {
  const state = createControlConnectionState();
  state.finish(state.begin("/api/health"), { status: 200, payload: {} });
  assert.equal(state.snapshot().service, "ok");
  assert.equal(state.snapshot().auth, "ok");
  assert.equal(state.snapshot().data, "pending");
  assert.equal(state.snapshot().apiState, "pending");
  ready(state);
  assert.equal(state.snapshot().apiState, "ok");
  state.finish(state.begin("/api/projects"), { status: 401 });
  assert.deepEqual([state.snapshot().service, state.snapshot().auth, state.snapshot().data], ["ok", "error", "error"]);
  assert.equal(connectionPresentation(state.snapshot()).auth.label, "会话未授权");
});

test("writes, blobs and optional endpoint errors do not replace list-read evidence", () => {
  const state = createControlConnectionState();
  ready(state);
  for (const path of ["/api/projects", "/api/conversations", "/api/runs"]) {
    state.finish(state.begin(path, { method: "POST" }), { status: 201, payload: { id: "created" } });
    state.finish(state.begin(path, { data: false }), { status: 200 });
  }
  state.finish(state.begin("/api/optional"), { status: 500 });
  assert.equal(state.snapshot().apiState, "ok");
});

test("403 and bad JSON report a data failure, not a fabricated login failure", () => {
  const state = createControlConnectionState();
  ready(state);
  state.finish(state.begin("/api/projects"), { status: 403, payload: { error: "forbidden" } });
  assert.equal(state.snapshot().auth, "ok");
  assert.equal(state.snapshot().data, "error");
  ready(state);
  state.finish(state.begin("/api/runs"), { status: 200, payload: { runs: "bad" } });
  assert.equal(state.snapshot().data, "error");
  ready(state);
  state.finish(state.begin("/api/runs"), { status: 200, payload: null, decoded: false });
  assert.equal(state.snapshot().data, "error");
});

test("concurrent successes in either arrival order cannot erase a 401", () => {
  for (const successFirst of [true, false]) {
    const state = createControlConnectionState();
    const rejected = state.begin("/api/runs");
    const concurrent = state.begin("/api/health");
    if (successFirst) state.finish(concurrent, { status: 200 });
    state.finish(rejected, { status: 401 });
    if (!successFirst) state.finish(concurrent, { status: 200 });
    assert.equal(state.snapshot().auth, "error");
    state.finish(state.begin("/api/health"), { status: 200 });
    assert.equal(state.snapshot().auth, "ok");
  }
});

test("latest list request owns data and token rotation ignores all prior responses", () => {
  const state = createControlConnectionState();
  const old = state.begin("/api/runs");
  const next = state.begin("/api/runs");
  state.finish(next, { status: 500 });
  state.finish(old, { status: 200, payload: { runs: [] } });
  assert.equal(state.snapshot().data, "error");
  const oldToken = state.begin("/api/projects");
  state.reset();
  ready(state);
  state.finish(oldToken, { status: 401 });
  assert.equal(state.snapshot().apiState, "ok");
});

test("abort retains previous data and disconnect is visible until transport recovery", () => {
  const state = createControlConnectionState();
  ready(state);
  state.finish(state.begin("/api/runs"), { aborted: true });
  assert.equal(state.snapshot().apiState, "ok");
  state.finish(state.begin("/api/health"));
  assert.equal(state.snapshot().service, "error");
  assert.equal(connectionPresentation(state.snapshot()).auth.label, "授权待复核");
  state.finish(state.begin("/api/health"), { status: 200 });
  assert.equal(state.snapshot().apiState, "ok");
});

test("subscribers are removable and snapshot never contains credentials or request bodies", () => {
  const state = createControlConnectionState();
  let count = 0;
  const stop = state.subscribe(() => count++);
  state.finish(state.begin("/api/projects?token=do-not-retain"), { status: 200, payload: { projects: [], token: "do-not-retain" } });
  assert.equal(count, 3);
  stop();
  ready(state);
  assert.equal(count, 3);
  assert.doesNotMatch(JSON.stringify(state.snapshot()), /token|do-not-retain/);
});

test("API observers preserve payload/error/abort/blob contracts", async (t) => {
  controlConnection.reset();
  setAccessToken("");
  ready(controlConnection);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ project: { id: "created" } }), { status: 201, headers: { "content-type": "application/json" } }));
  assert.deepEqual(await request("/api/projects", { method: "POST", body: { title: "draft" } }), { project: { id: "created" } });
  assert.equal(controlConnection.snapshot().apiState, "ok");
  globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
  await assert.rejects(request("/api/runs"), (error) => error instanceof ApiError && error.status === 401);
  assert.equal(controlConnection.snapshot().auth, "error");
  const abort = new DOMException("cancelled", "AbortError");
  globalThis.fetch = async () => { throw abort; };
  await assert.rejects(request("/api/runs"), (error) => error === abort);
  ready(controlConnection);
  globalThis.fetch = async () => ({ status: 200, ok: true, headers: new Headers({ "content-type": "application/json" }), json: async () => { throw abort; } });
  await assert.rejects(request("/api/runs"), (error) => error === abort);
  assert.equal(controlConnection.snapshot().apiState, "ok");
  globalThis.fetch = async () => new Response("blob contents");
  assert.equal(await (await requestBlob("/api/export")).text(), "blob contents");
});

test("cancelled latest first load does not wait forever or accept discarded older data", () => {
  const state = createControlConnectionState();
  const old = state.begin("/api/runs");
  const latest = state.begin("/api/runs");
  state.finish(latest, { aborted: true });
  state.finish(old, { status: 200, payload: { runs: [] } });
  assert.equal(connectionPresentation(state.snapshot()).data.label, "工作数据待刷新");
  assert.equal(state.snapshot().ready, 0);
  ready(state);
  assert.equal(state.snapshot().interrupted, false);
  assert.equal(state.snapshot().apiState, "ok");
});

test("every public token initialization path starts a new observer epoch", async (t) => {
  const globals = ["window", "sessionStorage", "history"];
  const originals = Object.fromEntries(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const key of globals) {
      if (originals[key]) Object.defineProperty(globalThis, key, originals[key]);
      else delete globalThis[key];
    }
    setAccessToken("");
  });
  t.mock.method(globalThis, "fetch", async () => new Response('{"token":"qa-new-bootstrap"}', { headers: { "content-type": "application/json" } }));
  for (const hash of ["#token=qa-new-fragment", "#bootstrap=qa-nonce", ""]) {
    setAccessToken("qa-old");
    const old = controlConnection.begin("/api/runs");
    globalThis.window = { location: { href: `http://localhost/${hash}` } };
    globalThis.history = { replaceState() {} };
    globalThis.sessionStorage = { getItem: () => "qa-new-storage", setItem() {} };
    assert.equal(await initializeAccessToken(), true);
    ready(controlConnection);
    controlConnection.finish(old, { status: 401 });
    assert.equal(controlConnection.snapshot().apiState, "ok");
  }
});
