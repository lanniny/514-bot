import assert from "node:assert/strict";
import test from "node:test";

import {
  failurePresentation,
  providerFailurePresentation,
} from "../public/modules/failure-presentation.js";

const CLOUDFLARE_524 = `API Error: 524 {"type":"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/","title":"Error 524: A timeout occurred","status":524,"detail":"The origin web server did not return a complete response within the 120-second Proxy Read Timeout window.","error_code":524,"error_name":"origin_response_timeout","retry_after":120,"now_action_required":true} (514claude.xyz)`;

test("Cloudflare 524 becomes a bounded user summary with the original detail retained", () => {
  const result = providerFailurePresentation(CLOUDFLARE_524);
  assert.deepEqual(result, {
    kind: "origin-timeout",
    status: 524,
    title: "上游响应超时",
    // D-2026-09-28-022：措辞改为直说"提交状态仍不明确"。524 的真实语义是代理建了连
    // 但没拿到完整响应——服务端这一轮收没收到、commit 没 commit，调用方无从确认。
    // 原措辞"当前原生轮已结束，可稍后显式重试"暗示了"没送达"，盲信它会诱导重复提交。
    summary: "服务已建立连接，但未在代理等待窗口内返回完整响应。提交状态仍不明确——请查看当前运行状态后再决定是否继续。",
    detail: CLOUDFLARE_524,
  });
  assert.ok(!result.summary.includes("developers.cloudflare.com"));
  // 诚实性不变式：超时类摘要必须显式承认状态未确认，不能给出"已结束/可放心重试"的暗示
  assert.match(result.summary, /提交状态仍不明确/);
  assert.doesNotMatch(result.summary, /可稍后显式重试/);
});

test("API errors with trailing provider text still use the structured JSON payload", () => {
  const result = providerFailurePresentation('API Error: 503 {"status":503,"title":"unavailable"} (provider.example)');
  assert.equal(result.kind, "provider-error");
  assert.equal(result.status, 503);
  assert.match(result.summary, /HTTP 503/);
});

test("ordinary assistant content is not mislabeled as a provider failure", () => {
  assert.equal(providerFailurePresentation("已完成 API Error 文案审查。"), null);
  assert.equal(providerFailurePresentation("状态码 524 是一个示例。"), null);
  assert.equal(providerFailurePresentation('接口文档示例：{"status":503,"error_code":503}'), null);
  assert.equal(providerFailurePresentation('```json\n{"error":{"status":500}}\n```'), null);
});

test("durable recovery note is localized without discarding the technical source", () => {
  const raw = "Recovery acknowledgement could not drain durable work (CLAUDE_FAILED). Inspect the claimed work before acknowledging another continuation.";
  const result = failurePresentation(raw);
  assert.equal(result.kind, "recovery-blocked");
  assert.match(result.summary, /阻止自动重放/);
  assert.equal(result.detail, raw);
});

test("generic long errors stay bounded and short errors remain direct", () => {
  const long = "x".repeat(450);
  const longResult = failurePresentation(long, { summaryLimit: 100 });
  assert.equal(longResult.summary.length, 101);
  assert.equal(longResult.detail, long);

  const shortResult = failurePresentation("provider failed");
  assert.equal(shortResult.summary, "provider failed");
  assert.equal(shortResult.detail, null);
});
