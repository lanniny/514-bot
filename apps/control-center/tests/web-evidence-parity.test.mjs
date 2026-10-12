/**
 * web-evidence-parity.test.mjs — 来源卡片 URL 判据的**跨层一致性门禁**。
 *
 * 为什么单独一道门禁：这条判据在服务端（`src/web-evidence.mjs`）与前端
 * （`public/modules/web-evidence-url.js`）各有一份实现——没有构建步骤可以把它们
 * 合成一份。2026-09-18 审查实测两份已经漂移：前端漏拦 169.254.169.254 / 0.0.0.0
 * / ::1 / fe80: / fc00: / .home.arpa，又多拦了全部 172.*（连公网 172.15 / 172.32
 * 一起拦）。同一个 URL 在两处得到不同结论，用户看到的卡片取决于哪一层先跑。
 *
 * 本测试用同一组 fixture 双向比对：任一侧改了规则而另一侧没跟上，必红。
 * 注意它只钉「URL 合不合规」——卡片标题等展示细节不在契约内。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { validateSafeWebUrl } from "../src/web-evidence.mjs";
import { validateClientWebUrl } from "../public/modules/web-evidence-url.js";

const FIXTURES = [
  // 公网 https：两处都必须放行
  "https://example.com/docs/api",
  "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
  "https://172.15.1.1/public",   // 172.15 属公网（旧前端实现误拦）
  "https://172.32.0.1/public",   // 172.32 属公网（旧前端实现误拦）
  "https://8.8.8.8/dns",
  // 协议与凭据
  "http://example.com",
  "ftp://example.com/file",
  "javascript:alert(1)",
  "file:///etc/passwd",
  "https://admin:secret@example.com/",
  // 本机/保留域名
  "https://localhost/api",
  "https://sub.localhost/api",
  "https://my-nas.local/share",
  "https://router.internal/config",
  "https://printer.home.arpa/status",  // 旧前端实现漏拦
  // 私网与元数据 IPv4
  "https://127.0.0.1:8080/secret",
  "https://10.0.0.1/admin",
  "https://172.16.1.1/dashboard",
  "https://172.31.255.254/last",
  "https://192.168.1.1/setup",
  "https://169.254.169.254/latest/meta-data/",
  "https://0.0.0.0/",
  // 私网与回环 IPv6
  "https://[::1]/api",
  "https://[fe80::1]/test",
  "https://[fc00::1]/test",
  "https://[fd12:3456::1]/test",
  // 非 URL
  "",
  "not a url",
];

test("前端与服务端的 URL 判据必须逐条一致", () => {
  const disagreements = [];
  for (const url of FIXTURES) {
    const server = validateSafeWebUrl(url);
    const client = validateClientWebUrl(url);
    if (server.safe !== client.safe) {
      disagreements.push(`${url || "(空)"} → 服务端 safe=${server.safe} / 前端 safe=${client.safe}`);
      continue;
    }
    if (server.safe && (server.url !== client.url || server.domain !== client.domain)) {
      disagreements.push(`${url} → 归一化不一致：服务端 ${server.url} / 前端 ${client.url}`);
    }
  }
  assert.deepEqual(
    disagreements,
    [],
    `URL 判据已漂移，两侧必须同规则：\n  ${disagreements.join("\n  ")}`,
  );
});

test("旧前端实现的三个已知盲区已被钉死", () => {
  // 逐一断言"现状"，否则某个 fixture 被删掉时上面的比对会静默失去覆盖
  for (const url of ["https://169.254.169.254/latest/", "https://0.0.0.0/", "https://[::1]/api", "https://printer.home.arpa/"]) {
    assert.equal(validateClientWebUrl(url).safe, false, `${url} 必须被前端拒绝`);
  }
  // 公网 172 段不得被误拦
  for (const url of ["https://172.15.1.1/", "https://172.32.0.1/"]) {
    assert.equal(validateClientWebUrl(url).safe, true, `${url} 是公网地址，不得误拦`);
  }
});
