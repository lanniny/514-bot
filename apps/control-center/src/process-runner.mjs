import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, delimiter, extname, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { childRegistry } from "./child-registry.mjs";
import { withRuntimeExecutablePath } from "./runtime-executable-dirs.mjs";

// Provider subprocesses must not inherit the control plane's entire environment.
// Keep only the OS/user paths needed to locate executables and credential stores;
// network/provider variables are added only for an explicitly identified provider.
const RUNTIME_ENV_KEYS = new Set([
  "ALLUSERSPROFILE",
  "APPDATA",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "LOGNAME",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  // Non-secret safety flag used by both Pi RPC and its --version health probe.
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_OFFLINE",
  "PI_PACKAGE_DIR",
  "PI_TELEMETRY",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PSMODULEPATH",
  "PYTHONIOENCODING",
  "PYTHONUTF8",
  "SHELL",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
  // Node/Bun：用系统证书库（Windows 根证书）。OpenCode 在 Win 上的
  // "unknown certificate verification error" 常因 rustls 不读系统库。
  "NODE_USE_SYSTEM_CA",
]);

const PROVIDER_NETWORK_ENV_KEYS = new Set([
  "ALL_PROXY",
  "CURL_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
]);

const PROVIDER_ENV_KEYS = Object.freeze({
  openai: new Set([
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_API_VERSION",
    "AZURE_OPENAI_ENDPOINT",
    "CODEX_HOME",
    "OPENAI_API_BASE",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORGANIZATION",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT",
    "OPENAI_PROJECT_ID",
  ]),
  anthropic: new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "ANTHROPIC_MODEL",
    "CLAUDE_CODE_EFFORT_LEVEL",
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "ENABLE_TOOL_SEARCH",
  ]),
  gemini: new Set([
    "GEMINI_API_KEY",
    "GEMINI_BASE_URL",
    "GEMINI_MODEL",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_GENAI_USE_VERTEXAI",
  ]),
  grok: new Set([
    "GROK_API_KEY",
    "GROK_API_URL",
    "GROK_BASE_URL",
    "GROK_MODEL",
    "GROK_SEARCH_RS_COMPAT_API_KEY",
    "GROK_SEARCH_RS_COMPAT_API_URL",
    "GROK_SEARCH_RS_COMPAT_MODEL",
    "XAI_API_KEY",
    "XAI_BASE_URL",
  ]),
  kimi: new Set([
    "KIMI_API_KEY",
    "KIMI_BASE_URL",
    "KIMI_CONFIG_DIR",
    "KIMI_MODEL",
    "KIMI_MODEL_THINKING_EFFORT", // 非密钥控制变量：Adapter 逐轮注入推理档位（官方 env 线）
    "MOONSHOT_API_KEY",
    "MOONSHOT_BASE_URL",
    "MOONSHOT_MODEL",
  ]),
  pi: new Set([
    "INFLECTION_API_KEY",
    "INFLECTION_BASE_URL",
    "INFLECTION_MODEL",
    "PI_API_KEY",
    "PI_BASE_URL",
    "PI_CODING_AGENT_DIR",
    "PI_MODEL",
    "PI_OFFLINE",
  ]),
  "amazon-bedrock": new Set([
    "AWS_ACCESS_KEY_ID", "AWS_BEARER_TOKEN_BEDROCK", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_PROFILE", "AWS_REGION", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "AWS_WEB_IDENTITY_TOKEN_FILE",
  ]),
  "ant-ling": new Set(["ANT_LING_API_KEY"]),
  "azure-openai-responses": new Set([
    "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_BASE_URL",
    "AZURE_OPENAI_DEPLOYMENT_NAME_MAP", "AZURE_OPENAI_RESOURCE_NAME",
  ]),
  radius: new Set(["RADIUS_API_KEY"]),
  nvidia: new Set(["NVIDIA_API_KEY"]),
  deepseek: new Set(["DEEPSEEK_API_KEY"]),
  "github-copilot": new Set(["COPILOT_GITHUB_TOKEN"]),
  "google-vertex": new Set([
    "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_API_KEY", "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT",
  ]),
  groq: new Set(["GROQ_API_KEY"]),
  cerebras: new Set(["CEREBRAS_API_KEY"]),
  openrouter: new Set(["OPENROUTER_API_KEY"]),
  "vercel-ai-gateway": new Set(["AI_GATEWAY_API_KEY"]),
  zai: new Set(["ZAI_API_KEY"]),
  "zai-coding-cn": new Set(["ZAI_CODING_CN_API_KEY"]),
  mistral: new Set(["MISTRAL_API_KEY"]),
  minimax: new Set(["MINIMAX_API_KEY"]),
  "minimax-cn": new Set(["MINIMAX_CN_API_KEY"]),
  huggingface: new Set(["HF_TOKEN"]),
  fireworks: new Set(["FIREWORKS_API_KEY"]),
  together: new Set(["TOGETHER_API_KEY"]),
  "qwen-token-plan": new Set(["QWEN_TOKEN_PLAN_API_KEY"]),
  "qwen-token-plan-cn": new Set(["QWEN_TOKEN_PLAN_CN_API_KEY"]),
  xiaomi: new Set(["XIAOMI_API_KEY"]),
  "xiaomi-token-plan-cn": new Set(["XIAOMI_TOKEN_PLAN_CN_API_KEY"]),
  "xiaomi-token-plan-ams": new Set(["XIAOMI_TOKEN_PLAN_AMS_API_KEY"]),
  "xiaomi-token-plan-sgp": new Set(["XIAOMI_TOKEN_PLAN_SGP_API_KEY"]),
  "cloudflare-workers-ai": new Set(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY"]),
  "cloudflare-ai-gateway": new Set(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY", "CLOUDFLARE_GATEWAY_ID"]),
  // OpenCode 的模型与密钥由 ProviderStore 投影进 opencode.json（providers.mjs #applyOpenCode），
  // 子进程不经过 env 取凭证；这里只放行 opencode 自有命名空间的配置/控制变量
  //（名称取自 1.18.11 二进制内嵌字符串，非凭空枚举），别家密钥一律不透传。
  opencode: new Set([
    "OPENCODE_API_KEY",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_DISABLE_AUTOUPDATE",
    "OPENCODE_DISABLE_MODELS_FETCH",
    "OPENCODE_GIT_BASH_PATH",
  ]),
});

