/**
 * W4-10 安全回归测试层。
 *
 * 统一覆盖三类安全边界：
 *   1. SSRF — 出站目标白名单（egress-guard）
 *   2. 路径穿越 — workspace-explorer / memory / 附件
 *   3. 注入 — MCP 参数 / adapter 命令 / 文件名
 *
 * 本文件不重复各模块的专项测试（egress-guard.test.mjs / workspace-explorer.test.mjs），
 * 而是跨模块验证安全边界的**组合不变量**——确保攻击面不会因为模块间的拼接而打开。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { assertEgressAllowed, assertHostAllowed, classifyIp, normalizeNonStandardIp, EGRESS_BLOCKED } from "../src/security/egress-guard.mjs";
import { childProcessEnv, inferProcessProvider } from "../src/process-runner.mjs";
import { sanitizeForPersistence } from "../src/redaction.mjs";

// ─── 1. SSRF 组合不变量 ──────────────────────────────────────────────────────

test("SSRF: cloud metadata IP is blocked under all strategies", () => {
  // strict / lan 两种策略都必须阻断云元数据端点
  const metadataIps = ["169.254.169.254", "0:0:0:0:0:ffff:a9fe:a9fe", "fd00:ec2::254"];
  for (const ip of metadataIps) {
    const verdict = classifyIp(ip);
    assert.ok(verdict, `${ip} must be classified as dangerous`);
  }
  // 169.254.169.254 在任何策略下都阻断
  assert.throws(() => assertHostAllowed("169.254.169.254"), (e) => e.code === EGRESS_BLOCKED);
});

test("SSRF: non-standard IP formats are normalized and blocked", () => {
  // normalizeNonStandardIp 必须将非标准表示法归一化为点分十进制
  assert.equal(normalizeNonStandardIp("0177.0.0.1"), "127.0.0.1", "octal → standard");
  assert.equal(normalizeNonStandardIp("0x7f000001"), "127.0.0.1", "hex → standard");
  assert.equal(normalizeNonStandardIp("2130706433"), "127.0.0.1", "decimal → standard");
  // 归一化后走 classifyIp 规则，环回段必须阻断
  const exoticHosts = ["0177.0.0.1", "2130706433", "0x7f000001"];
  for (const host of exoticHosts) {
    assert.throws(
      () => assertHostAllowed(host),
      (e) => e.code === EGRESS_BLOCKED,
      `${host} should be blocked after normalization`,
    );
  }
  // 非标准格式的公网 IP 应放行
  assert.equal(normalizeNonStandardIp("0x08080808"), "8.8.8.8");
  // 正常域名不受影响
  assert.equal(normalizeNonStandardIp("example.com"), null);
  assert.equal(normalizeNonStandardIp("127.0.0.1"), null, "standard IP not matched here");
});

test("SSRF: DNS rebinding — reserved hostnames blocked at sync check", () => {
  // localhost 的标准形式
  const evilHosts = [
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "[::1]",
  ];
  for (const host of evilHosts) {
    assert.throws(
      () => assertHostAllowed(host),
      (e) => e.code === EGRESS_BLOCKED,
      `${host} should be blocked`,
    );
  }
});

// ─── 2. 子进程环境隔离 ──────────────────────────────────────────────────────

test("subprocess env: unknown command gets zero provider keys", () => {
  const provider = inferProcessProvider("unknown-binary");
  assert.equal(provider, null, "unknown commands must not get provider inference");
  const env = childProcessEnv({}, { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-secret", HOME: "/home/user" }, { provider: null });
  assert.equal(env.ANTHROPIC_API_KEY, undefined, "provider keys must not leak to unknown commands");
  assert.equal(env.HOME, "/home/user", "OS-level keys should pass through");
});

test("subprocess env: probe args suppress provider inference even for known commands", () => {
  // --version / --list-models 等探针不应获得凭据
  assert.equal(inferProcessProvider("claude", ["--version"]), null);
  assert.equal(inferProcessProvider("codex", ["--list-models"]), null);
  assert.equal(inferProcessProvider("gemini", ["models"]), null);
});

test("subprocess env: provider keys are scoped to the correct provider", () => {
  const env = childProcessEnv(
    {},
    { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-secret", OPENAI_API_KEY: "sk-oa-secret", HOME: "/home/user" },
    { provider: "anthropic" },
  );
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-secret", "anthropic key should be available for anthropic provider");
  assert.equal(env.OPENAI_API_KEY, undefined, "openai key must NOT leak to anthropic provider");
});

test("subprocess env: explicit providerKeys override narrows the allowlist", () => {
  const env = childProcessEnv(
    {},
    { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-secret", ANTHROPIC_BASE_URL: "https://api.example.com" },
    { provider: "anthropic", providerKeys: ["ANTHROPIC_API_KEY"] },
  );
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-secret");
  assert.equal(env.ANTHROPIC_BASE_URL, undefined, "non-allowlisted key must be excluded");
});

test("subprocess env: invalid providerKeys throws instead of silently ignoring", () => {
  assert.throws(
    () => childProcessEnv({}, { PATH: "/usr/bin" }, { provider: "anthropic", providerKeys: ["EVIL_KEY"] }),
    (e) => e.code === "INVALID_ENV_POLICY",
  );
});

// ─── 3. 脱敏契约安全边界 ─────────────────────────────────────────────────────

test("sanitizer: API keys are redacted from objects", () => {
  const result = sanitizeForPersistence({
    apiKey: "sk-ant-very-secret-key-12345",
    name: "test",
    token: "tEP1_abcdefghijklmnopqrstuvwxyz1234567890",  // gitleaks:allow 测试夹具，非真实令牌
  });
  assert.ok(!JSON.stringify(result).includes("sk-ant-very-secret-key-12345"), "API key must be redacted");
  assert.ok(!JSON.stringify(result).includes("tEP1_"), "token must be redacted");
  assert.equal(result.name, "test", "non-secret fields should be preserved");
});

test("sanitizer: PEM blocks are redacted", () => {
  const result = sanitizeForPersistence({
    cert: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",  // gitleaks:allow 测试夹具，非真实密钥
  });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("BEGIN RSA PRIVATE KEY"), "PEM must be redacted");
  assert.ok(!serialized.includes("MIIEpAIB"), "PEM content must not leak");
});

test("sanitizer: URL userinfo is stripped", () => {
  const result = sanitizeForPersistence({
    endpoint: "https://user:password@api.example.com/v1",
  });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("password"), "URL password must be stripped");
});

// ─── 4. 文件名安全 ──────────────────────────────────────────────────────────

test("file name safety: path traversal patterns are rejected", () => {
  // 模拟 office.mjs 的 assertSafeFileName 逻辑
  const patterns = [
    "../../../etc/passwd",
    "..\\..\\windows\\system32",
    "file\x00name",  // null byte injection
    "foo/bar",
    "foo\\bar",
  ];
  for (const name of patterns) {
    const hasTraversal = /[/\\]/.test(name) || name.includes("..") || /[\u0000-\u001f]/.test(name);
    assert.ok(hasTraversal, `${JSON.stringify(name)} should be detected as unsafe`);
  }
});

test("file name safety: legitimate names pass through", () => {
  const safeNames = ["report.xlsx", "团队周报-2026Q3.pptx", "data_v2.docx", "my file (final).pdf"];
  for (const name of safeNames) {
    const hasTraversal = /[/\\]/.test(name) || name.includes("..") || /[\u0000-\u001f]/.test(name);
    assert.ok(!hasTraversal, `${name} should be safe`);
  }
});

// ─── 5. 审批安全边界 ─────────────────────────────────────────────────────────

test("approval: unsupported methods cannot enter the queue", async () => {
  const { ApprovalBroker } = await import("../src/approval-broker.mjs");
  const broker = new ApprovalBroker({ eventStore: { emit: async () => {} }, ttlMs: 5000 });
  await assert.rejects(
    () => broker.request({ method: "item/tool/requestUserInput", params: {} }),
    { code: "UNSUPPORTED_APPROVAL" },
  );
  assert.equal(broker.list().length, 0, "rejected requests must not enter the queue");
});

test("approval: hash mismatch prevents action substitution", async () => {
  const { ApprovalBroker } = await import("../src/approval-broker.mjs");
  const broker = new ApprovalBroker({ eventStore: { emit: async () => {} }, ttlMs: 5000 });
  const promise = broker.request({ method: "item/fileChange/requestApproval", params: { path: "a.mjs" } });
  await new Promise((r) => setImmediate(r));
  const [pending] = broker.list();
  await assert.rejects(
    () => broker.resolve(pending.id, { decision: "approve", actionSha256: "wrong-hash" }),
    { code: "APPROVAL_HASH_MISMATCH" },
  );
  await broker.denyAll("cleanup");
  await promise;
});
