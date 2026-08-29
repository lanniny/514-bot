import { randomUUID } from "node:crypto";
import { attachLfJsonl, encodeJsonLine } from "../jsonl.mjs";
import { childProcessEnv, spawnCommand, terminateChildProcessAndWait } from "../process-runner.mjs";
import { preparePromptTransport } from "../prompt-transport.mjs";
import {
  createBoundedTaskTracker,
  createScrubbedLineCollector,
  DEFAULT_MAX_TURN_OUTPUT_BYTES,
  measureUtf8Append,
} from "./stream-utils.mjs";

const DEFAULT_OUTPUT_LIMIT_SETTLE_MS = 2_000;

const noCredentialPolicy = Object.freeze({ provider: "pi", providerKeys: Object.freeze([]) });
const policy = (provider, providerKeys) => Object.freeze({ provider, providerKeys: Object.freeze(providerKeys) });
// Pi 0.83.0 defaults to the google provider when neither --model nor --provider
// is supplied. Preserve that direct-CLI path without exposing unrelated keys.
const defaultProviderPolicy = policy("gemini", ["GEMINI_API_KEY"]);
const PI_MODEL_ENV_POLICIES = Object.freeze({
  "amazon-bedrock": policy("amazon-bedrock", [
    "AWS_ACCESS_KEY_ID", "AWS_BEARER_TOKEN_BEDROCK", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_PROFILE", "AWS_REGION", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "AWS_WEB_IDENTITY_TOKEN_FILE",
  ]),
  "ant-ling": policy("ant-ling", ["ANT_LING_API_KEY"]),
  anthropic: policy("anthropic", ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"]),
  google: policy("gemini", ["GEMINI_API_KEY"]),
  "google-vertex": policy("google-vertex", ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_API_KEY", "GOOGLE_CLOUD_LOCATION", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"]),
  openai: policy("openai", ["OPENAI_API_KEY", "OPENAI_API_BASE", "OPENAI_BASE_URL", "OPENAI_ORGANIZATION", "OPENAI_ORG_ID", "OPENAI_PROJECT", "OPENAI_PROJECT_ID"]),
  "azure-openai-responses": policy("azure-openai-responses", ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP", "AZURE_OPENAI_RESOURCE_NAME"]),
  "openai-codex": noCredentialPolicy,
  radius: policy("radius", ["RADIUS_API_KEY"]),
  nvidia: policy("nvidia", ["NVIDIA_API_KEY"]),
  deepseek: policy("deepseek", ["DEEPSEEK_API_KEY"]),
  "github-copilot": policy("github-copilot", ["COPILOT_GITHUB_TOKEN"]),
  xai: policy("grok", ["XAI_API_KEY", "XAI_BASE_URL"]),
  groq: policy("groq", ["GROQ_API_KEY"]),
  cerebras: policy("cerebras", ["CEREBRAS_API_KEY"]),
  openrouter: policy("openrouter", ["OPENROUTER_API_KEY"]),
  "vercel-ai-gateway": policy("vercel-ai-gateway", ["AI_GATEWAY_API_KEY"]),
  zai: policy("zai", ["ZAI_API_KEY"]),
  "zai-coding-cn": policy("zai-coding-cn", ["ZAI_CODING_CN_API_KEY"]),
  mistral: policy("mistral", ["MISTRAL_API_KEY"]),
  minimax: policy("minimax", ["MINIMAX_API_KEY"]),
  "minimax-cn": policy("minimax-cn", ["MINIMAX_CN_API_KEY"]),
  moonshotai: policy("kimi", ["MOONSHOT_API_KEY", "MOONSHOT_BASE_URL"]),
  "moonshotai-cn": policy("kimi", ["MOONSHOT_API_KEY", "MOONSHOT_BASE_URL"]),
  huggingface: policy("huggingface", ["HF_TOKEN"]),
  fireworks: policy("fireworks", ["FIREWORKS_API_KEY"]),
  together: policy("together", ["TOGETHER_API_KEY"]),
  opencode: policy("opencode", ["OPENCODE_API_KEY"]),
  "opencode-go": policy("opencode", ["OPENCODE_API_KEY"]),
  "kimi-coding": policy("kimi", ["KIMI_API_KEY", "KIMI_BASE_URL"]),
  "cloudflare-workers-ai": policy("cloudflare-workers-ai", ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY"]),
  "cloudflare-ai-gateway": policy("cloudflare-ai-gateway", ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY", "CLOUDFLARE_GATEWAY_ID"]),
  "qwen-token-plan": policy("qwen-token-plan", ["QWEN_TOKEN_PLAN_API_KEY"]),
  "qwen-token-plan-cn": policy("qwen-token-plan-cn", ["QWEN_TOKEN_PLAN_CN_API_KEY"]),
  xiaomi: policy("xiaomi", ["XIAOMI_API_KEY"]),
  "xiaomi-token-plan-cn": policy("xiaomi-token-plan-cn", ["XIAOMI_TOKEN_PLAN_CN_API_KEY"]),
  "xiaomi-token-plan-ams": policy("xiaomi-token-plan-ams", ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"]),
  "xiaomi-token-plan-sgp": policy("xiaomi-token-plan-sgp", ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"]),
});

export function piProviderEnvPolicy(model) {
  const value = String(model || "").trim();
  const slash = value.indexOf("/");
  if (slash <= 0) return { modelProvider: null, ...defaultProviderPolicy, providerKeys: [...defaultProviderPolicy.providerKeys] };
  const modelProvider = value.slice(0, slash).trim().toLowerCase();
  const resolved = PI_MODEL_ENV_POLICIES[modelProvider];
  if (!resolved) {
    throw Object.assign(new Error(`Pi model provider is not allowlisted: ${modelProvider}`), {
      code: "PI_MODEL_PROVIDER_UNSUPPORTED",
      modelProvider,
    });
  }
  return { modelProvider, provider: resolved.provider, providerKeys: [...resolved.providerKeys] };
}

export class PiRpcAdapter {
  constructor({
    command = "pi",
    model = null,
    effort = null,
    eventStore,
    cwd,
    spawnImpl = spawnCommand,
    environmentBase = process.env,
    maxTurnOutputBytes = DEFAULT_MAX_TURN_OUTPUT_BYTES,
    outputLimitSettleMs = DEFAULT_OUTPUT_LIMIT_SETTLE_MS,
  }) {
    this.id = "pi-rpc";
    this.command = command;
    this.model = model;
    this.effort = effort;
    this.eventStore = eventStore;
    this.cwd = cwd;
    this.spawnImpl = spawnImpl;
    this.environmentBase = environmentBase;
    this.maxTurnOutputBytes = maxTurnOutputBytes;
    this.outputLimitSettleMs = outputLimitSettleMs;
    if (!Number.isSafeInteger(maxTurnOutputBytes) || maxTurnOutputBytes < 1
      || !Number.isSafeInteger(outputLimitSettleMs) || outputLimitSettleMs < 1) {
      throw Object.assign(new Error("Pi output limits must be positive safe integers"), { code: "INVALID_OUTPUT_POLICY" });
    }
    this.processes = new Map();
  }

  trackEvent(state, type, data, context = {}) {
    state.eventTasks.run(() => this.eventStore.emit(type, data, context));
  }

  async createSession(runId, requestedSessionId = null, agentId = "pi-resident", model = null, effort = null) {
    const sessionId = requestedSessionId || randomUUID();
    const args = [
      "--mode",
      "rpc",
      "--no-approve",
      "--tools",
      "read,grep,find,ls",
      "--session-id",
      sessionId,
      "--name",
      `514cc-${runId?.slice(0, 8) || sessionId.slice(0, 8)}`,
    ];
    const effectiveModel = model || this.model;
    const effectiveEffort = effort || this.effort;
    const envPolicy = piProviderEnvPolicy(effectiveModel);
    if (effectiveModel) args.push("--model", effectiveModel);
    if (effectiveEffort) args.push("--thinking", effectiveEffort);
    const child = this.spawnImpl(this.command, args, {
      cwd: this.cwd,
      env: childProcessEnv(
        { PI_OFFLINE: this.environmentBase.PI_OFFLINE || "1" },
        this.environmentBase,
        { provider: envPolicy.provider, providerKeys: envPolicy.providerKeys },
      ),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    const state = {
      child,
      sessionId,
      nextId: 1,
      pending: new Map(),
      active: null,
      runId,
      agentId,
      model: effectiveModel,
      modelProvider: envPolicy.modelProvider,
      effort: effectiveEffort,
      eventTasks: createBoundedTaskTracker(),
    };
    this.processes.set(sessionId, state);
    attachLfJsonl(child.stdout, (message) => this.handleMessage(state, message), (error) => {
      this.trackEvent(state, "adapter.parse_error", { adapter: this.id, message: error.message }, { runId: state.runId, sessionId, agentId: state.agentId });
    });
    child.once("error", (error) => this.fail(state, error));
    child.once("close", (code) => this.fail(state, new Error(`Pi RPC closed ${code}`)));
    const stderrCollector = createScrubbedLineCollector((safeText) => {
      const message = safeText.trim();
      if (message) this.trackEvent(state, "adapter.stderr", { adapter: this.id, message: message.slice(-2000) }, { runId: state.runId, sessionId, agentId: state.agentId });
    });
    child.stderr.on("data", (chunk) => stderrCollector.push(chunk));
    child.stderr.once("end", () => stderrCollector.end());
    return sessionId;
  }

  handleMessage(state, message) {
    if (message.type === "response" && message.id != null) {
      const pending = state.pending.get(message.id);
      if (pending) {
        state.pending.delete(message.id);
        message.success ? pending.resolve(message) : pending.reject(new Error(message.error || "Pi command rejected"));
      }
      return;
    }
    if (message.type === "message_update" && message.assistantMessageEvent?.type === "text_delta" && state.active) {
      const active = state.active;
      const delta = message.assistantMessageEvent.delta || "";
      if (delta && !active.outputLimitError) {
        const measurement = measureUtf8Append(active.outputBytes, active.endsWithHighSurrogate, delta);
        if (measurement.bytes > this.maxTurnOutputBytes) {
          this.failActiveOutputLimit(state, active);
        } else {
          active.text += delta;
          active.outputBytes = measurement.bytes;
          active.endsWithHighSurrogate = measurement.endsWithHighSurrogate;
          const now = Date.now();
          if (!active.lastDeltaAt || now - active.lastDeltaAt >= 80 || delta.length >= 80) {
            active.lastDeltaAt = now;
            this.trackEvent(state, "pi.item/agentMessage/delta", { delta }, {
              runId: state.runId, sessionId: state.sessionId, agentId: active.agentId,
            });
          }
        }
      }
    }
    if (/tool_execution_(?:start|end)/.test(message.type || "")) {
      this.trackEvent(state, "tool.event", { adapter: this.id, type: message.type, tool: message.toolName || message.tool || null }, { runId: state.runId, sessionId: state.sessionId, agentId: state.active?.agentId || state.agentId });
    }
    if (message.type === "agent_end" && state.active) {
      const active = state.active;
      if (active.outputLimitError) {
        active.resolveTerminalBoundary();
        return;
      }
      this.trackEvent(state, "assistant.message", { text: active.text }, { runId: state.runId, sessionId: state.sessionId, agentId: active.agentId });
      const result = {
        sessionId: state.sessionId,
        text: active.text,
        nativePersistence: true,
        protocol: "pi-rpc",
        requestedModel: state.model || null,
        effectiveModel: state.model || null,
      };
      void this.settleActive(state, active, { result });
    }
  }

  abortActive(state, active) {
    if (active?.abortSent) return false;
    if (active) active.abortSent = true;
    state.child.stdin.write(encodeJsonLine({ type: "abort" }));
    return true;
  }

  settleActive(state, active, { error = null, result = null } = {}) {
    if (!active || active.settled || state.active !== active) return active?.settlePromise || Promise.resolve();
    active.settled = true;
    state.active = null;
    clearTimeout(active.timer);
    active.resolveTerminalBoundary();
    active.settlePromise = state.eventTasks.drain().then(() => {
      if (error) active.reject(error);
      else active.resolve(result);
    });
    void active.settlePromise.catch(() => {});
    return active.settlePromise;
  }

  failActiveOutputLimit(state, active) {
    if (!active || active.outputLimitError) return active?.outputLimitTask || Promise.resolve();
    const error = Object.assign(
      new Error(`Pi turn output exceeded ${this.maxTurnOutputBytes} UTF-8 bytes`),
      { code: "OUTPUT_LIMIT", maxOutputBytes: this.maxTurnOutputBytes },
    );
    active.outputLimitError = error;
    let abortWritten = false;
    try {
      abortWritten = this.abortActive(state, active);
    } catch (abortError) {
      error.abortError = abortError;
    }
    active.outputLimitTask = (async () => {
      let terminal = false;
      if (abortWritten) {
        let timer;
        terminal = await Promise.race([
          active.terminalBoundary.then(() => true),
          new Promise((resolve) => { timer = setTimeout(() => resolve(false), this.outputLimitSettleMs); }),
        ]);
        clearTimeout(timer);
      }
      if (!terminal && state.active === active) {
        try {
          await terminateChildProcessAndWait(state.child);
        } catch (terminationError) {
          error.terminationError = terminationError;
          state.unusableError = terminationError;
        }
      }
      if (state.active === active) await this.settleActive(state, active, { error });
    })();
    void active.outputLimitTask.catch((shutdownError) => {
      error.shutdownError = shutdownError;
      if (state.active === active) void this.settleActive(state, active, { error });
    });
    return active.outputLimitTask;
  }

  commandRequest(state, payload, timeoutMs = 30_000, failureBoundary = null) {
    const id = `cc-${state.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error(`${payload.type} response timed out`));
      }, timeoutMs);
      const pending = {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      state.pending.set(id, pending);
      if (failureBoundary) {
        void Promise.resolve(failureBoundary).catch((error) => {
          if (state.pending.get(id) !== pending) return;
          state.pending.delete(id);
          pending.reject(error);
        });
      }
      state.child.stdin.write(encodeJsonLine({ id, ...payload }));
    });
  }

  async send({ sessionId, prompt, runId, agentId = "pi-resident", signal, model = null, effort = null, timeoutMs = 20 * 60_000, onSessionStarted, onTurnSubmitting, onTurnAccepted }) {
    const resolvedSessionId = sessionId || (await this.createSession(runId, null, agentId, model, effort));
    if (sessionId && !this.processes.has(sessionId)) await this.createSession(runId, sessionId, agentId, model, effort);
    const state = this.processes.get(resolvedSessionId);
    if (!state) throw Object.assign(new Error("Pi session is not loaded in this control-plane process"), { code: "SESSION_NOT_LOADED" });
    if (state.unusableError) throw Object.assign(new Error("Pi session is unusable after a failed shutdown"), { code: "SESSION_UNAVAILABLE", cause: state.unusableError });
    if (state.active) throw Object.assign(new Error("Pi session already has an active turn"), { code: "TURN_ACTIVE" });
    await onSessionStarted?.({ sessionId: resolvedSessionId, protocol: "pi-rpc" });
    state.runId = runId;
    state.agentId = agentId;
    const clientUserMessageId = randomUUID();
    let activeTurn;
    const turn = new Promise((resolve, reject) => {
      let resolveTerminalBoundary;
      const terminalBoundary = new Promise((resolveBoundary) => { resolveTerminalBoundary = resolveBoundary; });
      const active = {
        resolve,
        reject,
        agentId,
        timer: null,
        text: "",
        outputBytes: 0,
        endsWithHighSurrogate: false,
        outputLimitError: null,
        outputLimitTask: null,
        abortSent: false,
        terminalBoundary,
        resolveTerminalBoundary,
        settled: false,
        settlePromise: null,
      };
      active.timer = setTimeout(() => {
        if (state.active === active) {
          void this.settleActive(state, active, {
            error: active.outputLimitError
              || Object.assign(new Error("Pi turn timed out"), { code: "TURN_TIMEOUT" }),
          });
        }
      }, timeoutMs);
      activeTurn = active;
      state.active = active;
    });
    void turn.catch(() => {});
    const turnFailure = new Promise((_, rejectFailure) => {
      void turn.then(() => {}, rejectFailure);
    });
    void turnFailure.catch(() => {});
    const abort = () => {
      const active = state.active;
      if (!active) return;
      try {
        this.abortActive(state, active);
      } catch (error) {
        void this.settleActive(state, active, { error });
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) abort();
      await onTurnSubmitting?.({ sessionId: resolvedSessionId, protocol: "pi-rpc", clientUserMessageId });
      await preparePromptTransport({
        prompt,
        transport: "jsonl",
        adapterId: this.id,
        command: this.command,
        eventStore: this.eventStore,
        runId,
        agentId,
      });
      await this.commandRequest(state, { type: "prompt", message: prompt }, 30_000, turnFailure);
      await onTurnAccepted?.({ sessionId: resolvedSessionId, protocol: "pi-rpc", clientUserMessageId });
      return await turn;
    } catch (error) {
      const primaryError = activeTurn?.outputLimitError || error;
      if (activeTurn?.outputLimitError && activeTurn.outputLimitTask) {
        await activeTurn.outputLimitTask.catch(() => {});
      } else if (state.active === activeTurn) {
        await this.settleActive(state, activeTurn, { error: primaryError });
      }
      throw primaryError;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  fail(state, error) {
    for (const pending of state.pending.values()) pending.reject(error);
    state.pending.clear();
    if (state.active) {
      const active = state.active;
      void this.settleActive(state, active, { error: active.outputLimitError || error });
    }
    this.processes.delete(state.sessionId);
  }

  async close() {
    const closures = [];
    for (const state of this.processes.values()) {
      try { this.abortActive(state, state.active); } catch {}
      closures.push((async () => {
        await terminateChildProcessAndWait(state.child);
        await state.eventTasks.drain();
      })());
    }
    this.processes.clear();
    await Promise.allSettled(closures);
  }
}
