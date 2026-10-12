import test from "node:test";
import assert from "node:assert/strict";

import { CLI_TOOLS, compareVersions, createCliEnvironmentService, installSpec, operationSpec } from "../src/cli-env.mjs";

const ALL_LATEST = Object.freeze({
  "@anthropic-ai/claude-code": "2.1.220",
  "@openai/codex": "0.55.0",
  "@google/gemini-cli": "0.53.1",
  "@google/antigravity-cli": "1.0.0",
  "@xai-official/grok": "0.2.118",
  "@moonshot-ai/kimi-code": "1.4.0",
  "@earendil-works/pi-coding-agent": "0.20.2",
  "opencode-ai": "0.6.3",
  openclaw: "1.2.0",
  "hermes-agent": "0.19.0",
  "@tencent-ai/codebuddy-code": "2.132.0",
});

const CURSOR_LATEST = "2026.07.23-e383d2b";
// 官方安装脚本为版本钉住的快照：版本标记内嵌在 downloads.cursor.com/lab/<版本>/ 下载路径里（2026-08 实证）
const CURSOR_SCRIPT = "# Cursor Agent Installer\nDOWNLOAD_URL=\"https://downloads.cursor.com/lab/2026.07.23-e383d2b/${OS}/${ARCH}/agent-cli-package.tar.gz\"\n";

/**
 * installed: command → { version } | { code, stderr } | { error, code? }（缺省 = ENOENT 未安装）
 * 安装调用（非 --version）会把对应工具版本刷新到 ALL_LATEST，模拟升级生效。
 */
function createMocks({ installed = {}, latest = ALL_LATEST, fetchFail = false, installFails = false } = {}) {
  const runCalls = [];
  const fetchCalls = [];
  const runProcessImpl = async (command, args, options = {}) => {
    runCalls.push({ command, args, options });
    const isProbe = args.length === 1 && args[0] === "--version";
    if (!isProbe) {
      if (installFails) return { code: 1, signal: null, stdout: "", stderr: "EACCES permission denied" };
      const spec = args.join(" ");
      if (command === "grok" && args[0] === "update") {
        installed.grok = { version: ALL_LATEST["@xai-official/grok"] };
        return { code: 0, signal: null, stdout: "Grok updated", stderr: "" };
      }
      if ((command === "powershell.exe" && spec.includes("x.ai/cli/install.ps1"))
        || (command === "bash" && spec.includes("x.ai/cli/install.sh"))) {
        installed.grok = { version: ALL_LATEST["@xai-official/grok"] };
        return { code: 0, signal: null, stdout: "Grok installed", stderr: "" };
      }
      if ((command === "powershell.exe" && spec.includes("antigravity.google/cli/install.ps1"))
        || (command === "bash" && spec.includes("antigravity.google/cli/install.sh"))) {
        installed.agy = { version: ALL_LATEST["@google/antigravity-cli"] };
        return { code: 0, signal: null, stdout: "Antigravity installed", stderr: "" };
      }
      if (command === "bash" && spec.includes("cursor.com/install")) {
        installed["cursor-agent"] = { version: CURSOR_LATEST };
        return { code: 0, signal: null, stdout: "Cursor Agent installed", stderr: "" };
      }
      const tool = CLI_TOOLS.find((item) => spec.includes(item.packageName));
      if (tool) installed[tool.command] = { version: ALL_LATEST[tool.packageName] };
      return { code: 0, signal: null, stdout: "added 1 package", stderr: "" };
    }
    const record = installed[command];
    if (!record) {
      const error = new Error(`spawn ${command} ENOENT`);
      error.code = "ENOENT";
      throw error;
    }
    if (record.error) {
      const error = new Error(record.error);
      error.code = record.code ?? "EACCES";
      throw error;
    }
    if (record.code) return { code: record.code, signal: null, stdout: record.stdout ?? "", stderr: record.stderr ?? "" };
    return { code: 0, signal: null, stdout: `${command} ${record.version}`, stderr: "" };
  };
  const fetchImpl = async (url) => {
    fetchCalls.push(url);
    if (fetchFail) throw new Error("network down");
    if (url === "https://cursor.com/install") return { ok: true, status: 200, text: async () => CURSOR_SCRIPT };
    const name = Object.keys(latest).find((pkg) => url.endsWith(pkg) || url.endsWith(`${pkg}/json`));
    if (!name) return { ok: false, status: 404, json: async () => ({}) };
    const version = latest[name];
    return url.includes("pypi.org")
      ? { ok: true, status: 200, json: async () => ({ info: { version } }) }
      : { ok: true, status: 200, json: async () => ({ "dist-tags": { latest: version } }) };
  };
  return { runCalls, fetchCalls, runProcessImpl, fetchImpl };
}

