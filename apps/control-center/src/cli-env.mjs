/**
 * cli-env.mjs — 本地 CLI 环境检查与安装/升级（CC Switch 式「环境」面后端）。
 *
 * 契约（v4.0 环境面板波 + Cursor/CodeBuddy 扩编波）：
 *   - 11 项固定 CLI 清单（514cc 席位 6 + Provider 体系 3 + Cursor/CodeBuddy），不读外部目录、不接受任意 id
 *   - 探测走 runProcess(cmd, ["--version"])：probe 参数不注入任何 provider 凭据（process-runner isProbeArgs）
 *   - 最新版走只读版本源（npm dist-tags / PyPI JSON / Cursor 官方安装脚本内嵌版本标记）；失败如实降级 latestVersion:null + latestError，不装死
 *   - 安装/升级两段式：未 confirmed:true → 409 CLI_ENV_NOT_CONFIRMED；未知 id → 404 CLI_ENV_UNKNOWN_TOOL；
 *     平台无官方安装路径（Cursor on win32）→ 409 CLI_ENV_UNSUPPORTED_PLATFORM，不伪造命令
 *   - runProcessImpl / fetchImpl 注入式（测试 mock）
 */

import { runProcess } from "./process-runner.mjs";

const NPM_REGISTRY = "https://registry.npmjs.org";
const PYPI_REGISTRY = "https://pypi.org/pypi";
const VERSION_PATTERN = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;
const PROBE_TIMEOUT_MS = 12_000;
const INSTALL_TIMEOUT_MS = 300_000;

/**
 * brand 对应 index.html sprite 的 icon-cli-<brand>（fill 型官方徽标，currentColor）。
 * openclaw/hermes 无官方 sprite——LO 铁律不臆造品牌图标，前端统一落 lucide terminal。
 * opencode 官方徽标已按 opencode.ai/favicon.svg 同形入 sprite（icon-cli-opencode）。
 */