const PROVIDER_ALIASES = Object.freeze({
  claude: "anthropic",
  codex: "openai",
  "codex-technical": "openai",
  "gemini-research": "gemini",
  "grok-build": "grok",
  "grok-search": "grok",
  "kimi-frontend": "kimi",
  "pi-resident": "pi",
});

const PROVIDER_COMMANDS = Object.freeze({
  claude: "anthropic",
  codex: "openai",
  gemini: "gemini",
  grok: "grok",
  kimi: "kimi",
  opencode: "opencode",
  pi: "pi",
});

function envName(value) {
  return String(value).toUpperCase();
}

function normalizeProvider(provider) {
  if (provider == null || provider === "") return null;
  const normalized = String(provider).toLowerCase();
  const resolved = PROVIDER_ALIASES[normalized] || normalized;
  if (!Object.hasOwn(PROVIDER_ENV_KEYS, resolved)) {
    const error = new Error(`unknown child environment provider: ${provider}`);
    error.code = "UNKNOWN_ENV_PROVIDER";
    throw error;
  }
  return resolved;
}

function isProbeArgs(args) {
  const normalized = args.map((value) => String(value).toLowerCase());
  return (normalized.length === 1 && (normalized[0] === "--version" || normalized[0] === "-v"))
    || (normalized.length === 1 && normalized[0] === "--list-models")
    || normalized[0] === "models"
    || (normalized[0] === "debug" && normalized[1] === "models");
}

/**
 * Infer provider credentials only for known execution commands. Validators,
 * health/model probes and unknown commands intentionally receive no provider
 * secret; callers with a non-standard provider executable must pass provider.
 */
