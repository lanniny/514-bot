import test from "node:test";
import assert from "node:assert/strict";
import { consumePetStream, parsePetFrame } from "../public/pet/pet-stream.js";

test("superseded 401 cannot report pairing after delayed response cancellation", async () => {
  let release;
  let cancelling;
  const cancelStarted = new Promise((resolve) => { cancelling = resolve; });
  const calls = [];
  const connection = consumePetStream({
    buildUrl: () => "/events", getToken: () => "old-fixture", onFrame() {},
    onStatus: (value) => calls.push(value), onUnauthorized: () => calls.push("unauthorized"),
    async fetchImpl() {
      return { status: 401, body: { cancel() { cancelling(); return new Promise((resolve) => { release = resolve; }); } } };
    },
  });
  await cancelStarted;
  connection.stop();
  release();
  await connection.done;
  assert.deepEqual(calls, []);
});

test("SSE supports CRLF, optional spaces, multiline data and comments", () => {
  assert.deepEqual(parsePetFrame(":heartbeat\r\nevent:typing\r\nid: 12\r\ndata: first\r\ndata:second"), {
    event: "typing", id: "12", data: "first\nsecond",
  });
});

test("stream cancellation releases readers and stops reconnection", async () => {
  let responseBody;
  let calls = 0;
  const frames = [];
  let resolveFrame;
  const received = new Promise((resolve) => { resolveFrame = resolve; });
  const connection = consumePetStream({
    buildUrl: () => "/events", getToken: () => "fixture",
    onStatus() {}, onUnauthorized() { assert.fail("unexpected unauthorized"); },
    onFrame(frame) { frames.push(frame); resolveFrame(); },
    async fetchImpl(_url, { signal }) {
      calls++;
      responseBody = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event:typing\r\ndata:{}\r"));
          controller.enqueue(new TextEncoder().encode("\n\r\n"));
          signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(responseBody);
    },
  });
  await received;
  assert.equal(frames[0].event, "typing");
  connection.stop();
  await connection.done;
  assert.equal(calls, 1);
  assert.equal(responseBody.locked, false);
});

test("401 identifies only the rejected token and cancellation stops pairing retries", async () => {
  let rejected;
  let notify;
  const seen = new Promise((resolve) => { notify = resolve; });
  let calls = 0;
  const connection = consumePetStream({
    buildUrl: () => "/events", getToken: () => "old-fixture", onFrame() {}, onStatus() {},
    onUnauthorized(token) { rejected = token; notify(); },
    async fetchImpl() { calls++; return new Response("", { status: 401 }); },
  });
  await seen;
  connection.stop();
  await connection.done;
  assert.equal(rejected, "old-fixture");
  assert.equal(calls, 1);
});
