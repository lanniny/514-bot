import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { attachLfJsonl, encodeJsonLine } from "../src/jsonl.mjs";
import { findSecretCandidates, sanitizeForPersistence, scrub } from "../src/redaction.mjs";
import { childProcessEnv, inferProcessProvider, resolveCommand, runProcess, terminateChildProcessAndWait } from "../src/process-runner.mjs";
import { buildCodexArgs } from "../src/adapters/codex-cli.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

test("persistence sanitizer removes secrets and private reasoning", () => {
  const value = sanitizeForPersistence({
    apiKey: "sk-test-12345678901234567890",
    message: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    thinking: "private reasoning",
    nested: { ok: "visible" },
  });
  assert.equal(value.apiKey, "[REDACTED]");
  assert.match(value.message, /\[REDACTED\]/);
  assert.equal(value.thinking, "[NOT_PERSISTED]");
  assert.equal(value.nested.ok, "visible");
});

test("scrub handles compound credential keys, quoted values and structured contexts", () => {
  const secret = "not-high-entropy";
  const cases = [
    `OPENAI_API_KEY=${secret}`,
    `refresh_token='${secret}'`,
    `"client_secret": "${secret}"`,
    `BUILD_PIPELINE_PASSWORD="${secret}"`,
    `AWS_ACCESS_KEY_ID=${secret}`,
    `Authorization: Bearer ${secret}`,
    `Bearer=${secret}`,
    `password="unterminated-secret`,
    `--api-key ${secret}`,
    `api_key = """${secret}"""`,
    `api_key: |\n  ${secret}\n`,
    `api_key: |2-\n  ${secret}\n`,
    `{"accessToken":"${secret}","note":"visible"}`,
    `postgres://alice:${secret}@db.example/app`,
    `https://${secret}@example.invalid/private.git`,
    `https://example.invalid/pkg?key=${secret}&visible=yes`,
    `apiKeys=${secret}`,
    `credentials: ${secret}`,
    `x-api-keys=${secret}`,
  ];
  for (const sample of cases) {
    const safe = scrub(sample);
    assert.ok(!safe.includes(secret), `${sample} -> ${safe}`);
    assert.match(safe, /\[REDACTED\]/);
  }

  const url = scrub(`https://example.test/callback?refresh_token=${secret}&state=visible#done`);
  assert.ok(!url.includes(secret), url);
  assert.match(url, /&state=visible#done$/);

  const json = scrub(`{"client_secret":"${secret}","note":"visible"}`);
  assert.deepEqual(JSON.parse(json), { client_secret: "[REDACTED]", note: "visible" });

  assert.equal(scrub("tokens=71607"), "tokens=71607");

  const yaml = scrub(`api_key: |\n  ${secret}\nnext: visible`);
  assert.equal(yaml, 'api_key: "[REDACTED]"\nnext: visible');
});

test("scrub leaves ordinary text and credential references intact", () => {
  const text = "Token budgets count model input. The secret sauce stays in the recipe. A keyboard key is ordinary.";
  assert.equal(scrub(text), text);
  assert.equal(scrub("OPENAI_API_KEY=${OPENAI_API_KEY}"), "OPENAI_API_KEY=${OPENAI_API_KEY}");
  assert.equal(scrub("OPENAI_API_KEY=$OPENAI_API_KEY"), "OPENAI_API_KEY=$OPENAI_API_KEY");
  assert.equal(scrub("Authorization: Bearer $env:CONTROL_CENTER_TOKEN"), "Authorization: Bearer $env:CONTROL_CENTER_TOKEN");
  assert.equal(scrub("https://${CONTROL_CENTER_TOKEN}@example.invalid/repo"), "https://${CONTROL_CENTER_TOKEN}@example.invalid/repo");
  assert.equal(scrub("https://example.invalid/pkg?key=${CONTROL_CENTER_TOKEN}&visible=yes"), "https://example.invalid/pkg?key=${CONTROL_CENTER_TOKEN}&visible=yes");
  assert.equal(scrub("monkey=banana and keyboard_keycap=visible"), "monkey=banana and keyboard_keycap=visible");
});

test("secret scanner accepts references and rejects literals", () => {
  assert.deepEqual(findSecretCandidates('api_key: "${MODEL_API_KEY}"'), []);
  assert.equal(findSecretCandidates('api_key: "abcdefghijklmnop123456"').length, 1);
  assert.ok(findSecretCandidates('{"authorization":"Basic YWJjZGVmZ2hpamtsbW5vcA=="}').length);
  assert.ok(findSecretCandidates('{"aws_access_key_id":"AKIAABCDEFGHIJKLMNOP"}').length); // gitleaks:allow 测试夹具：顺序字母合成串
  assert.match(sanitizeForPersistence({ prompt: "Authorization: Basic YWJjZGVmZ2hpamtsbW5vcA==" }).prompt, /REDACTED/);
  assert.match(sanitizeForPersistence({ prompt: "AKIAABCDEFGHIJKLMNOP" }).prompt, /REDACTED/); // gitleaks:allow 同上
  assert.ok(findSecretCandidates('service_key: "abcdefghijklmnop"').length);
  assert.ok(findSecretCandidates("--api-key abcdefghijklmnop").length);
  assert.ok(findSecretCandidates("api_key: |\n  abcdefghijklmnop\n").length);
  assert.deepEqual(findSecretCandidates("refresh_token=${REFRESH_TOKEN}"), []);
  assert.ok(findSecretCandidates('{"idToken":"abcdefghijklmnop"}').length);
  assert.ok(findSecretCandidates("postgres://alice:abcdefghijklmnop@db.example/app").length);
  assert.ok(findSecretCandidates("https://abcdefghijklmnop@example.invalid/private.git").length);
  assert.ok(findSecretCandidates("https://example.invalid/pkg?key=abcdefghijklmnop").length);
});

test("PEM private keys are fail-closed across legacy, encrypted and truncated forms", () => {
  for (const label of ["DSA PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "OPENSSH PRIVATE KEY", "PGP PRIVATE KEY BLOCK"]) {
    const complete = `before\n-----BEGIN ${label}-----\nsecret-body\n-----END ${label}-----\nafter`;
    const safe = scrub(complete);
    assert.equal(safe, "before\n[REDACTED]\nafter", label);
    assert.doesNotMatch(safe, /secret-body|BEGIN|END/);
  }
  const truncated = "visible\n-----BEGIN PRIVATE KEY-----\nsecret-tail-without-an-end"; // gitleaks:allow 测试夹具：故意不闭合的 PEM 头，验证 fail-closed
  assert.equal(scrub(truncated), "visible\n[REDACTED]");
  assert.ok(findSecretCandidates(truncated).some((message) => message.includes("private key material")));
});

test("YAML block scanning stays linear on adversarial whitespace", () => {
  const input = `api_key: |\n${" ".repeat(100_000)}\rX`;
  const started = performance.now();
  scrub(input);
  assert.ok(performance.now() - started < 500, "100k whitespace should not trigger regex backtracking");
});

test("LF JSONL parser does not split on Unicode line separators", async () => {
  const stream = new PassThrough();
  const messages = [];
  attachLfJsonl(stream, (message) => messages.push(message));
  stream.end(encodeJsonLine({ text: "left\u2028right" }));
  await new Promise((resolve) => stream.once("end", resolve));
  assert.deepEqual(messages, [{ text: "left\u2028right" }]);
});

test("LF JSONL parser bounds one oversized line and resumes at the next newline", async () => {
  const stream = new PassThrough();
  const messages = [];
  const errors = [];
  attachLfJsonl(stream, (message) => messages.push(message), (error, sample) => {
    errors.push({ error, sample });
  }, { maxLineChars: 32 });
  stream.end(`${"x".repeat(200)}\n${encodeJsonLine({ ok: true })}`);
  await new Promise((resolve) => stream.once("end", resolve));
  assert.deepEqual(messages, [{ ok: true }]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.code, "JSONL_LINE_TOO_LONG");
  assert.ok(errors[0].sample.length <= 32);
});

test("Windows command resolution never enables a shell", { skip: process.platform !== "win32" }, () => {
  const resolved = resolveCommand("gemini");
  assert.equal(resolved.command.toLowerCase(), "powershell.exe");
  assert.ok(resolved.prefixArgs.includes("-File"));
  assert.match(resolved.resolvedPath, /gemini\.ps1$/i);
});

test("Windows command resolution respects the first safe PATH owner", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-path-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = resolve(root, "first");
  const second = resolve(root, "second");
  await import("node:fs/promises").then(({ mkdir, writeFile }) => Promise.all([
    mkdir(first, { recursive: true }),
    mkdir(second, { recursive: true }),
  ]).then(() => Promise.all([
    writeFile(resolve(first, "codex.ps1"), "exit 0\n"),
    writeFile(resolve(second, "codex.exe"), "not-an-executable\n"),
  ])));
  const resolved = resolveCommand("codex", { PATH: `${first};${second}` });
  assert.match(resolved.resolvedPath, /first[\\/]codex\.ps1$/i);
  assert.equal(resolved.command.toLowerCase(), "powershell.exe");
});

test("Claude prefers a native executable over an earlier PowerShell shim", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-claude-native-seat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shimDir = resolve(root, "npm-global");
  const nativeDir = resolve(root, "native");
  await import("node:fs/promises").then(({ mkdir, writeFile }) => Promise.all([
    mkdir(shimDir, { recursive: true }),
    mkdir(nativeDir, { recursive: true }),
  ]).then(() => Promise.all([
    writeFile(resolve(shimDir, "claude.ps1"), "exit 0\n"),
    writeFile(resolve(nativeDir, "claude.exe"), "stub"),
  ])));
  const resolved = resolveCommand("claude", { PATH: `${shimDir};${nativeDir}` });
  assert.match(resolved.resolvedPath, /native[\\/]claude\.exe$/i);
  assert.equal(resolved.prefixArgs.length, 0);
  assert.notEqual(resolved.command.toLowerCase(), "powershell.exe");
});