export function inferProcessProvider(command, args = []) {
  if (isProbeArgs(args)) return null;
  const name = basename(String(command)).replace(/\.(?:exe|com|cmd|bat|ps1)$/i, "").toLowerCase();
  return PROVIDER_COMMANDS[name] || null;
}

export function resolveCommand(command, env = process.env) {
  if (process.platform !== "win32") return { command, prefixArgs: [], resolvedPath: command };
  env = withRuntimeExecutablePath(env);
  const candidates = [];
  if (isAbsolute(command) || command.includes("\\") || command.includes("/")) candidates.push(command);
  else {
    const extension = extname(command);
    const directories = String(env.PATH || env.Path || "").split(delimiter).filter(Boolean);
    if (extension) {
      for (const directory of directories) candidates.push(join(directory, command));
    } else {
      // Preserve PATH ownership boundaries. Prefer a native or PowerShell entry
      // in the first matching directory instead of jumping to a later desktop
      // executable that may proxy into a shared, long-lived host.
      // Claude Code is commonly installed through npm, which leaves a
      // `claude.ps1` shim early in PATH while the native installer places
      // `claude.exe` later (for example in ~/.local/bin). Prefer the native
      // seat for this known provider so stdin remains a trusted UTF-8 pipe;
      // keep the legacy first-directory ordering for every other command.
      const nativePreferred = command.toLowerCase() === "claude";
      const suffixes = nativePreferred ? [".exe", ".com"] : [".exe", ".com", ".ps1"];
      for (const directory of directories) {
        if (command.toLowerCase() === "opencode") {
          // npm 的 opencode.ps1 只是跳板，真正的二进制在 node_modules/opencode-ai/bin。
          // 走 powershell -File 会把内核和子进程放进同一 console 组，OpenCode 退出时
          // 控制事件能 SIGINT 内核，桌面壳就会当成内核死亡而闪退。
          candidates.push(join(directory, "node_modules", "opencode-ai", "bin", "opencode.exe"));
        }
        if (command.toLowerCase() === "codex" && (existsSync(join(directory, "codex.ps1")) || existsSync(join(directory, "codex.cmd")))) {
          const packageArch = process.arch === "arm64" ? "arm64" : "x64";
          const target = packageArch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
          candidates.push(join(
            directory,
            "node_modules",
            "@openai",
            "codex",
            "node_modules",
            "@openai",
            `codex-win32-${packageArch}`,
            "vendor",
            target,
            "bin",
            "codex.exe",
          ));
        }
        for (const suffix of suffixes) candidates.push(join(directory, `${command}${suffix}`));
      }
      if (nativePreferred) {
        // Only use the shim when no native peer exists. Non-ASCII prompts are
        // still rejected by prompt-transport.mjs if this fallback is selected.
        for (const directory of directories) candidates.push(join(directory, `${command}.ps1`));
      }
      for (const directory of directories) candidates.push(join(directory, `${command}.cmd`));
      // Grok Build installs to ~/.grok/bin (a non-PATH location); fall back to the
      // known install path so the kernel resolves grok regardless of the launching
      // shell's PATH state — same non-standard-location handling as codex above.
      if (command.toLowerCase() === "grok") {
        const home = env.USERPROFILE || env.HOME;
        if (home) candidates.push(join(home, ".grok", "bin", "grok.exe"));
      }
      // Kimi Code 原生包安装到 ~/.kimi-code/bin（安装器才写 PATH；资源管理器等长驻父进程的
      // 环境块可能是安装前的陈旧副本，PATH 里找不到 kimi）——与 codex/grok 同类回退。
      if (command.toLowerCase() === "kimi") {
        const home = env.USERPROFILE || env.HOME;
        if (home) candidates.push(join(home, ".kimi-code", "bin", "kimi.exe"));
      }
    }
  }
  const resolvedPath = candidates.find((candidate) => existsSync(candidate));
  if (!resolvedPath) return { command, prefixArgs: [], resolvedPath: command };
  const extension = extname(resolvedPath).toLowerCase();
  if (extension === ".ps1") {
    return {
      command: "powershell.exe",
      prefixArgs: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolvedPath],
      resolvedPath,
    };
  }
  if (extension === ".cmd" || extension === ".bat") {
    const error = new Error(`refusing to invoke ${extension} shim without a PowerShell or executable peer: ${resolvedPath}`);
    error.code = "UNSAFE_COMMAND_SHIM";
    throw error;
  }
  return { command: resolvedPath, prefixArgs: [], resolvedPath };
}

