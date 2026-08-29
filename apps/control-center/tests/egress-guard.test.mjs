import test from "node:test";
import assert from "node:assert/strict";
import {
  EGRESS_BLOCKED,
  assertEgressAllowed,
  assertHostAllowed,
  assertUrlAllowedSync,
  classifyIp,
  ipv6ToBytes,
} from "../src/security/egress-guard.mjs";

function blocked(fn, hostHint = "") {
  assert.throws(
    fn,
    (error) => error.code === EGRESS_BLOCKED,
    `should be blocked: ${hostHint}`,
  );
}

// ---------------------------------------------------------------------------
// IPv4 阻断段
// ---------------------------------------------------------------------------

test("blocks loopback (IPv4)", () => {
  for (const ip of ["127.0.0.1", "127.1.2.3", "127.255.255.254"]) {
    assert.match(classifyIp(ip)?.label ?? "", /loopback/, ip);
  }
});

test("blocks cloud metadata endpoint 169.254.169.254", () => {
  // 这是 SSRF 最经典的靶子：AWS/GCP/Azure 的临时凭证都从这里拿
  const verdict = classifyIp("169.254.169.254");
  assert.ok(verdict, "169.254.169.254 must be blocked");
  assert.match(verdict.label, /link-local|metadata/);
  blocked(() => assertHostAllowed("169.254.169.254"), "169.254.169.254");
});

test("blocks private ranges", () => {
  const cases = [
    ["10.0.0.1", /private/],
    ["10.255.255.254", /private/],
    ["172.16.0.1", /private/],
    ["172.31.255.254", /private/],
    ["192.168.1.1", /private/],
    ["192.168.0.100", /private/],
  ];
  for (const [ip, pattern] of cases) {
    assert.match(classifyIp(ip)?.label ?? "", pattern, ip);
  }
});

test("honours private-range CIDR boundaries (no off-by-one)", () => {
  // 172.16.0.0/12 的前后边界必须精确：172.15 允许，172.32 允许
  assert.equal(classifyIp("172.15.255.255"), null, "172.15 is public");
  assert.ok(classifyIp("172.16.0.0"), "172.16.0.0 is private");
  assert.ok(classifyIp("172.31.255.255"), "172.31 is private");
  assert.equal(classifyIp("172.32.0.0"), null, "172.32 is public");
});

test("blocks CGNAT, reserved, multicast and broadcast", () => {
  for (const ip of ["100.64.0.1", "0.1.2.3", "192.0.0.1", "224.0.0.1", "239.255.255.255", "240.0.0.1"]) {
    assert.ok(classifyIp(ip), `${ip} must be blocked`);
  }
});

test("allows ordinary public IPv4", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1"]) {
    assert.equal(classifyIp(ip), null, `${ip} must be allowed`);
  }
});

// ---------------------------------------------------------------------------
// IPv6
// ---------------------------------------------------------------------------

test("parses IPv6 to bytes, including compression and embedded IPv4", () => {
  assert.deepEqual([...ipv6ToBytes("::1")], [...new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])]);
  assert.deepEqual([...(ipv6ToBytes("::ffff:127.0.0.1") ?? [])], [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1,
  ]);
  assert.equal(ipv6ToBytes("fe80::1")[0], 0xfe);
  assert.equal(ipv6ToBytes("fe80::1")[1], 0x80);
});

test("blocks IPv6 loopback, ULA, link-local, multicast", () => {
  for (const ip of ["::1", "fc00::1", "fd00::abcd", "fe80::1", "ff02::1", "::"]) {
    assert.ok(classifyIp(ip)?.label, `${ip} must be blocked`);
  }
});