test("grok resolves to ~/.grok/bin when PATH omits it (Phase 3 dispatch)", { skip: process.platform !== "win32" }, async (t) => {
  const home = await mkdtemp(resolve(appRoot, ".test-grok-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const binDir = resolve(home, ".grok", "bin");
  await import("node:fs/promises").then(({ mkdir, writeFile }) =>
    mkdir(binDir, { recursive: true }).then(() => writeFile(resolve(binDir, "grok.exe"), "stub")),
  );
  // PATH intentionally lacks any grok; the known-install fallback must still resolve it
  const resolved = resolveCommand("grok", { PATH: "C:\\Windows\\System32", USERPROFILE: home });
  assert.match(resolved.resolvedPath, /\.grok[\\/]bin[\\/]grok\.exe$/i);
  assert.equal(resolved.prefixArgs.length, 0);
});

test("opencode prefers the npm exe over the PowerShell shim", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-opencode-shim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = resolve(root, "node_modules", "opencode-ai", "bin");
  await import("node:fs/promises").then(({ mkdir, writeFile }) =>
    mkdir(bin, { recursive: true }).then(() => Promise.all([
      writeFile(resolve(root, "opencode.ps1"), "exit 0\n"),
      writeFile(resolve(bin, "opencode.exe"), "stub"),
    ])),
  );
  const resolved = resolveCommand("opencode", { PATH: root });
  assert.match(resolved.resolvedPath, /node_modules[\\/]opencode-ai[\\/]bin[\\/]opencode\.exe$/i);
  assert.equal(resolved.prefixArgs.length, 0);
  assert.notEqual(resolved.command.toLowerCase(), "powershell.exe");
});

test("kimi resolves to ~/.kimi-code/bin when PATH omits it (stale parent env block)", { skip: process.platform !== "win32" }, async (t) => {
  const home = await mkdtemp(resolve(appRoot, ".test-kimi-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const binDir = resolve(home, ".kimi-code", "bin");
  await import("node:fs/promises").then(({ mkdir, writeFile }) =>
    mkdir(binDir, { recursive: true }).then(() => writeFile(resolve(binDir, "kimi.exe"), "stub")),
  );
  // PATH intentionally lacks any kimi（模拟资源管理器派生进程的陈旧环境块）；已知安装路径回退必须兜住
  const resolved = resolveCommand("kimi", { PATH: "C:\\Windows\\System32", USERPROFILE: home });
  assert.match(resolved.resolvedPath, /\.kimi-code[\\/]bin[\\/]kimi\.exe$/i);
  assert.equal(resolved.prefixArgs.length, 0);
});

test("agent child environments expose only the selected provider allowlist", () => {
  const base = {
    Path: "C:/runtime/bin",
    SystemRoot: "C:/Windows",
    ComSpec: "C:/Windows/System32/cmd.exe",
    PATHEXT: ".EXE;.COM",
    TEMP: "C:/Temp",
    TMP: "C:/Temp",
    USERPROFILE: "C:/Users/test",
    HTTPS_PROXY: "http://proxy.test",
    CODEX_HOME: "C:/safe-codex-home",
    OPENAI_API_KEY: "openai-secret",
    ANTHROPIC_AUTH_TOKEN: "anthropic-secret",
    GEMINI_API_KEY: "gemini-secret",
    GROK_API_KEY: "grok-secret",
    GROK_SEARCH_RS_COMPAT_API_KEY: "grok-search-secret",
    KIMI_API_KEY: "kimi-secret",
    INFLECTION_API_KEY: "inflection-secret",
    INFLECTION_BASE_URL: "https://inflection.test/v1",
    INFLECTION_MODEL: "inflection-test",
    OPENCODE_API_KEY: "opencode-secret",
    OPENCODE_CONFIG: "C:/safe-opencode/opencode.json",
    PI_API_KEY: "pi-secret",
    PI_OFFLINE: "1",
    CONTROL_CENTER_TOKEN: "control-secret",
    control_center_token: "control-shadow",
    CODEX_THREAD_ID: "desktop-thread",
    CODEX_SESSION_ID: "desktop-session",
    CODEX_REMOTE_PAYLOAD: "desktop-payload",
  };
  const providerKeys = {
    openai: ["OPENAI_API_KEY", "CODEX_HOME"],
    anthropic: ["ANTHROPIC_AUTH_TOKEN"],
    gemini: ["GEMINI_API_KEY"],
    grok: ["GROK_API_KEY", "GROK_SEARCH_RS_COMPAT_API_KEY"],
    kimi: ["KIMI_API_KEY"],
    opencode: ["OPENCODE_API_KEY", "OPENCODE_CONFIG"],
    pi: ["PI_API_KEY", "INFLECTION_API_KEY", "INFLECTION_BASE_URL", "INFLECTION_MODEL"],
  };
  const allSecrets = Object.values(providerKeys).flat();

  for (const [provider, ownKeys] of Object.entries(providerKeys)) {
    const env = childProcessEnv({}, base, { provider });
    assert.equal(env.Path, base.Path);
    assert.equal(env.SystemRoot, base.SystemRoot);
    assert.equal(env.HTTPS_PROXY, base.HTTPS_PROXY);
    for (const key of ownKeys) assert.equal(env[key], base[key], `${provider} keeps ${key}`);
    for (const key of allSecrets.filter((key) => !ownKeys.includes(key))) {
      assert.equal(Object.hasOwn(env, key), false, `${provider} must not receive ${key}`);
    }
    if (provider === "opencode" && process.platform === "win32") {
      assert.equal(env.NODE_USE_SYSTEM_CA, "1", "OpenCode on Windows must see the system CA flag");
    }
    assert.equal(Object.keys(env).some((key) => key.toLowerCase().startsWith("control_center_")), false);
    assert.equal(Object.hasOwn(env, "CODEX_THREAD_ID"), false);
    assert.equal(Object.hasOwn(env, "CODEX_SESSION_ID"), false);
    assert.equal(Object.hasOwn(env, "CODEX_REMOTE_PAYLOAD"), false);
  }

  const validatorEnv = childProcessEnv({}, base);
  assert.equal(validatorEnv.Path, base.Path);
  assert.equal(validatorEnv.PI_OFFLINE, "1", "non-secret offline guard survives health/validator isolation");
  assert.equal(Object.hasOwn(validatorEnv, "HTTPS_PROXY"), false, "non-provider probes get only runtime state");
  for (const key of allSecrets) assert.equal(Object.hasOwn(validatorEnv, key), false);

  const grokMcpEnv = childProcessEnv({
    CONTROL_CENTER_TOKEN: "override",
    CODEX_SESSION_ID: "override-session",
    CODEX_REMOTE_PAYLOAD: "override-payload",
  }, base, {
    provider: "grok-search",
    providerKeys: ["GROK_SEARCH_RS_COMPAT_API_KEY"],
  });
  assert.equal(grokMcpEnv.GROK_SEARCH_RS_COMPAT_API_KEY, "grok-search-secret");
  assert.equal(Object.hasOwn(grokMcpEnv, "GROK_API_KEY"), false);
  assert.equal(Object.hasOwn(grokMcpEnv, "CONTROL_CENTER_TOKEN"), false);
  assert.equal(Object.hasOwn(grokMcpEnv, "CODEX_SESSION_ID"), false);
  assert.equal(Object.hasOwn(grokMcpEnv, "CODEX_REMOTE_PAYLOAD"), false);
  assert.throws(
    () => childProcessEnv({}, base, { provider: "grok", providerKeys: ["OPENAI_API_KEY"] }),
    { code: "INVALID_ENV_POLICY" },
  );
  assert.throws(() => childProcessEnv({}, base, { provider: "unknown-provider" }), { code: "UNKNOWN_ENV_PROVIDER" });
});

test("Git config overrides require the explicit bounded environment policy", () => {
  const overrides = {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "remote.cc-plan.url",
    GIT_CONFIG_VALUE_0: "https://example.invalid/repo.git",
    GIT_CONFIG_KEY_31: "remote.cc-plan.pushurl",
    GIT_CONFIG_VALUE_31: "https://example.invalid/repo.git",
    GIT_CONFIG_KEY_32: "must-not-pass",
    GIT_DIR: "must-not-pass",
    CONTROL_CENTER_TOKEN: "must-not-pass",
  };
  const blocked = childProcessEnv(overrides, { Path: "C:\\Windows" });
  assert.equal(Object.keys(blocked).some((key) => key.startsWith("GIT_")), false);

  const allowed = childProcessEnv(overrides, { Path: "C:\\Windows", GIT_CONFIG_COUNT: "99" }, {
    allowGitConfigEnv: true,
  });
  assert.equal(allowed.GIT_CONFIG_COUNT, "2", "only the explicit override is accepted; base Git config is not inherited");
  assert.equal(allowed.GIT_CONFIG_KEY_0, "remote.cc-plan.url");
  assert.equal(allowed.GIT_CONFIG_VALUE_31, "https://example.invalid/repo.git");
  assert.equal(Object.hasOwn(allowed, "GIT_CONFIG_KEY_32"), false);
  assert.equal(Object.hasOwn(allowed, "GIT_DIR"), false);
  assert.equal(Object.hasOwn(allowed, "CONTROL_CENTER_TOKEN"), false);
});

test("provider inference keeps health and model discovery probes credential-free", () => {
  assert.equal(inferProcessProvider("claude", ["-p", "review"]), "anthropic");
  assert.equal(inferProcessProvider("codex.exe", ["app-server", "--stdio"]), "openai");
  assert.equal(inferProcessProvider("grok", ["-p", "explain --version semantics"]), "grok");
  assert.equal(inferProcessProvider("opencode", ["run", "--format", "json", "hi"]), "opencode");
  assert.equal(inferProcessProvider("opencode", ["--version"]), null);
  assert.equal(inferProcessProvider("claude", ["--version"]), null);
  assert.equal(inferProcessProvider("codex", ["debug", "models"]), null);
  assert.equal(inferProcessProvider("grok", ["models"]), null);
  assert.equal(inferProcessProvider("python", ["-c", "print('validator')"]), null);
});

test("pre-aborted processes never spawn and stderr obeys the shared output limit", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-pre-abort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = resolve(root, "spawned.txt");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => runProcess(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], 'spawned')", marker], { signal: controller.signal }),
    { code: "ABORTED" },
  );
  await assert.rejects(() => access(marker), { code: "ENOENT" });
  await assert.rejects(
    () => runProcess(process.execPath, ["-e", "process.stderr.write('x'.repeat(4096))"], { maxOutputBytes: 1024 }),
    { code: "OUTPUT_LIMIT" },
  );
});

