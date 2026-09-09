const NAME = "514cc-pet";

// Web fallback accepts only the expected parent/iframe at the exact current origin.
export function createPetChannel(getPeer, host = window, nativeWindow = false) {
  if (nativeWindow && typeof host.BroadcastChannel === "function") return new host.BroadcastChannel(NAME);
  const channel = {
    onmessage: null,
    postMessage(data) {
      getPeer()?.postMessage({ channel: NAME, data }, host.location.origin);
    },
    close() { host.removeEventListener("message", receive); channel.onmessage = null; },
  };
  function receive(event) {
    const peer = getPeer();
    if (!peer || event.source !== peer || event.origin !== host.location.origin || event.data?.channel !== NAME) return;
    channel.onmessage?.({ data: event.data.data });
  }
  host.addEventListener("message", receive);
  return channel;
}