test("blocks IPv4-mapped IPv6 that would otherwise bypass v4 rules", () => {
  // ::ffff:127.0.0.1 与 ::ffff:169.254.169.254 必须落到 IPv4 规则上，
  // 否则就是绕过同步层判定的现成后门
  assert.match(classifyIp("::ffff:127.0.0.1")?.label ?? "", /loopback/);
  assert.match(classifyIp("::ffff:169.254.169.254")?.label ?? "", /link-local|metadata/);
  assert.match(classifyIp("::ffff:10.0.0.1")?.label ?? "", /private/);
  blocked(() => assertHostAllowed("[::ffff:127.0.0.1]"), "::ffff:127.0.0.1");
});

test("normalizes bracketed IPv6 hostnames and zone ids", () => {
  blocked(() => assertHostAllowed("[::1]"), "[::1]");
  blocked(() => assertHostAllowed("fe80::1%eth0"), "fe80::1%eth0");
});

// ---------------------------------------------------------------------------
// URL 层
// ---------------------------------------------------------------------------

test("rejects non-http(s) protocols", () => {
  for (const url of ["ftp://example.com/x", "file:///etc/passwd", "gopher://example.com/", "javascript:alert(1)"]) {
    blocked(() => assertUrlAllowedSync(url), url);
  }
});

test("blocks private hosts embedded in URLs", () => {
  blocked(() => assertUrlAllowedSync("http://127.0.0.1:51400/api/teams"), "loopback control plane");
  blocked(() => assertUrlAllowedSync("https://169.254.169.254/latest/meta-data/iam/security-credentials/"), "cloud metadata");
  blocked(() => assertUrlAllowedSync("http://192.168.0.10:8080/hook"), "private lan");
});

test("blocks reserved names at configuration time, without waiting for DNS", () => {
  // localhost 是域名不是 IP：只做 IP 字面量检查会放它过，
  // 于是"保存成功、发送时才报错"。保留域名必须在同步层就地定案。
  for (const host of ["localhost", "app.localhost", "metadata.google.internal", "instance-data"]) {
    blocked(() => assertHostAllowed(host), host);
    blocked(() => assertUrlAllowedSync(`http://${host}:51400/hook`), host);
  }
});

test("sync layer defers ordinary hostnames to DNS, and still allows them", () => {
  // 普通域名同步层放行是设计如此——真正的判决在 assertEgressAllowed 的 DNS 校验
  assert.equal(assertHostAllowed("evil.example.com"), "evil.example.com");
  assert.equal(assertHostAllowed("hooks.slack.com"), "hooks.slack.com");
});

test("allows public https URLs", () => {
  for (const url of ["https://hooks.example.com/services/T000", "http://example.com/hook"]) {
    assert.equal(assertUrlAllowedSync(url), new URL(url).toString(), url);
  }
});

// ---------------------------------------------------------------------------
// 白名单：可逃逸但必须显式
// ---------------------------------------------------------------------------

test("allowedHosts lets operators opt in to specific internal targets", () => {
  const options = { allowedHosts: ["127.0.0.1", "internal.example.com"] };
  assert.equal(assertHostAllowed("127.0.0.1", options), "127.0.0.1");
  assert.equal(assertUrlAllowedSync("http://127.0.0.1:9000/hook", options).includes("127.0.0.1"), true);
  // 白名单是逐个放行，不是关闭守卫
  blocked(() => assertHostAllowed("10.0.0.5", options), "10.0.0.5 not in allowlist");
});

// ---------------------------------------------------------------------------
// 异步层：DNS rebinding
// ---------------------------------------------------------------------------

test("async layer blocks hostnames that resolve to private addresses", async () => {
  // 域名本身不是 IP，同步层放它过；真正发送前必须靠 DNS 解析结果拦下
  assert.equal(assertHostAllowed("evil.example.com"), "evil.example.com");
  await assert.rejects(
    () => assertEgressAllowed("https://evil.example.com/hook", {
      dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
    }),
    (error) => error.code === EGRESS_BLOCKED,
    "DNS rebinding to loopback must be blocked",
  );
});