test("runProcess terminates once, stops collection and settles after the close boundary", async () => {
  class FakeProcess extends EventEmitter {
    constructor() {
      super();
      this.stdin = new PassThrough();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
    }
  }
  const child = new FakeProcess();
  const controller = new AbortController();
  const observed = [];
  let terminationCalls = 0;
  const promise = runProcess("fake-provider", [], {
    signal: controller.signal,
    maxOutputBytes: 4,
    timeoutMs: 60_000,
    spawnImpl: () => child,
    terminateImpl: () => {
      terminationCalls += 1;
      return new Promise((resolve) => child.once("close", resolve));
    },
    onStdout: (chunk) => observed.push(chunk),
  });
  let settled = false;
  void promise.catch(() => { settled = true; });

  child.stdout.write("12345");
  controller.abort();
  child.stdout.write("must-not-be-collected");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(terminationCalls, 1);
  assert.equal(settled, false, "termination rejection waits for child close");
  assert.deepEqual(observed, []);

  child.emit("close", null, "SIGTERM");
  await assert.rejects(promise, { code: "OUTPUT_LIMIT" });
  assert.equal(terminationCalls, 1);
});

test("child termination is shared across concurrent callers and waits for close", async () => {
  class ClosingChild extends EventEmitter {
    constructor() {
      super();
      this.stdin = new PassThrough();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.exitCode = null;
      this.signalCode = null;
      this.killCalls = 0;
    }

    kill() {
      this.killCalls += 1;
      setTimeout(() => {
        this.exitCode = 0;
        this.emit("close", 0);
      }, 15);
    }

    unref() {}
  }

  const child = new ClosingChild();
  const first = terminateChildProcessAndWait(child, { timeoutMs: 500 });
  const second = terminateChildProcessAndWait(child, { timeoutMs: 500 });
  assert.equal(first, second);
  let settled = false;
  void first.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  await Promise.all([first, second]);
  assert.equal(child.killCalls, 1);
});

