import test from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_MATRIX_SCHEMA,
  createEvidenceItem,
  calculateEvidenceMetrics,
  createEvidenceMatrix,
  addFileEvidence,
  addWebEvidence,
  addToolEvidence,
  addArtifactEvidence,
  addDeltaEvidence,
  extractEvidenceFromMessages,
  formatEvidenceMatrixMarkdown,
  validateEvidenceMatrix,
} from "../src/evidence-matrix.mjs";

test("createEvidenceItem creates valid normalized item with hash and locator", () => {
  const item = createEvidenceItem({
    type: "file",
    locator: "src/server.mjs#L10-L30",
    snippet: "console.log('hello')",
  });

  assert.equal(item.type, "file");
  assert.equal(item.locator, "src/server.mjs#L10-L30");
  assert.ok(item.id.startsWith("ev-file-"));
  assert.equal(item.status, "verified");
  assert.ok(item.hash);
});

test("createEvidenceMatrix deduplicates duplicate locators and updates metrics", () => {
  const item1 = createEvidenceItem({
    type: "web",
    locator: "https://example.com/docs",
    title: "文档 A",
    status: "provisional",
  });
  const item2 = createEvidenceItem({
    type: "web",
    locator: "https://example.com/docs",
    title: "文档 A (已确认)",
    status: "verified",
  });
  const item3 = createEvidenceItem({
    type: "file",
    locator: "src/app.js#L1-L10",
    status: "verified",
  });

  const matrix = createEvidenceMatrix({
    runId: "run-m-1",
    items: [item1, item2, item3],
  });

  assert.equal(matrix.schema, EVIDENCE_MATRIX_SCHEMA);
  assert.equal(matrix.items.length, 2); // item1 & item2 merged
  assert.equal(matrix.metrics.totalCount, 2);
  assert.equal(matrix.metrics.verifiedCount, 2);
  assert.equal(matrix.metrics.byType.web, 1);
  assert.equal(matrix.metrics.byType.file, 1);
  assert.equal(matrix.items.find((i) => i.locator === "https://example.com/docs")?.status, "verified");
});

test("addFileEvidence and addWebEvidence append domain-specific evidence", () => {
  let matrix = createEvidenceMatrix({ runId: "run-m-2" });

  matrix = addFileEvidence(matrix, {
    relativePath: "src/file-evidence.mjs",
    startLine: 10,
    endLine: 40,
    totalLines: 150,
    sha256: "abc123sha",
    content: "function test() {}",
  });

  matrix = addWebEvidence(matrix, {
    url: "https://developer.mozilla.org/en-US/docs/Web",
    domain: "developer.mozilla.org",
    title: "MDN Web Docs",
  });

  assert.equal(matrix.metrics.totalCount, 2);
  assert.equal(matrix.metrics.byType.file, 1);
  assert.equal(matrix.metrics.byType.web, 1);

  const fileItem = matrix.items.find((i) => i.type === "file");
  assert.equal(fileItem.locator, "src/file-evidence.mjs#L10-L40");
  assert.equal(fileItem.hash, "abc123sha");
});

test("addToolEvidence, addArtifactEvidence, addDeltaEvidence integrate multiple sources", () => {
  let matrix = createEvidenceMatrix({ runId: "run-m-3" });

  matrix = addToolEvidence(matrix, {
    command: "npm test",
    exitCode: 0,
    output: "Pass: 10, Fail: 0",
  });

  matrix = addArtifactEvidence(matrix, {
    id: "art-1",
    kind: "handoff",
    name: "handoff-summary.md",
    availability: "available",
  });

  matrix = addDeltaEvidence(matrix, {
    agent: "烛",
    score: 1,
    topic: "research-a4",
    evidence: "新增检查点与证据汇总表",
  });

  assert.equal(matrix.metrics.totalCount, 3);
  assert.equal(matrix.metrics.byType.tool, 1);
  assert.equal(matrix.metrics.byType.artifact, 1);
  assert.equal(matrix.metrics.byType.delta, 1);
});