test("async layer blocks when ANY resolved address is private", async () => {
  // 只要有一个解析结果不安全就阻断，避免"选一个好看的 IP 发请求"
  await assert.rejects(
    () => assertEgressAllowed("https://dual.example.com/hook", {
      dnsLookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    }),
    (error) => error.code === EGRESS_BLOCKED,
  );
});

test("async layer allows hostnames that resolve to public addresses", async () => {
  const result = await assertEgressAllowed("https://hooks.example.com/x", {
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  assert.equal(result, "https://hooks.example.com/x");
});

test("async layer fails closed when DNS resolution fails", async () => {
  // 拿不到 IP 就无法证明目标安全，因此阻断而不是放行
  await assert.rejects(
    () => assertEgressAllowed("https://nope.example.com/x", {
      dnsLookup: async () => {
        throw new Error("ENOTFOUND");
      },
    }),
    (error) => error.code === EGRESS_BLOCKED && /could not be resolved/.test(error.message),
  );
});

test("async layer fails closed when DNS returns an empty set", async () => {
  await assert.rejects(
    () => assertEgressAllowed("https://empty.example.com/x", { dnsLookup: async () => [] }),
    (error) => error.code === EGRESS_BLOCKED,
  );
});

test("async layer skips DNS for IP literals already verified synchronously", async () => {
  let called = false;
  await assert.rejects(
    () => assertEgressAllowed("http://127.0.0.1/x", {
      dnsLookup: async () => {
        called = true;
        return [{ address: "93.184.216.34", family: 4 }];
      },
    }),
    (error) => error.code === EGRESS_BLOCKED,
  );
  assert.equal(called, false, "IP literal should be rejected before any DNS call");
});

// ---------------------------------------------------------------------------
// LAN 策略：自建端点场景
// ---------------------------------------------------------------------------

test("lan policy allows loopback and private ranges (self-hosted models)", () => {
  for (const host of ["127.0.0.1", "127.1.2.3", "10.1.2.3", "172.16.0.1", "192.168.1.10", "::1", "fd00::1", "localhost"]) {
    assert.equal(assertHostAllowed(host, { policy: "lan" }), host, `${host} must be reachable under lan policy`);
  }
});

test("lan policy still hard-denies cloud metadata and non-routable classes", () => {
  for (const host of [
    "169.254.169.254",
    "169.254.170.2",
    "0.0.0.0",
    "100.64.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "metadata.google.internal",
    "metadata.goog",
    "instance-data",
  ]) {
    assert.throws(() => assertHostAllowed(host, { policy: "lan" }), (error) => error.code === EGRESS_BLOCKED, `${host} must stay blocked`);
  }
});

test("lan policy resolves private DNS answers but blocks metadata answers", async () => {
  await assertEgressAllowed("https://model.internal.example/v1", {
    policy: "lan",
    dnsLookup: async () => [{ address: "10.0.0.5", family: 4 }],
  });
  await assert.rejects(
    () => assertEgressAllowed("https://model.internal.example/v1", {
      policy: "lan",
      dnsLookup: async () => [{ address: "169.254.169.254", family: 4 }],
    }),
    (error) => error.code === EGRESS_BLOCKED,
  );
});

test("lan policy does not leak into strict: default calls keep blocking private ranges", () => {
  assert.throws(() => assertHostAllowed("10.0.0.5"), (error) => error.code === EGRESS_BLOCKED);
  assert.throws(() => assertUrlAllowedSync("http://127.0.0.1:11434/v1"), (error) => error.code === EGRESS_BLOCKED);
  assert.throws(() => assertHostAllowed("localhost", {}), (error) => error.code === EGRESS_BLOCKED);
});

test("ipv4-mapped loopback follows the lan tier, not the raw ipv6 table", () => {
  assert.equal(classifyIp("::ffff:127.0.0.1", { policy: "lan" }), null);
  assert.match(classifyIp("::ffff:169.254.169.254", { policy: "lan" })?.label ?? "", /link-local/);
});
