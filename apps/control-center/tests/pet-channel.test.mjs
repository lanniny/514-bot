import test from "node:test";
import assert from "node:assert/strict";
import { createPetChannel } from "../public/pet/pet-channel.js";

test("fallback pairing rejects wrong origins and sibling frames and detaches on close", () => {
  const listeners = new Map();
  const sent = [];
  const peer = { postMessage: (...args) => sent.push(args) };
  const host = {
    location: { origin: "http://127.0.0.1:5000" },
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
  };
  const channel = createPetChannel(() => peer, host);
  const received = [];
  channel.onmessage = ({ data }) => received.push(data);
  const event = { source: peer, origin: host.location.origin, data: { channel: "514cc-pet", data: { type: "pet-hello" } } };
  listeners.get("message")({ ...event, origin: "http://127.0.0.1:5001" });
  listeners.get("message")({ ...event, source: {} });
  assert.equal(received.length, 0);
  listeners.get("message")(event);
  assert.deepEqual(received, [{ type: "pet-hello" }]);
  channel.postMessage({ type: "pet-config" });
  assert.equal(sent[0][1], host.location.origin);
  channel.close();
  assert.equal(listeners.size, 0);
});
