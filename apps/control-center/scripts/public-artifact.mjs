export async function readPublicArtifact(url, { maxBytes = 16 * 1024 * 1024, timeoutMs = 30_000 } = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!response.ok) throw new Error(`public artifact unavailable: HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("public artifact exceeds its byte budget");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