test("Codex resume keeps top-level sandbox options before the resume subcommand", () => {
  const args = buildCodexArgs({ sessionId: "00000000-0000-0000-0000-000000000000", cwd: "C:/repo" });
  assert.deepEqual(args.slice(0, 6), ["exec", "-s", "read-only", "-C", "C:/repo", "resume"]);
  assert.ok(args.indexOf("-s") < args.indexOf("resume"));
});

test("numeric metering fields survive even when the key smells like a credential", () => {
  const out = sanitizeForPersistence({ tokens: 71607, token_count: 12, api_key: "sk-real-secret-value", service_key: "short-value", enabled: true });
  assert.equal(out.tokens, 71607, "tokens metering number is not redacted");
  assert.equal(out.token_count, 12, "numeric token_count survives");
  assert.equal(out.api_key, "[REDACTED]", "string credentials still redacted");
  assert.equal(out.service_key, "[REDACTED]", "arbitrary _key suffix is redacted");
  assert.equal(out.enabled, true, "booleans survive");
});

// --- F-053 结构化健壮性 -----------------------------------------------------
// 这四条对应的都是实测复现过的故障，不是理论防御。sanitizeForPersistence 位于
// 写盘关键路径（event-store / bus / orchestrator#persistRun / approval-broker），
// 它一崩，丢的是整条事件流，而不只是"少脱敏了一点"。