const makeService = (mocks, extra = {}) => createCliEnvironmentService({
  runProcessImpl: mocks.runProcessImpl,
  fetchImpl: mocks.fetchImpl,
  ...extra,
});

const toolById = (tools, id) => tools.find((tool) => tool.id === id);

test("snapshot 覆盖全部 12 个 CLI，缺失二进制如实报 not-installed 且仍给出最新版", async () => {
  const mocks = createMocks();
  const service = makeService(mocks);
  const { tools, platform, generatedAt } = await service.snapshot({ refresh: true });

  assert.equal(tools.length, 12);
  assert.ok(tools.every((tool) => tool.status === "not-installed"));
  assert.ok(tools.every((tool) => tool.currentVersion === null));
  assert.ok(tools.every((tool) => tool.upgradeAvailable === false));
  assert.equal(toolById(tools, "claude").latestVersion, "2.1.220");
  assert.equal(toolById(tools, "cursor").latestVersion, CURSOR_LATEST, "script 版本源从官方安装脚本内嵌标记解析");
  assert.equal(toolById(tools, "codebuddy").latestVersion, "2.132.0");
  assert.equal(toolById(tools, "antigravity").latestVersion, "1.0.0");
  assert.equal(platform, process.platform);
  assert.ok(generatedAt);
});

test("--version 非零退出码标 broken 并带回输出尾部，不冒充未安装", async () => {
  const mocks = createMocks({ installed: { claude: { code: 1, stderr: "SyntaxError: broken install" } } });
  const service = makeService(mocks);
  const { tools } = await service.snapshot({ refresh: true });

  const claude = toolById(tools, "claude");
  assert.equal(claude.status, "broken");
  assert.match(claude.probeError, /exited 1/);
  assert.match(claude.probeError, /broken install/);
  assert.equal(claude.currentVersion, null);
});

test("spawn 非 ENOENT 错误标 broken（not installed or not executable）", async () => {
  const mocks = createMocks({ installed: { codex: { error: "permission denied", code: "EACCES" } } });
  const service = makeService(mocks);
  const { tools } = await service.snapshot({ refresh: true });

  const codex = toolById(tools, "codex");
  assert.equal(codex.status, "broken");
  assert.match(codex.probeError, /not installed or not executable/);
});

test("版本解析与升级判定：相同即 up-to-date，落后即 upgrade-available", async () => {
  const mocks = createMocks({
    installed: {
      claude: { version: "2.1.220" }, // 与 registry 相同
      grok: { version: "0.2.112" }, // 落后于 0.2.118
      kimi: { version: "1.4.0-rc.1" }, // 预发布段参与解析不参与比较
    },
  });
  const service = makeService(mocks);
  const { tools } = await service.snapshot({ refresh: true });

  assert.equal(toolById(tools, "claude").status, "up-to-date");
  const grok = toolById(tools, "grok");
  assert.equal(grok.status, "upgrade-available");
  assert.equal(grok.upgradeAvailable, true);
  assert.equal(grok.currentVersion, "0.2.112");
  assert.equal(toolById(tools, "kimi").currentVersion, "1.4.0-rc.1");
  assert.equal(toolById(tools, "kimi").status, "up-to-date");
});

test("registry 不可达时如实降级：latestVersion null + latestError，本地已装标 installed 不装死", async () => {
  const mocks = createMocks({ installed: { claude: { version: "2.1.220" } }, fetchFail: true });
  const service = makeService(mocks);
  const { tools } = await service.snapshot({ refresh: true });

  const claude = toolById(tools, "claude");
  assert.equal(claude.status, "installed");
  assert.equal(claude.latestVersion, null);
  assert.match(claude.latestError, /network down/);
  const codex = toolById(tools, "codex");
  assert.equal(codex.status, "not-installed");
  assert.equal(codex.latestVersion, null);
});

test("hermes 走 PyPI 版本源，安装命令为 python -m pip", async () => {
  const mocks = createMocks();
  const service = makeService(mocks);
  const { tools } = await service.snapshot({ refresh: true });

  assert.ok(mocks.fetchCalls.some((url) => url === "https://pypi.org/pypi/hermes-agent/json"));
  assert.ok(mocks.fetchCalls.some((url) => url === "https://registry.npmjs.org/@anthropic-ai/claude-code"));
  const hermes = toolById(tools, "hermes");
  assert.equal(hermes.registry, "pypi");
  assert.deepEqual(hermes.install, {
    command: "python",
    args: ["-m", "pip", "install", "--upgrade", "hermes-agent"],
    display: "python -m pip install --upgrade hermes-agent",
  });
});