export function spawnCommand(command, args = [], options = {}) {
  const resolved = resolveCommand(command, options.env || process.env);
  const child = spawn(resolved.command, [...resolved.prefixArgs, ...args], { ...options, shell: false });
  // 子进程台账（重启孤儿清理）：托管子进程统一出口。登记"实际 spawn 的镜像"——.ps1 经
  // powershell.exe 启动时活进程镜像是 powershell.exe，登记脚本名会让 reap 比对永远不符（只跳过不杀）。
  // detached 的用户态 UI 进程（explorer/opener）有意不走此出口——它们归用户，不归台账。
  childRegistry()?.register(child.pid, basename(resolved.command));
  child.once("close", () => childRegistry()?.unregister(child.pid));
  return child;
}

export function childProcessEnv(overrides = {}, base = process.env, policy = {}) {
  const policyObject = policy && typeof policy === "object" ? policy : { provider: policy };
  const provider = normalizeProvider(policyObject.provider);
  const requestedProviderKeys = policyObject.providerKeys ?? null;
  const allowGitConfigEnv = policyObject.allowGitConfigEnv === true;
  const providerKeys = provider ? PROVIDER_ENV_KEYS[provider] : new Set();
  let selectedProviderKeys = providerKeys;
  if (requestedProviderKeys != null) {
    if (!provider) {
      const error = new Error("providerKeys requires an explicit child environment provider");
      error.code = "INVALID_ENV_POLICY";
      throw error;
    }
    selectedProviderKeys = new Set();
    for (const rawKey of requestedProviderKeys) {
      const key = envName(rawKey);
      if (!providerKeys.has(key)) {
        const error = new Error(`environment variable ${key} is not allowed for provider ${provider}`);
        error.code = "INVALID_ENV_POLICY";
        throw error;
      }
      selectedProviderKeys.add(key);
    }
  }

  const allowed = new Set(RUNTIME_ENV_KEYS);
  if (provider) {
    for (const key of PROVIDER_NETWORK_ENV_KEYS) allowed.add(key);
    for (const key of selectedProviderKeys) allowed.add(key);
  }

  const env = {};
  for (const [key, value] of Object.entries(base || {})) {
    if (value != null && allowed.has(envName(key))) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides || {})) {
    const normalized = envName(key);
    const allowedGitConfig = allowGitConfigEnv && (
      normalized === "GIT_CONFIG_COUNT"
      || normalized === "GIT_TERMINAL_PROMPT"
      || /^GIT_CONFIG_(?:KEY|VALUE)_(?:[0-9]|[12][0-9]|3[01])$/.test(normalized)
    );
    // Overrides are explicit, but they still cannot smuggle a foreign/unknown
    // provider credential into a child or reintroduce control-plane state.
    if (value != null && (allowed.has(normalized) || allowedGitConfig)) env[key] = value;
  }
  if (provider === "opencode" && process.platform === "win32") {
    const hasSystemCa = Object.keys(env).some((key) => envName(key) === "NODE_USE_SYSTEM_CA");
    if (!hasSystemCa) env.NODE_USE_SYSTEM_CA = "1";
  }
  // Provider CLIs on Chinese Windows inherit OEM/ANSI code pages unless we pin UTF-8.
  // These are non-secret locale flags; they do not relax the provider allowlist.
  if (!Object.keys(env).some((key) => envName(key) === "PYTHONIOENCODING")) env.PYTHONIOENCODING = "utf-8";
  if (!Object.keys(env).some((key) => envName(key) === "PYTHONUTF8")) env.PYTHONUTF8 = "1";
  if (!Object.keys(env).some((key) => envName(key) === "LANG")) env.LANG = "C.UTF-8";
  if (!Object.keys(env).some((key) => envName(key) === "LC_ALL")) env.LC_ALL = "C.UTF-8";
  return withRuntimeExecutablePath(env);
}

