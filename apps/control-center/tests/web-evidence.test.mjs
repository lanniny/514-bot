import test from "node:test";
import assert from "node:assert/strict";
import { validateSafeWebUrl, extractWebCitations } from "../src/web-evidence.mjs";

test("web-evidence unit tests", async () => {
  await test("validateSafeWebUrl allows public HTTPS urls", () => {
    const res1 = validateSafeWebUrl("https://example.com/docs/api");
    assert.equal(res1.safe, true);
    assert.equal(res1.domain, "example.com");

    const res2 = validateSafeWebUrl("https://developer.mozilla.org/en-US/docs/Web");
    assert.equal(res2.safe, true);
    assert.equal(res2.domain, "developer.mozilla.org");
  });

  await test("validateSafeWebUrl rejects non-HTTPS protocols", () => {
    assert.equal(validateSafeWebUrl("http://example.com").safe, false);
    assert.equal(validateSafeWebUrl("ftp://example.com/file").safe, false);
    assert.equal(validateSafeWebUrl("javascript:alert(1)").safe, false);
    assert.equal(validateSafeWebUrl("file:///etc/passwd").safe, false);
  });

  await test("validateSafeWebUrl rejects loopback and local hostnames", () => {
    assert.equal(validateSafeWebUrl("https://localhost/api").safe, false);
    assert.equal(validateSafeWebUrl("https://sub.localhost/api").safe, false);
    assert.equal(validateSafeWebUrl("https://my-nas.local/share").safe, false);
    assert.equal(validateSafeWebUrl("https://router.internal/config").safe, false);
  });

  await test("validateSafeWebUrl rejects private IPv4 and metadata IP", () => {
    assert.equal(validateSafeWebUrl("https://127.0.0.1:8080/secret").safe, false);
    assert.equal(validateSafeWebUrl("https://10.0.0.1/admin").safe, false);
    assert.equal(validateSafeWebUrl("https://172.16.1.1/dashboard").safe, false);
    assert.equal(validateSafeWebUrl("https://192.168.1.1/setup").safe, false);
    assert.equal(validateSafeWebUrl("https://169.254.169.254/latest/meta-data/").safe, false);
    assert.equal(validateSafeWebUrl("https://0.0.0.0/").safe, false);
  });

  await test("validateSafeWebUrl rejects private/loopback IPv6", () => {
    assert.equal(validateSafeWebUrl("https://[::1]/api").safe, false);
    assert.equal(validateSafeWebUrl("https://[fe80::1]/test").safe, false);
    assert.equal(validateSafeWebUrl("https://[fc00::1]/test").safe, false);
  });

  await test("validateSafeWebUrl rejects URLs with credentials", () => {
    assert.equal(validateSafeWebUrl("https://admin:secret@example.com/").safe, false);
  });

  await test("extractWebCitations extracts safe citations and ignores unsafe ones", () => {
    const text = `
根据官方文档 [MDN Array](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array)，
我们可以使用 map 方法。更多参考：
[来源: Node.js 官方指南](https://nodejs.org/en/docs)
以及内网测试链接 [内网](https://192.168.1.100/internal) 与 [恶意外链](http://insecure.org/plain)。
    `;

    const citations = extractWebCitations(text);
    assert.equal(citations.length, 2);
    assert.equal(citations[0].domain, "developer.mozilla.org");
    assert.equal(citations[0].title, "MDN Array");
    assert.equal(citations[1].domain, "nodejs.org");
    assert.equal(citations[1].title, "Node.js 官方指南");
    // 卡片渲染在前端（public/modules/ 与 app.js），服务端只出结构化引用。
    // 这里钉住稳定标识：同一 URL 必须得到同一个 key，供去重与对账使用。
    assert.match(citations[0].key, /^[0-9a-f]{12}$/);
    assert.notEqual(citations[0].key, citations[1].key);
  });
});