test("install 未确认拒绝（CLI_ENV_NOT_CONFIRMED / 409），未知工具 404", async () => {
  const mocks = createMocks();
  const service = makeService(mocks);

  await assert.rejects(
    service.install({ id: "claude" }),
    (error) => error.code === "CLI_ENV_NOT_CONFIRMED" && error.httpStatus === 409,
  );
  await assert.rejects(
    service.install({ id: "not-a-cli", confirmed: true }),
    (error) => error.code === "CLI_ENV_UNKNOWN_TOOL" && error.httpStatus === 404,
  );
  assert.equal(mocks.runCalls.length, 0, "未过闸不得触碰子进程");
});

test("install 调 npm install -g <pkg>@latest，成功后重探测并原位更新缓存", async () => {
  const mocks = createMocks({ installed: { claude: { version: "2.0.0" } } });
  const service = makeService(mocks);
  const before = await service.snapshot({ refresh: true });
  assert.equal(toolById(before.tools, "claude").status, "upgrade-available");

  const result = await service.install({ id: "claude", confirmed: true });
  assert.equal(result.ok, true);
  assert.deepEqual(
    mocks.runCalls.find((call) => call.command === "npm")?.args,
    ["install", "-g", "@anthropic-ai/claude-code@latest"],
  );
  assert.equal(result.tool.status, "up-to-date");
  assert.equal(result.tool.currentVersion, "2.1.220");

  const after = await service.snapshot();
  assert.equal(toolById(after.tools, "claude").currentVersion, "2.1.220", "缓存中的工具视图已被原位更新");
});

test("Grok Build 在 Windows 按安装状态选择官方安装器或内置 updater，且更新进程不注入 Provider 凭据", async () => {
  const grok = CLI_TOOLS.find((tool) => tool.id === "grok");
  assert.deepEqual(installSpec(grok, "win32"), {
    command: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Invoke-RestMethod https://x.ai/cli/install.ps1 | Invoke-Expression"],
    display: "irm https://x.ai/cli/install.ps1 | iex",
  });
  assert.deepEqual(operationSpec(grok, "win32", true), {
    command: "grok",
    args: ["update", "--stable"],
    display: "grok update --stable",
  });

  const mocks = createMocks({ installed: { grok: { version: "0.2.112" } } });
  const service = makeService(mocks, { platform: "win32" });
  const before = await service.snapshot({ refresh: true });
  const beforeGrok = toolById(before.tools, "grok");
  assert.equal(beforeGrok.status, "upgrade-available");
  assert.equal(beforeGrok.install.display, "grok update --stable");
  assert.equal(beforeGrok.installSource, "Grok 内置更新器");

  const result = await service.install({ id: "grok", confirmed: true });
  const updateCall = mocks.runCalls.find((call) => call.command === "grok" && call.args[0] === "update");
  assert.deepEqual(updateCall?.args, ["update", "--stable"]);
  assert.equal(updateCall?.options.provider, null);
  assert.equal(mocks.runCalls.some((call) => call.command === "npm" && call.args.some((arg) => arg.includes("@xai-official/grok"))), false);
  assert.equal(result.tool.currentVersion, "0.2.118");
  assert.equal(result.tool.status, "up-to-date");
});

test("Grok Build 未安装时在 Windows 执行 xAI 官方 PowerShell 安装器", async () => {
  const mocks = createMocks();
  const service = makeService(mocks, { platform: "win32" });
  await service.snapshot({ refresh: true });

  const result = await service.install({ id: "grok", confirmed: true });
  const installCall = mocks.runCalls.find((call) => call.command === "powershell.exe" && call.args.includes("Invoke-RestMethod https://x.ai/cli/install.ps1 | Invoke-Expression"));
  assert.ok(installCall);
  assert.equal(installCall.options.provider, null);
  assert.equal(result.tool.currentVersion, "0.2.118");
});

test("install 失败如实报 CLI_ENV_INSTALL_FAILED（502）并附 outputTail", async () => {
  const mocks = createMocks({ installed: { claude: { version: "2.0.0" } }, installFails: true });
  const service = makeService(mocks);
  await service.snapshot({ refresh: true });

  await assert.rejects(
    service.install({ id: "claude", confirmed: true }),
    (error) => error.code === "CLI_ENV_INSTALL_FAILED"
      && error.httpStatus === 502
      && /EACCES/.test(error.outputTail),
  );
});