const terminationByChild = new WeakMap();

function hasExited(child) {
  return child.exitCode != null || child.signalCode != null;
}

function streamsClosed(child) {
  return [child.stdin, child.stdout, child.stderr]
    .filter(Boolean)
    .every((stream) => stream.destroyed || stream.closed);
}

function waitWithTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise.then(() => true),
    new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function waitForTerminationRequest(child, timeoutMs, signal) {
  if (typeof child?.waitForTerminationRequest !== "function") return;
  const completed = await waitWithTimeout(
    Promise.resolve().then(() => child.waitForTerminationRequest()),
    Math.max(250, timeoutMs),
  );
  if (!completed) {
    const error = new Error(`child process ${child.pid || "unknown"} did not confirm ${signal} delivery`);
    error.code = "PROCESS_TERMINATION_REQUEST_TIMEOUT";
    throw error;
  }
}

function runTaskkill(pid, timeoutMs) {
  return new Promise((resolveKill) => {
    let killer;
    let settled = false;
    let timer = null;
    const finish = (success) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveKill(success);
    };
    try {
      killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
    } catch {
      resolveKill(false);
      return;
    }
    timer = setTimeout(() => {
      try { killer.kill(); } catch {}
      finish(false);
    }, Math.max(250, timeoutMs));
    killer.once("error", () => finish(false));
    killer.once("close", (code) => finish(code === 0));
  });
}

async function terminateChildProcessInternal(child, { timeoutMs = 3_000 } = {}) {
  if (!child) return;
  if (hasExited(child) && streamsClosed(child)) return;
  const closed = new Promise((resolveClose) => child.once?.("close", resolveClose));

  let terminationRequestError = null;
  if (!hasExited(child)) {
    if (process.platform === "win32" && child.pid) {
      const killedTree = await runTaskkill(child.pid, timeoutMs);
      if (!killedTree && !hasExited(child)) {
        try { child.kill?.(); } catch {}
      }
    } else {
      try {
        child.kill?.("SIGTERM");
        await waitForTerminationRequest(child, timeoutMs, "SIGTERM");
      } catch (error) {
        terminationRequestError = error;
      }
    }
  }

  let completed = await waitWithTimeout(closed, Math.max(250, timeoutMs));
  if (!completed || terminationRequestError) {
    try {
      child.kill?.(process.platform === "win32" ? undefined : "SIGKILL");
      await waitForTerminationRequest(child, 500, process.platform === "win32" ? "termination" : "SIGKILL");
      terminationRequestError = null;
    } catch (error) {
      terminationRequestError = error;
    }
    child.stdin?.destroy?.();
    child.stdout?.resume?.();
    child.stderr?.resume?.();
    if (!completed) completed = await waitWithTimeout(closed, 500);
  }
  if (!completed) {
    const error = new Error(`child process ${child.pid || "unknown"} did not close after termination`);
    error.code = "PROCESS_TERMINATION_TIMEOUT";
    throw error;
  }
  if (terminationRequestError) throw terminationRequestError;
  child.stdin?.destroy?.();
  child.stdout?.destroy?.();
  child.stderr?.destroy?.();
  child.unref?.();
}

export function terminateChildProcessAndWait(child, options = {}) {
  if (!child) return Promise.resolve();
  const existing = terminationByChild.get(child);
  if (existing) return existing;
  const termination = terminateChildProcessInternal(child, options);
  terminationByChild.set(child, termination);
  return termination;
}

export function terminateChildProcess(child) {
  void terminateChildProcessAndWait(child).catch(() => {});
}