test("circular and deeply nested graphs are bounded, not fatal", () => {
  const cyclic = { name: "run", children: [] };
  cyclic.self = cyclic;
  cyclic.children.push(cyclic);
  const out = sanitizeForPersistence(cyclic);
  assert.equal(out.self, "[CIRCULAR]", "self reference is bounded");
  assert.equal(out.children[0], "[CIRCULAR]", "repeated child reference is bounded");
  assert.equal(out.name, "run", "siblings outside the cycle survive");

  // 各自独立的深链（非环）也必须被深度上限拦住，否则同样栈溢出
  let deep = { leaf: true };
  for (let i = 0; i < 4000; i += 1) deep = { child: deep };
  let cursor = sanitizeForPersistence(deep);
  let depth = 0;
  while (cursor && typeof cursor === "object" && "child" in cursor) {
    cursor = cursor.child;
    depth += 1;
  }
  assert.equal(cursor, "[TRUNCATED:depth]", "deep chain is truncated instead of throwing");
  assert.ok(depth > 0 && depth < 200, `truncation kicks in early (depth=${depth})`);

  // 同一个对象在不同分支各出现一次，是 DAG 不是环——不该被误判
  const shared = { note: "visible" };
  const dag = sanitizeForPersistence({ left: shared, right: shared });
  assert.deepEqual(dag, { left: { note: "visible" }, right: { note: "visible" } });
});