test("快照缓存：TTL 内复用，refresh=1 绕过重探测", async () => {
  const mocks = createMocks({ installed: { claude: { version: "2.1.220" } } });
  let tick = 1_000;
  const service = makeService(mocks, { now: () => tick, cacheTtlMs: 600_000 });

  await service.snapshot({ refresh: true });
  const probesAfterFirst = mocks.runCalls.length;
  assert.equal(probesAfterFirst, CLI_TOOLS.length);

  await service.snapshot();
  assert.equal(mocks.runCalls.length, probesAfterFirst, "TTL 内不得重复探测");

  tick += 600_001;
  await service.snapshot();
  assert.equal(mocks.runCalls.length, probesAfterFirst * 2, "TTL 过期自动重探测");

  await service.snapshot({ refresh: true });
  assert.equal(mocks.runCalls.length, probesAfterFirst * 3, "refresh=1 强制重探测");
});

test("compareVersions 展示级比较语义", () => {
  assert.ok(compareVersions("0.2.118", "0.2.112") > 0);
  assert.ok(compareVersions("2.1.220", "2.1.220") === 0);
  assert.ok(compareVersions("0.2.112", "0.19.0") < 0);
  assert.ok(compareVersions("1.4.0-rc.1", "1.4.0") === 0, "预发布段不参与大小判定");
});

test("installSpec 与 CLI_TOOLS 契约：12 项固定清单，Grok/Antigravity 走官方安装器，其余 npm 工具统一 @latest", () => {
  assert.equal(CLI_TOOLS.length, 12);
  assert.deepEqual(CLI_TOOLS.map((tool) => tool.id), ["claude", "codex", "gemini", "antigravity", "grok", "kimi", "pi", "opencode", "openclaw", "hermes", "cursor", "codebuddy"]);
  for (const tool of CLI_TOOLS) {
    const spec = installSpec(tool, "linux");
    if (tool.id === "grok") {
      assert.deepEqual(spec, {
        command: "bash",
        args: ["-c", "curl -fsSL https://x.ai/cli/install.sh | bash"],
        display: "curl -fsSL https://x.ai/cli/install.sh | bash",
      });
      continue;
    }
    if (tool.id === "antigravity") {
      assert.deepEqual(spec, {
        command: "bash",
        args: ["-c", "curl -fsSL https://antigravity.google/cli/install.sh | bash"],
        display: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      });
      continue;
    }
    if (tool.registry === "pypi") assert.equal(spec.command, "python");
    else if (tool.registry === "script") assert.equal(spec.command, "bash");
    else {
      assert.equal(spec.command, "npm");
      assert.deepEqual(spec.args, ["install", "-g", `${tool.packageName}@latest`]);
    }
  }
});

test("cursor 走官方脚本版本源：win32 一键安装如实置不可用，linux/darwin 给官方脚本", async () => {
  const cursor = CLI_TOOLS.find((tool) => tool.id === "cursor");

  // win32 无官方包（win32 tarball 403 实测）：spec 为 null，前端出说明不出假按钮
  assert.equal(installSpec(cursor, "win32"), null);
  assert.match(cursor.install.unsupportedNote, /Windows 无官方 CLI 安装包/);
  const linuxSpec = installSpec(cursor, "linux");
  assert.deepEqual(linuxSpec, {
    command: "bash",
    args: ["-c", "curl -fsSL https://cursor.com/install | bash"],
    display: "curl -fsSL https://cursor.com/install | bash",
  });

  // win32 服务端硬闸：确认过了也 409 CLI_ENV_UNSUPPORTED_PLATFORM，不伪造命令
  const mocksWin = createMocks();
  const serviceWin = makeService(mocksWin, { platform: "win32" });
  await assert.rejects(
    serviceWin.install({ id: "cursor", confirmed: true }),
    (error) => error.code === "CLI_ENV_UNSUPPORTED_PLATFORM" && error.httpStatus === 409,
  );
  assert.equal(mocksWin.runCalls.length, 0, "平台闸未过不得触碰子进程");

  // linux：官方脚本路径可用，安装后重探测到脚本内嵌版本
  const mocksLinux = createMocks();
  const serviceLinux = makeService(mocksLinux, { platform: "linux" });
  await serviceLinux.snapshot({ refresh: true });
  const result = await serviceLinux.install({ id: "cursor", confirmed: true });
  assert.equal(result.ok, true);
  assert.deepEqual(
    mocksLinux.runCalls.find((call) => call.command === "bash")?.args,
    ["-c", "curl -fsSL https://cursor.com/install | bash"],
  );
  assert.equal(result.tool.currentVersion, CURSOR_LATEST);
  assert.equal(result.tool.status, "up-to-date");
});
