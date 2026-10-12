import { createHash } from "node:crypto";
import { scrub } from "./redaction.mjs";
import { extractWebCitations } from "./web-evidence.mjs";

export const EVIDENCE_MATRIX_SCHEMA = "514cc.evidence-matrix/v1";

export const EVIDENCE_TYPES = Object.freeze(["file", "web", "tool", "artifact", "delta"]);
export const EVIDENCE_STATUSES = Object.freeze(["verified", "provisional", "unverified", "stale"]);

function asText(value, limit = 300, fallback = "") {
  const clean = scrub(String(value ?? ""))
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!clean) return fallback;
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function normalizeIsoTimestamp(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function computeEvidenceHash(type, locator, snippet = "") {
  return createHash("sha256")
    .update(`${type}\0${locator}\0${snippet}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

export function createEvidenceItem(input = {}) {
  const type = EVIDENCE_TYPES.includes(input.type) ? input.type : "tool";
  const locator = asText(input.locator, 300, "unknown-location");
  const source = asText(input.source, 200, locator);
  const title = asText(input.title, 160, `${type.toUpperCase()} 证据: ${locator}`);
  const snippet = scrub(String(input.snippet ?? ""))
    .slice(0, 1024);
  const hash = input.hash ? asText(input.hash, 64) : computeEvidenceHash(type, locator, snippet);
  const id = input.id ? asText(input.id, 64) : `ev-${type}-${hash.slice(0, 10)}`;
  const status = EVIDENCE_STATUSES.includes(input.status) ? input.status : "verified";
  const timestamp = normalizeIsoTimestamp(input.timestamp);
  const metadata = input.metadata && typeof input.metadata === "object" ? { ...input.metadata } : {};

  return {
    id,
    type,
    title,
    source,
    locator,
    snippet,
    hash,
    status,
    timestamp,
    metadata,
  };
}

export function calculateEvidenceMetrics(items = []) {
  const byType = {
    file: 0,
    web: 0,
    tool: 0,
    artifact: 0,
    delta: 0,
  };

  let verifiedCount = 0;

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const type = item.type;
    if (Object.hasOwn(byType, type)) {
      byType[type] += 1;
    }
    if (item.status === "verified") {
      verifiedCount += 1;
    }
  }

  return {
    totalCount: items.length,
    verifiedCount,
    byType,
  };
}

export function createEvidenceMatrix({
  runId = null,
  conversationId = null,
  items = [],
  createdAt = null,
} = {}) {
  const dedupMap = new Map();
  for (const rawItem of items) {
    if (!rawItem) continue;
    const item = rawItem.id && rawItem.hash ? rawItem : createEvidenceItem(rawItem);
    const key = `${item.type}:${item.locator}`;
    if (!dedupMap.has(key)) {
      dedupMap.set(key, item);
    } else {
      // 若已有但后来的状态为 verified，更新为更权威状态
      const existing = dedupMap.get(key);
      if (existing.status !== "verified" && item.status === "verified") {
        dedupMap.set(key, item);
      }
    }
  }

  const normalizedItems = Array.from(dedupMap.values());
  const metrics = calculateEvidenceMetrics(normalizedItems);

  return {
    schema: EVIDENCE_MATRIX_SCHEMA,
    runId: runId ? asText(runId, 80) : null,
    conversationId: conversationId ? asText(conversationId, 80) : null,
    createdAt: normalizeIsoTimestamp(createdAt),
    metrics,
    items: normalizedItems,
  };
}

export function addEvidenceToMatrix(matrix, rawItem) {
  if (!matrix || typeof matrix !== "object") {
    throw new Error("matrix 必须是有效对象");
  }
  const item = rawItem?.id && rawItem?.hash ? rawItem : createEvidenceItem(rawItem);
  const existing = Array.isArray(matrix.items) ? matrix.items : [];
  return createEvidenceMatrix({
    runId: matrix.runId,
    conversationId: matrix.conversationId,
    createdAt: matrix.createdAt,
    items: [...existing, item],
  });
}

export function addFileEvidence(matrix, fileExcerpt) {
  if (!fileExcerpt) return matrix;
  const relPath = fileExcerpt.relativePath || "file";
  const start = fileExcerpt.startLine ?? 1;
  const end = fileExcerpt.endLine ?? fileExcerpt.totalLines ?? 1;
  const locator = `${relPath}#L${start}-L${end}`;
  const item = createEvidenceItem({
    type: "file",
    title: `代码文件切片: ${relPath} (L${start}-L${end})`,
    source: relPath,
    locator,
    snippet: fileExcerpt.content || "",
    hash: fileExcerpt.sha256 || computeEvidenceHash("file", locator, fileExcerpt.content || ""),
    status: "verified",
    metadata: {
      relativePath: relPath,
      startLine: start,
      endLine: end,
      totalLines: fileExcerpt.totalLines,
      sha256: fileExcerpt.sha256,
    },
  });
  return addEvidenceToMatrix(matrix, item);
}

export function addWebEvidence(matrix, webCitation) {
  if (!webCitation) return matrix;
  const url = webCitation.url || "";
  const domain = webCitation.domain || "web";
  const title = webCitation.title || domain;
  const locator = url;
  const item = createEvidenceItem({
    type: "web",
    title: `Web 来源: ${title}`,
    source: domain,
    locator,
    snippet: webCitation.snippet || webCitation.excerpt || "",
    hash: computeEvidenceHash("web", locator, title),
    status: "verified",
    metadata: {
      url,
      domain,
      title,
    },
  });
  return addEvidenceToMatrix(matrix, item);
}

export function addToolEvidence(matrix, toolOutput) {
  if (!toolOutput) return matrix;
  const command = asText(toolOutput.command || toolOutput.name || "tool", 120);
  const exitCode = toolOutput.exitCode ?? 0;
  const locator = `tool://${command}`;
  const item = createEvidenceItem({
    type: "tool",
    title: `工具调用: ${command} (exit: ${exitCode})`,
    source: command,
    locator,
    snippet: toolOutput.output || "",
    hash: computeEvidenceHash("tool", locator, toolOutput.output || ""),
    status: exitCode === 0 ? "verified" : "provisional",
    metadata: {
      command,
      exitCode,
    },
  });
  return addEvidenceToMatrix(matrix, item);
}

export function addArtifactEvidence(matrix, artifact) {
  if (!artifact) return matrix;
  const name = artifact.label || artifact.name || artifact.kind || "artifact";
  const locator = artifact.endpoint || artifact.id || name;
  const item = createEvidenceItem({
    type: "artifact",
    title: `交付产物: ${name}`,
    source: artifact.kind || "artifact",
    locator,
    snippet: artifact.verifyCommand || "",
    hash: artifact.digest || computeEvidenceHash("artifact", locator, name),
    status: artifact.availability === "available" ? "verified" : "provisional",
    metadata: {
      kind: artifact.kind,
      digest: artifact.digest,
      endpoint: artifact.endpoint,
    },
  });
  return addEvidenceToMatrix(matrix, item);
}

export function addDeltaEvidence(matrix, delta) {
  if (!delta) return matrix;
  const agent = delta.agent || "agent";
  const score = delta.score ?? 0;
  const topic = delta.topic || "delta";
  const locator = `delta://${agent}/${topic}`;
  const item = createEvidenceItem({
    type: "delta",
    title: `DELTA 核验净增量: ${agent} (score: ${score})`,
    source: `DELTA:${agent}`,
    locator,
    snippet: delta.evidence || "",
    hash: computeEvidenceHash("delta", locator, delta.evidence || ""),
    status: "verified",
    metadata: {
      agent,
      score,
      topic,
    },
  });
  return addEvidenceToMatrix(matrix, item);
}

export function extractEvidenceFromMessages(messages = []) {
  const items = [];
  // 2026-09-18：改认**真实**证据块格式。旧实现认 ```` ```file-excerpt ```` 围栏，
  // 而生产里那个围栏**没有任何产出方**（全仓只有本文件与一条测试提到它）——
  // 真实格式由 `public/app.js` 的文件证据块生成、随用户消息进入 run 的
  // attempt.prompt。也就是说旧正则永远匹配不到东西：证据矩阵的 file 类别
  // 在生产中恒为 0，而测试因为自己喂假格式，一直是绿的。
  const fileRegex = /---\s*\[文件证据:\s*([^\s\]#]+)(?:#L(\d+)-L(\d+))?[^\]]*\]\s*---\r?\n([\s\S]*?)\r?\n---\s*\[文件证据结束:\s*([0-9a-f]*)[^\]]*\]\s*---/g;

  for (const message of messages) {
    if (!message) continue;
    const text = String(message.text || message.content || "");

    // 1. 提取文件证据块
    let fileMatch;
    while ((fileMatch = fileRegex.exec(text)) !== null) {
      const [, relPath, startLine, endLine, content, fingerprint] = fileMatch;
      const lineRange = startLine && endLine ? `L${startLine}-L${endLine}` : null;
      const header = lineRange ? `${relPath}#${lineRange}` : relPath;
      items.push(createEvidenceItem({
        type: "file",
        title: `文件原文片段: ${header}`,
        source: relPath,
        locator: header,
        snippet: content.slice(0, 500),
        // 证据块以文本形态存在于消息里，**模型自己也能写出同样的块**，
        // 所以它属于"消息声称"而非服务端观测。按本仓信任分级
        // （operator-attested 不得开启工程绿灯）记为待确认，不计入 verifiedCount。
        status: "provisional",
        metadata: { header, lineRange, fingerprint: fingerprint || null, verification: "message-marker" },
      }));
    }

    // 2. 提取 Web 引用
    const webCitations = extractWebCitations(text);
    for (const citation of webCitations) {
      items.push(createEvidenceItem({
        type: "web",
        title: `Web 来源: ${citation.title}`,
        source: citation.domain,
        locator: citation.url,
        snippet: citation.title,
        // 这些链接来自模型回复文本，系统**没有抓取过**它们的内容。
        // 曾经记为 verified 直到被审出：那等于把模型的一句话说成"已核对"。
        status: "provisional",
        metadata: {
          url: citation.url,
          domain: citation.domain,
          verification: "model-cited",
        },
      }));
    }

    // 3. 提取工具调用
    if (Array.isArray(message.tools)) {
      for (const tool of message.tools) {
        if (!tool) continue;
        const name = tool.name || "tool";
        items.push(createEvidenceItem({
          type: "tool",
          title: `执行工具: ${name}`,
          source: name,
          locator: `tool://${name}`,
          snippet: String(tool.output || "").slice(0, 300),
          status: tool.status === "failed" ? "provisional" : "verified",
          metadata: { toolName: name, status: tool.status },
        }));
      }
    }
  }

  return items;
}

export function formatEvidenceMatrixMarkdown(matrix) {
  if (!matrix || !Array.isArray(matrix.items) || matrix.items.length === 0) {
    return "*(暂无可核对的证据表)*";
  }

  const lines = [
    `| 类型 | 标题 / 来源 | 定位标识 | 状态 |`,
    `|---|---|---|---|`,
  ];

  for (const item of matrix.items) {
    const typeLabel = item.type.toUpperCase();
    const title = item.title.replace(/\|/g, "\\|");
    const locator = `\`${item.locator.replace(/\|/g, "\\|")}\``;
    const statusLabel = item.status === "verified" ? "已核对" : "待确认";
    lines.push(`| ${typeLabel} | ${title} | ${locator} | ${statusLabel} |`);
  }

  return lines.join("\n");
}

export function validateEvidenceMatrix(matrix) {
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) {
    return { ok: false, reason: "证据矩阵必须是有效对象" };
  }
  if (matrix.schema !== EVIDENCE_MATRIX_SCHEMA) {
    return { ok: false, reason: "证据矩阵 schema 不匹配" };
  }
  if (!Array.isArray(matrix.items)) {
    return { ok: false, reason: "缺少 items 数组" };
  }
  if (!matrix.metrics || typeof matrix.metrics !== "object") {
    return { ok: false, reason: "缺少 metrics 统计对象" };
  }
  return { ok: true, data: matrix };
}
