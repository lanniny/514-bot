import test from "node:test";
import assert from "node:assert/strict";
import { createSettlementRequester } from "../public/modules/settlement-request.js";

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

test("settlement requester times out, aborts transport, and returns a retryable error", async () => {
  let aborted = false;
  const requester = createSettlementRequester({
    timeoutMs: 10,
    pathForRun: (runId) => `/api/runs/${runId}/settlement`,
    request: (_path, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(abortError());
      }, { once: true });
    }),
  });

  await assert.rejects(
    requester.load("bot", "run-timeout"),
    (error) => error.code === "SETTLEMENT_TIMEOUT" && /重试/.test(error.message),
  );
  assert.equal(aborted, true);
  assert.equal(requester.pending(), 0);
});

test("cancelling a settlement surface aborts the request without converting it to an error state", async () => {
  let rejectRequest;
  const requester = createSettlementRequester({
    timeoutMs: 1000,
    pathForRun: (runId) => `/api/runs/${runId}/settlement`,
    request: (_path, { signal }) => new Promise((_, reject) => {
      rejectRequest = reject;
      signal.addEventListener("abort", () => rejectRequest(abortError()), { once: true });
    }),
  });
  const pending = requester.load("workbench", "run-cancel");
  assert.equal(requester.cancelSurface("workbench"), 1);
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(requester.pending(), 0);
});

test("a retry supersedes an older settlement request for the same surface and run", async () => {
  const deferred = [];
  const requester = createSettlementRequester({
    timeoutMs: 1000,
    pathForRun: (runId) => `/api/runs/${runId}/settlement`,
    request: (path) => new Promise((resolve) => deferred.push({ path, resolve })),
  });
  const first = requester.load("bot", "run-retry");
  const second = requester.load("bot", "run-retry");
  deferred.at(-1).resolve({ revision: 2 });
  assert.deepEqual(await second, { revision: 2 });
  // The first transport was aborted by the superseding call; it must not keep
  // a record or overwrite the second result when it eventually settles.
  deferred[0].resolve({ revision: 1 });
  await assert.doesNotReject(first);
  assert.equal(requester.pending(), 0);
});
