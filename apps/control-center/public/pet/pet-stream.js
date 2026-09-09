export function parsePetFrame(frame) {
  const result = { event: "message", data: "", id: null };
  const data = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const key = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (key === "data") data.push(value);
    else if (key === "event" || key === "id") result[key] = value;
  }
  result.data = data.join("\n");
  return result;
}

export function consumePetStream({ buildUrl, getToken, onFrame, onStatus, onUnauthorized, onResponse, fetchImpl = fetch }) {
  const controller = new AbortController();
  const { signal } = controller;
  const delay = (ms) => new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
  const done = (async () => {
    let retryMs = 2000;
    while (!signal.aborted) {
      let reader;
      try {
        const token = getToken();
        if (!token) { await delay(500); continue; }
        const response = await fetchImpl(buildUrl(), {
          headers: { Accept: "text/event-stream", Authorization: `Bearer ${token}` },
          cache: "no-store", signal,
        });
        if (signal.aborted) { await response.body?.cancel(); break; }
        if (response.status === 401) {
          await response.body?.cancel();
          if (signal.aborted) break;
          onUnauthorized(token);
          onStatus("pairing");
          await delay(retryMs);
          continue;
        }
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error(`HTTP ${response.status}`);
        }
        if (onResponse?.(response) === false) { await response.body.cancel(); continue; }
        onStatus("connected");
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          retryMs = 2000;
          buffer += decoder.decode(value, { stream: true });
          let match;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            onFrame(parsePetFrame(frame));
          }
          if (buffer.length > 2 * 1024 * 1024) throw new Error("SSE frame too large");
        }
        if (!signal.aborted) throw new Error("Stream closed");
      } catch {
        if (signal.aborted) break;
        onStatus("reconnecting");
      } finally {
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
      }
      if (!signal.aborted) {
        await delay(retryMs);
        retryMs = Math.min(retryMs * 2, 15000);
      }
    }
  })();
  return { stop: () => controller.abort(), done };
}