export const CLI_TOOLS = Object.freeze([
  { id: "claude", label: "Claude Code", command: "claude", packageName: "@anthropic-ai/claude-code", registry: "npm", brand: "claude" },
  { id: "codex", label: "Codex", command: "codex", packageName: "@openai/codex", registry: "npm", brand: "codex" },
  { id: "gemini", label: "Gemini CLI", command: "gemini", packageName: "@google/gemini-cli", registry: "npm", brand: "gemini" },
  {
    id: "grok", label: "Grok Build", command: "grok", packageName: "@xai-official/grok", registry: "npm", brand: "grok",
    install: {
      source: "xAI 官方安装器",
      byPlatform: Object.freeze({
        win32: Object.freeze({
          command: "powershell.exe",
          args: Object.freeze(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Invoke-RestMethod https://x.ai/cli/install.ps1 | Invoke-Expression"]),
          display: "irm https://x.ai/cli/install.ps1 | iex",
        }),
        linux: Object.freeze({
          command: "bash",
          args: Object.freeze(["-c", "curl -fsSL https://x.ai/cli/install.sh | bash"]),
          display: "curl -fsSL https://x.ai/cli/install.sh | bash",
        }),
        darwin: Object.freeze({
          command: "bash",
          args: Object.freeze(["-c", "curl -fsSL https://x.ai/cli/install.sh | bash"]),
          display: "curl -fsSL https://x.ai/cli/install.sh | bash",
        }),
      }),
    },
    upgrade: Object.freeze({
      command: "grok",
      args: Object.freeze(["update", "--stable"]),
      display: "grok update --stable",
      source: "Grok 内置更新器",
    }),
  },
  { id: "kimi", label: "Kimi Code", command: "kimi", packageName: "@moonshot-ai/kimi-code", registry: "npm", brand: "kimi" },
  { id: "pi", label: "Pi", command: "pi", packageName: "@earendil-works/pi-coding-agent", registry: "npm", brand: "pi" },
  { id: "opencode", label: "OpenCode", command: "opencode", packageName: "opencode-ai", registry: "npm", brand: "opencode" },
  { id: "openclaw", label: "OpenClaw", command: "openclaw", packageName: "openclaw", registry: "npm", brand: null },
  { id: "hermes", label: "Hermes", command: "hermes", packageName: "hermes-agent", registry: "pypi", brand: null },
  // Cursor CLI 无官方 npm 包（npm 上的 cursor-agent 是第三方占位，已实证）：最新版从官方安装脚本内嵌的
  // downloads.cursor.com/lab/<版本>/ 路径解析；官方脚本只发 linux/darwin 包（win32 tarball 403 实测），
  // Windows 上一键安装如实置不可用（IDE 自带 cursor-agent 或走 WSL），不伪造命令。
  {
    id: "cursor", label: "Cursor", command: "cursor-agent", packageName: "cursor-agent", registry: "script", brand: null,
    versionUrl: "https://cursor.com/install",
    versionPattern: "/lab/(\\d{4}\\.\\d{2}\\.\\d{2}(?:-[0-9a-z]+)?)/",
    install: {
      platforms: Object.freeze(["linux", "darwin"]),
      command: "bash",
      args: Object.freeze(["-c", "curl -fsSL https://cursor.com/install | bash"]),
      display: "curl -fsSL https://cursor.com/install | bash",
      unsupportedNote: "Windows 无官方 CLI 安装包——由 Cursor IDE 自带 cursor-agent，或经 WSL 安装",
    },
  },
  { id: "codebuddy", label: "CodeBuddy", command: "codebuddy", packageName: "@tencent-ai/codebuddy-code", registry: "npm", brand: null },
]);

function cliEnvError(code, message, httpStatus = 400, extra = {}) {
  return Object.assign(new Error(message), { code, httpStatus, ...extra });
}

function parseVersion(text) {
  const match = String(text).match(VERSION_PATTERN);
  return match ? match[1] : null;
}

/** 展示级版本比较：仅比较 x.y.z 数字核，预发布/构建元数据不参与大小判定。返回 >0 表示 a 更新。 */
export function compareVersions(a, b) {
  const toSegments = (value) => String(value).split(/[+-]/)[0].split(".").map((segment) => {
    const numeric = Number.parseInt(segment, 10);
    return Number.isNaN(numeric) ? 0 : numeric;
  });
  const left = toSegments(a);
  const right = toSegments(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function installSpec(tool, platform = process.platform) {
  // 显式安装描述（script 类）优先；平台不支持时返回 null——前端呈现说明文字，不出假按钮
  if (tool.install) {
    const platformSpec = tool.install.byPlatform?.[platform] ?? tool.install;
    if (tool.install.byPlatform && !tool.install.byPlatform[platform]) return null;
    if (platformSpec.platforms && !platformSpec.platforms.includes(platform)) return null;
    return { command: platformSpec.command, args: [...platformSpec.args], display: platformSpec.display };
  }
  return tool.registry === "pypi"
    ? { command: "python", args: ["-m", "pip", "install", "--upgrade", tool.packageName], display: `python -m pip install --upgrade ${tool.packageName}` }
    : { command: "npm", args: ["install", "-g", `${tool.packageName}@latest`], display: `npm i -g ${tool.packageName}@latest` };
}

export function operationSpec(tool, platform = process.platform, installed = false) {
  if (installed && tool.upgrade) {
    return { command: tool.upgrade.command, args: [...tool.upgrade.args], display: tool.upgrade.display };
  }
  return installSpec(tool, platform);
}

export function createCliEnvironmentService({
  runProcessImpl = runProcess,
  fetchImpl = globalThis.fetch,
  cacheTtlMs = 10 * 60_000,
  platform = process.platform,
  now = () => Date.now(),
} = {}) {
  const state = { cache: null, inflight: null, installLocks: new Map() };

  async function probeLocal(tool, { signal } = {}) {
    let result;
    try {
      result = await runProcessImpl(tool.command, ["--version"], { timeoutMs: PROBE_TIMEOUT_MS, signal });
    } catch (error) {
      if (error?.code === "ENOENT") return { installed: false, version: null, probeError: null };
      // 落在 PATH 但跑不起来（shim 损坏/权限/unsafe shim 等）：如实 broken，不归入"未安装"
      return { installed: false, version: null, probeError: `not installed or not executable (${error?.message ?? error})` };
    }
    if (result.code !== 0) {
      const tail = `${result.stderr}\n${result.stdout}`.trim().slice(-300);
      return { installed: false, version: null, probeError: `--version exited ${result.code}${tail ? `: ${tail}` : ""}` };
    }
    return { installed: true, version: parseVersion(`${result.stdout}\n${result.stderr}`), probeError: null };
  }

  async function fetchLatest(tool, { signal } = {}) {
    const isScript = tool.registry === "script";
    const url = isScript
      ? tool.versionUrl
      : tool.registry === "pypi"
        ? `${PYPI_REGISTRY}/${tool.packageName}/json`
        : `${NPM_REGISTRY}/${tool.packageName}`;
    let response;
    try {
      response = await fetchImpl(url, { headers: { accept: isScript ? "text/plain, */*" : "application/json" }, signal });
    } catch (error) {
      return { latestVersion: null, latestError: `registry unreachable: ${error?.message ?? error}` };
    }
    if (!response?.ok) return { latestVersion: null, latestError: `registry returned ${response?.status}` };
    try {
      if (isScript) {
        const text = await response.text();
        const match = String(text).match(new RegExp(tool.versionPattern));
        return match
          ? { latestVersion: match[1], latestError: null }
          : { latestVersion: null, latestError: "install script version marker not found" };
      }
      const payload = await response.json();
      const latest = tool.registry === "pypi" ? payload?.info?.version : payload?.["dist-tags"]?.latest;
      return latest
        ? { latestVersion: String(latest), latestError: null }
        : { latestVersion: null, latestError: "registry payload missing version" };
    } catch (error) {
      return { latestVersion: null, latestError: `registry payload unreadable: ${error?.message ?? error}` };
    }
  }

  function toolView(tool, local, latest) {
    const currentVersion = local.version;
    const latestVersion = latest.latestVersion;
    let status = "installed";
    if (!local.installed) status = local.probeError ? "broken" : "not-installed";
    else if (currentVersion && latestVersion) status = compareVersions(latestVersion, currentVersion) > 0 ? "upgrade-available" : "up-to-date";
    // installed：版本源缺失或 --version 输出不可解析——如实标"已安装"，不猜新旧
    const operationIsUpgrade = local.installed && Boolean(tool.upgrade);
    return {
      id: tool.id,
      label: tool.label,
      command: tool.command,
      packageName: tool.packageName,
      registry: tool.registry,
      brand: tool.brand,
      status,
      currentVersion,
      latestVersion,
      upgradeAvailable: status === "upgrade-available",
      probeError: local.probeError,
      latestError: latest.latestError,
      install: operationSpec(tool, platform, local.installed),
      installSource: operationIsUpgrade
        ? tool.upgrade.source
        : tool.install?.source ?? (tool.registry === "pypi" ? "PyPI" : tool.registry === "script" ? "官方安装脚本" : "npm registry"),
      installNote: tool.install?.unsupportedNote ?? null,
    };
  }

  async function probeTool(tool, { signal } = {}) {
    const [local, latest] = await Promise.all([probeLocal(tool, { signal }), fetchLatest(tool, { signal })]);
    return toolView(tool, local, latest);
  }

  function snapshot({ refresh = false, signal } = {}) {
    if (!refresh && state.cache && now() - state.cache.at < cacheTtlMs) return Promise.resolve(state.cache.payload);
    if (state.inflight) {
      // 「刷新」不得被旧探测吞掉：等在途批落地后强制重探（否则 UI 显示已完成却没重跑）
      if (!refresh) return state.inflight;
      return state.inflight.then(() => snapshot({ refresh: true, signal }));
    }
    const job = (async () => {
      const tools = await Promise.all(CLI_TOOLS.map((tool) => probeTool(tool, { signal })));
      const payload = { tools, platform, generatedAt: new Date(now()).toISOString() };
      state.cache = { at: now(), payload };
      return payload;
    })().finally(() => { state.inflight = null; });
    state.inflight = job;
    return job;
  }

  async function installNow(tool, { signal } = {}) {
    // 快照可能已过期，执行前重新探测。Grok 已安装时必须走其内置 updater；npm 包仅发布
    // darwin/arm64 构建，在 Windows 上会以 EBADPLATFORM 退出，不能作为现有安装的升级通道。
    const local = await probeLocal(tool, { signal });
    const spec = operationSpec(tool, platform, local.installed);
    if (!spec) {
      throw cliEnvError("CLI_ENV_UNSUPPORTED_PLATFORM", `${tool.label} 在 ${platform} 无官方一键安装路径`, 409);
    }
    let result;
    try {
      result = await runProcessImpl(spec.command, spec.args, { timeoutMs: INSTALL_TIMEOUT_MS, signal, provider: null });
    } catch (error) {
      throw cliEnvError("CLI_ENV_INSTALL_FAILED", `${tool.label} install failed: ${error?.message ?? error}`, 502);
    }
    const outputTail = `${result.stdout}\n${result.stderr}`.trim().slice(-4000);
    if (result.code !== 0) {
      throw cliEnvError("CLI_ENV_INSTALL_FAILED", `${tool.label} install exited ${result.code}`, 502, { outputTail });
    }
    // 只重探测本工具并原位更新缓存——升级全部时避免每个工具都触发 9 路全量快照
    const view = await probeTool(tool, { signal });
    if (state.cache) {
      const tools = state.cache.payload.tools.map((item) => (item.id === tool.id ? view : item));
      state.cache = { at: now(), payload: { ...state.cache.payload, tools, generatedAt: new Date(now()).toISOString() } };
    }
    return { ok: true, tool: view, outputTail };
  }

  async function install({ id, confirmed, signal } = {}) {
    const tool = CLI_TOOLS.find((item) => item.id === String(id ?? ""));
    if (!tool) throw cliEnvError("CLI_ENV_UNKNOWN_TOOL", `unknown cli tool: ${id}`, 404);
    if (confirmed !== true) throw cliEnvError("CLI_ENV_NOT_CONFIRMED", "cli install requires confirmed: true", 409);
    if (!installSpec(tool, platform) && !tool.upgrade) throw cliEnvError("CLI_ENV_UNSUPPORTED_PLATFORM", `${tool.label} 在 ${platform} 无官方一键安装路径`, 409);
    // 同工具安装串行，保证 outputTail/缓存更新次序可读。
    const previous = state.installLocks.get(tool.id) ?? Promise.resolve();
    const job = previous.then(() => installNow(tool, { signal }));
    state.installLocks.set(tool.id, job.catch(() => {}));
    return job;
  }

  return {
    snapshot,
    install,
    listTools: () => CLI_TOOLS.map((tool) => ({ ...tool, install: installSpec(tool, platform), installNote: tool.install?.unsupportedNote ?? null })),
  };
}