test("buffers keep their bytes and are still scanned for credentials", () => {
  const clean = Buffer.from("plain log line with no credential");
  assert.equal(sanitizeForPersistence({ blob: clean }).blob, clean, "clean buffer is passed through untouched");

  // 修复前：Buffer 被 Object.entries 拆成 {"0":115,"1":107,...} 的字节索引字典，
  // 既毁数据又让内容绕过全部字符串脱敏。这里两条一起钉死。
  const leaky = Buffer.from(`connecting with sk-${"a1B2c3D4e5F6g7H8i9J0kLmN"}`);
  const out = sanitizeForPersistence({ blob: leaky }).blob;
  assert.ok(out instanceof Uint8Array, "still binary after sanitizing");
  assert.match(Buffer.from(out).toString("latin1"), /\[REDACTED\]/, "credential inside binary is redacted");
  assert.doesNotMatch(Buffer.from(out).toString("latin1"), /a1B2c3D4e5F6g7H8i9J0kLmN/, "raw secret bytes are gone");

  const oversized = Buffer.alloc((1 << 20) + 1, 0x61);
  assert.equal(sanitizeForPersistence({ blob: oversized }).blob, `[BINARY_TRUNCATED ${oversized.byteLength}B]`);
});

test("host object types are preserved rather than silently flattened", () => {
  const at = new Date("2026-08-30T00:00:00.000Z");
  const out = sanitizeForPersistence({
    at,
    endpoint: new URL("https://alice:hunter2@example.invalid/api"),
    tags: new Set(["alpha", "sk-abcdefghijklmnopqrstuvwxyz012345"]),
    limits: new Map([["apiKey", "sk-abcdefghijklmnopqrstuvwxyz012345"], ["rps", 5]]),
    count: 10n,
    pattern: /ab+c/,
  });
  assert.equal(out.at, at, "Date is preserved");
  assert.match(out.endpoint, /\[REDACTED\]/, "URL userinfo credential is scrubbed");
  assert.doesNotMatch(out.endpoint, /hunter2/);
  assert.ok(Array.isArray(out.tags), "Set becomes an array");
  assert.ok(out.tags.includes("alpha"), "non-secret Set members survive");
  assert.ok(out.tags.some((item) => String(item).includes("[REDACTED]")), "secret Set member is redacted");
  assert.equal(out.limits.apiKey, "[REDACTED]", "Map credential key is redacted");
  assert.equal(out.limits.rps, 5, "Map non-secret value survives");
  assert.equal(out.count, "10", "BigInt degrades to string instead of throwing");
  assert.equal(out.pattern instanceof RegExp, true, "RegExp is preserved");
});

test("errors keep name and message with the message scrubbed", () => {
  const out = sanitizeForPersistence({ failure: new Error(`upstream refused sk-${"a1B2c3D4e5F6g7H8i9J0kLmN"}`) });
  assert.equal(out.failure.name, "Error");
  assert.match(out.failure.message, /\[REDACTED\]/);
  assert.doesNotMatch(out.failure.message, /a1B2c3D4e5F6g7H8i9J0kLmN/);
});