export function runProcess(command, args = [], options = {}) {
  const {
    cwd,
    env,
    provider = undefined,
    providerKeys = null,
    allowGitConfigEnv = false,
    input = null,
    timeoutMs = 15_000,
    maxOutputBytes = 2 * 1024 * 1024,
    signal,
    onStdout,
    onStderr,
    spawnImpl = spawnCommand,
    terminateImpl = terminateChildProcessAndWait,
  } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error("process aborted");
      error.code = "ABORTED";
      reject(error);
      return;
    }
    const effectiveProvider = provider === undefined ? inferProcessProvider(command, args) : provider;
    const child = spawnImpl(command, args, {
      cwd,
      env: childProcessEnv(env, process.env, { provider: effectiveProvider, providerKeys, allowGitConfigEnv }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let terminating = false;
    let collecting = true;
    let timer = null;
    let abort = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
      callback(value);
    };

    // 逐通道 StringDecoder：把跨 pipe-chunk 边界切断的多字节 UTF-8 序列缓冲到下个 chunk，
    // 避免中文等字符在任意 64KB 读缓冲边界处被切成两半而产生 U+FFFD 乱码（并写坏 events.jsonl）。
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const stopCollecting = () => {
      if (!collecting) return;
      collecting = false;
      child.stdout.off("data", handleStdoutData);
      child.stderr.off("data", handleStderrData);
      child.stdout.off("end", handleStdoutEnd);
      child.stderr.off("end", handleStderrEnd);
      child.stdout.resume?.();
      child.stderr.resume?.();
    };
    const requestTermination = (error) => {
      if (settled || terminating) return;
      terminating = true;
      clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
      stopCollecting();
      try { child.stdin?.destroy?.(); } catch {}
      const termination = Promise.resolve()
        .then(() => terminateImpl(child))
        .catch((terminationError) => {
          try { error.terminationError = terminationError; } catch {}
        })
        .then(() => finish(reject, error));
      void termination.catch(() => {});
    };
    const collect = (chunk, channel) => {
      if (!collecting || terminating || settled) return false;
      outputBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      if (outputBytes > maxOutputBytes) {
        const error = new Error("process output limit exceeded");
        error.code = "OUTPUT_LIMIT";
        requestTermination(error);
        return false;
      }
      try {
        const value = (channel === "stdout" ? stdoutDecoder : stderrDecoder).write(chunk);
        if (channel === "stdout") {
          stdout += value;
          if (value) onStdout?.(value);
        } else {
          stderr += value;
          if (value) onStderr?.(value);
        }
      } catch (error) {
        requestTermination(error);
        return false;
      }
      return true;
    };

    const handleStdoutData = (chunk) => collect(chunk, "stdout");
    const handleStderrData = (chunk) => collect(chunk, "stderr");
    // 各流 end 时冲刷该通道 decoder 残留（截断的多字节尾字节），此刻数据已完全到达；
    // 用 close（所有 stdio 流关闭后触发）而非 exit 结算——exit 可能早于 stdout 尾部到达，会丢尾字/乱码。
    const handleStdoutEnd = () => {
      if (!collecting) return;
      try {
        const tail = stdoutDecoder.end();
        if (tail) { stdout += tail; onStdout?.(tail); }
      } catch (error) {
        requestTermination(error);
      }
    };
    const handleStderrEnd = () => {
      if (!collecting) return;
      try {
        const tail = stderrDecoder.end();
        if (tail) { stderr += tail; onStderr?.(tail); }
      } catch (error) {
        requestTermination(error);
      }
    };
    child.stdout.on("data", handleStdoutData);
    child.stderr.on("data", handleStderrData);
    child.stdout.on("end", handleStdoutEnd);
    child.stderr.on("end", handleStderrEnd);
    child.once("error", (error) => {
      if (terminating) return;
      stopCollecting();
      finish(reject, error);
    });
    child.once("close", (code, exitSignal) => {
      if (terminating) return;
      finish(resolve, { code, signal: exitSignal, stdout, stderr });
    });
    abort = () => {
      const error = new Error("process aborted");
      error.code = "ABORTED";
      requestTermination(error);
    };
    timer = setTimeout(() => {
      const error = new Error(`process timed out after ${timeoutMs}ms`);
      error.code = "PROCESS_TIMEOUT";
      requestTermination(error);
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    try {
      if (input == null) child.stdin.end();
      else child.stdin.end(input, "utf8");
    } catch (error) {
      requestTermination(error);
    }
  });
}
