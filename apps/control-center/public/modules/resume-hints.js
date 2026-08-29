/**
 * Provider-native resume commands for multi-CLI sessions.
 * Prefer server-truth (`run.resumeHints` / runtimeProfileId). Prefix guessing is
 * only a last-resort fallback for builtin ids when the roster is missing.
 */

const CODEX_RESUME_UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const RESUME_BY_ADAPTER = Object.freeze({
  "claude-stream-json": { protocol: "claude-stream-json", command: "claude", args: (sessionId) => ["-r", sessionId] },
  "codex-app-server": { protocol: "codex-app-server", command: "codex", args: (sessionId) => ["resume", codexId(sessionId)] },
  "codex-exec-json": { protocol: "codex-exec-json", command: "codex", args: (sessionId) => ["resume", codexId(sessionId)] },
  "gemini-stream-json": { protocol: "gemini-stream-json", command: "gemini", args: (sessionId) => ["--resume", sessionId] },
  "grok-build-headless": { protocol: "grok-build-headless", command: "grok", args: (sessionId) => ["-r", sessionId] },
  "kimi-headless-resume": { protocol: "kimi-headless-resume", command: "kimi", args: (sessionId) => ["-S", sessionId] },
  "opencode-run-json": { protocol: "opencode-run-json", command: "opencode", args: (sessionId) => ["--session", sessionId] },
  "pi-rpc": { protocol: "pi-rpc", command: "pi", args: (sessionId) => ["--session-id", sessionId] },
});

const PROFILE_TO_ADAPTER = Object.freeze({
  "claude-fable": "claude-stream-json",
  "codex-technical": "codex-app-server",
  "codex-technical-fallback": "codex-exec-json",
  "gemini-research": "gemini-stream-json",
  "grok-build": "grok-build-headless",
  "kimi-frontend": "kimi-headless-resume",
  "pi-resident": "pi-rpc",
});

function codexId(sessionId) {
  const match = CODEX_RESUME_UUID.exec(String(sessionId ?? ""));
  return match ? match[1] : String(sessionId ?? "");
}

function guessAdapterId(agentId) {
  const id = String(agentId || "");
  if (id.startsWith("claude") || id.includes("fable")) return "claude-stream-json";
  if (id.startsWith("codex")) return "codex-app-server";
  if (id.startsWith("kimi")) return "kimi-headless-resume";
  if (id.startsWith("grok-build") || id.includes("grok-build")) return "grok-build-headless";
  if (id.startsWith("gemini")) return "gemini-stream-json";
  if (id.startsWith("opencode")) return "opencode-run-json";
  if (id.startsWith("pi")) return "pi-rpc";
  return null;
}

function hintFor(agentId, sessionId, adapterId) {
  const feature = RESUME_BY_ADAPTER[adapterId];
  if (!feature || !sessionId) {
    return {
      agentId: String(agentId || ""),
      sessionId: String(sessionId || ""),
      protocol: adapterId || "unknown",
      canResume: false,
      command: null,
      note: "no verified native resume for this adapter",
    };
  }
  const command = [feature.command, ...feature.args(String(sessionId))].join(" ");
  return {
    agentId: String(agentId || ""),
    sessionId: String(sessionId),
    protocol: feature.protocol,
    canResume: true,
    command,
    note: "native-session resume only; never cross-provider",
  };
}

export function resumeHintsFromSessions(sessions = {}, { members = [] } = {}) {
  const memberById = new Map((Array.isArray(members) ? members : []).map((item) => [String(item?.id || ""), item]));
  const hints = [];
  for (const [agentId, session] of Object.entries(sessions || {})) {
    const sessionId = typeof session === "string"
      ? session
      : (session?.sessionId || session?.id || null);
    if (!sessionId) continue;
    const member = memberById.get(String(agentId || ""));
    const profileId = String(member?.runtimeProfileId || member?.id || agentId || "").trim();
    const adapterId = PROFILE_TO_ADAPTER[profileId]
      || member?.adapterId
      || guessAdapterId(profileId)
      || guessAdapterId(agentId);
    hints.push(hintFor(agentId, sessionId, adapterId));
  }
  return hints;
}

export function resumeHintsMarkup(hints, { escapeHtml }) {
  const list = Array.isArray(hints) ? hints.filter((item) => item?.canResume && item.command) : [];
  if (!list.length) return "";
  return `
    <div class="resume-hints" role="group" aria-label="异构 CLI 原生恢复命令">
      <div class="resume-hints-head">
        <strong>原生会话恢复</strong>
        <span class="subtle">按 provider 原生命令；禁止跨 CLI 静默 resume</span>
      </div>
      <ul class="resume-hints-list">
        ${list.map((item) => `
          <li class="resume-hint-row">
            <span class="resume-hint-agent">${escapeHtml(item.agentId)}</span>
            <code class="resume-hint-cmd" title="${escapeHtml(item.sessionId)}">${escapeHtml(item.command)}</code>
            <button type="button" class="text-button" data-copy-resume="${escapeHtml(item.command)}">复制</button>
          </li>`).join("")}
      </ul>
    </div>`;
}