test("extractEvidenceFromMessages parses real file evidence blocks, web links and tool calls", () => {
  // 用**生产真实格式**（public/app.js 生成，经用户消息进入 attempt.prompt）。
  // 旧测试自己编了一个 ```file-excerpt 围栏——生产里没有任何产出方，
  // 于是"提取器写错格式"这件事被测试自己掩盖了很久。
  const messages = [
    {
      role: "assistant",
      text: [
        "请查看以下代码切片：",
        "--- [文件证据: src/index.js#L5-L25 (共 120 行)] ---",
        "const a = 1;",
        "--- [文件证据结束: 9f2c1ab34de5] ---",
        "参考资料：[514cc 规范](https://514claude.xyz/docs/spec)",
      ].join("\n"),
      tools: [
        { name: "git_diff", output: "diff output", status: "completed" },
      ],
    },
  ];

  const items = extractEvidenceFromMessages(messages);
  assert.equal(items.length, 3);

  const byType = Object.fromEntries(items.map((i) => [i.type, i]));
  assert.deepEqual(Object.keys(byType).sort(), ["file", "tool", "web"]);
  assert.equal(byType.file.locator, "src/index.js#L5-L25");
  assert.equal(byType.file.source, "src/index.js");
  assert.match(byType.file.snippet, /const a = 1;/);

  // 信任分级：消息文本里的证据块与模型给的链接都只是"声称"，不得算已核对。
  assert.equal(byType.file.status, "provisional");
  assert.equal(byType.file.metadata.verification, "message-marker");
  assert.equal(byType.file.metadata.lineRange, "L5-L25");
  assert.equal(byType.file.metadata.fingerprint, "9f2c1ab34de5");
  assert.equal(byType.web.status, "provisional");
  assert.equal(byType.web.metadata.verification, "model-cited");
  assert.equal(byType.tool.status, "verified");
});

test("extractEvidenceFromMessages does not count model-cited evidence as verified", () => {
  const items = extractEvidenceFromMessages([
    {
      role: "assistant",
      text: "--- [文件证据: a.js#L1-L2 (共 2 行)] ---\nconst x = 1;\n--- [文件证据结束: deadbeef] ---\n见 [文档](https://example.com/doc)",
    },
  ]);
  const matrix = createEvidenceMatrix({ items });
  assert.equal(matrix.metrics.totalCount, 2);
  assert.equal(matrix.metrics.byType.file, 1);
  assert.equal(matrix.metrics.byType.web, 1);
  assert.equal(matrix.metrics.verifiedCount, 0, "只有声称、没有服务端观测，就不能计入已核对");
});

test("formatEvidenceMatrixMarkdown renders a formatted markdown table", () => {
  const matrix = createEvidenceMatrix({
    items: [
      createEvidenceItem({
        type: "file",
        title: "测试文件",
        locator: "src/test.js#L1-L10",
        status: "verified",
      }),
    ],
  });

  const md = formatEvidenceMatrixMarkdown(matrix);
  assert.match(md, /\| 类型 \| 标题 \/ 来源 \| 定位标识 \| 状态 \|/);
  assert.match(md, /FILE/);
  assert.match(md, /测试文件/);
  assert.match(md, /已核对/);
});

test("validateEvidenceMatrix verifies envelope invariants", () => {
  const valid = createEvidenceMatrix({ runId: "run-v" });
  assert.equal(validateEvidenceMatrix(valid).ok, true);

  assert.equal(validateEvidenceMatrix(null).ok, false);
  assert.equal(validateEvidenceMatrix({}).ok, false);
  assert.equal(validateEvidenceMatrix({ ...valid, schema: "wrong" }).ok, false);
  assert.equal(validateEvidenceMatrix({ ...valid, items: null }).ok, false);
});
