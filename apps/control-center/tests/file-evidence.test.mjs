import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseProjectFileExcerpt, formatFileEvidenceBlock, isSensitivePath, isBinaryBuffer } from "../src/file-evidence.mjs";

test("file-evidence unit tests", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "file-evidence-test-"));

  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await test("isSensitivePath detects protected files and directories", () => {
    assert.equal(isSensitivePath(".env"), true);
    assert.equal(isSensitivePath(".env.local"), true);
    assert.equal(isSensitivePath("sub/.env.production"), true);
    assert.equal(isSensitivePath("certs/server.pem"), true);
    assert.equal(isSensitivePath("certs/key.key"), true);
    assert.equal(isSensitivePath("keys/id_rsa"), true);
    assert.equal(isSensitivePath(".git/config"), true);
    assert.equal(isSensitivePath("src/.ssh/known_hosts"), true);
    assert.equal(isSensitivePath("src/components/button.js"), false);
    assert.equal(isSensitivePath("README.md"), false);
  });

  // 2026-09-18 P0 回归：本仓真实密钥集中地的文件名不含 token/secret/credential
  // 任何一个词，旧判据整份放行，可经 parse-file 出境。
  await test("isSensitivePath covers credential-store filename shapes", () => {
    assert.equal(isSensitivePath(".ai-shared/control-center/providers.json"), true);
    assert.equal(isSensitivePath("config/providers.yaml"), true);
    assert.equal(isSensitivePath("credentials.json"), true);
    assert.equal(isSensitivePath("secrets.toml"), true);
    assert.equal(isSensitivePath("config/ccswitch-proxy.json"), true);
    assert.equal(isSensitivePath(".npmrc"), true);
    assert.equal(isSensitivePath(".netrc"), true);
    assert.equal(isSensitivePath("src/providers.mjs"), false);
  });

  await test("isBinaryBuffer detects null bytes", () => {
    assert.equal(isBinaryBuffer(Buffer.from("Hello world\nThis is plain text")), false);
    assert.equal(isBinaryBuffer(Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f])), true);
  });

  await test("parseProjectFileExcerpt reads and indexes lines correctly", async () => {
    const filePath = join(tempDir, "sample.txt");
    const fileContent = [
      "Line 1: Alpha",
      "Line 2: Beta",
      "Line 3: Gamma",
      "Line 4: Delta",
      "Line 5: Epsilon",
    ].join("\n");
    await writeFile(filePath, fileContent, "utf8");

    const excerpt = await parseProjectFileExcerpt(tempDir, "sample.txt", {
      startLine: 2,
      endLine: 4,
    });

    assert.equal(excerpt.relativePath, "sample.txt");
    assert.equal(excerpt.startLine, 2);
    assert.equal(excerpt.endLine, 4);
    assert.equal(excerpt.totalLines, 5);
    assert.equal(excerpt.lineCount, 3);
    assert.equal(excerpt.truncated, false);
    assert.equal(excerpt.content, "Line 2: Beta\nLine 3: Gamma\nLine 4: Delta");
    assert.ok(typeof excerpt.sha256 === "string" && excerpt.sha256.length === 64);

    const formatted = formatFileEvidenceBlock(excerpt);
    assert.ok(formatted.includes("--- [文件证据: sample.txt#L2-L4 (共 5 行)] ---"));
    assert.ok(formatted.includes("Line 2: Beta"));
    assert.ok(formatted.includes("--- [文件证据结束:"));
  });

  await test("parseProjectFileExcerpt blocks path traversal", async () => {
    await assert.rejects(
      async () => {
        await parseProjectFileExcerpt(tempDir, "../../etc/passwd");
      },
      (err) => err.code === "PATH_TRAVERSAL_BLOCKED",
    );
  });

  await test("parseProjectFileExcerpt blocks sensitive paths", async () => {
    await assert.rejects(
      async () => {
        await parseProjectFileExcerpt(tempDir, ".env");
      },
      (err) => err.code === "FILE_ACCESS_FORBIDDEN",
    );
  });

  // 2026-09-18 P0 回归：真正的安全边界在内容层。文件名可以被随便取，
  // 但请求第 1 行不能成为读出第 500 行密钥的通道——所以扫描必须覆盖整份文件。
  await test("parseProjectFileExcerpt blocks secret material anywhere in the file", async () => {
    await writeFile(
      join(tempDir, "innocent-notes.txt"),
      "line one\nconst k = \"sk-proj-AbCdEfGhIjKlMnOpQrStUvWx\";\nline three\n",
      "utf8",
    );
    await assert.rejects(
      async () => {
        await parseProjectFileExcerpt(tempDir, "innocent-notes.txt", { startLine: 1, endLine: 1 });
      },
      (err) => err.code === "FILE_ACCESS_FORBIDDEN",
    );

    await writeFile(
      join(tempDir, "handbook.md"),
      "文档正文\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----\n", // gitleaks:allow 测试夹具：假 PEM（MIIEow== 为显式假值），用于验证含密钥文件被 FILE_ACCESS_FORBIDDEN 拒绝
      "utf8",
    );
    await assert.rejects(
      async () => {
        await parseProjectFileExcerpt(tempDir, "handbook.md");
      },
      (err) => err.code === "FILE_ACCESS_FORBIDDEN",
    );
  });

  await test("parseProjectFileExcerpt blocks literal secrets in config-shaped files", async () => {
    await writeFile(
      join(tempDir, "settings.json"),
      `${JSON.stringify({ endpoint: "https://api.example.com", password: "realLiteralPassword123" }, null, 2)}\n`,
      "utf8",
    );
    await assert.rejects(
      async () => {
        await parseProjectFileExcerpt(tempDir, "settings.json");
      },
      (err) => err.code === "FILE_ACCESS_FORBIDDEN",
    );
  });

  // 反向断言：安全写法必须放行。会拦掉官方推荐写法的闸门最终会被关掉，
  // 所以"能拦住密钥"只算一半，另一半是"不拦正常代码"。
  await test("parseProjectFileExcerpt still reads ordinary source and config", async () => {
    await writeFile(
      join(tempDir, "service.mjs"),
      "import x from \"y\";\nconst url = \"https://example.com/a?b=1\";\nconst token = \"${process.env.TOKEN}\";\nexport const c = { apiKey: process.env.OPENAI_API_KEY };\n",
      "utf8",
    );
    const code = await parseProjectFileExcerpt(tempDir, "service.mjs");
    assert.ok(code.content.includes("process.env.OPENAI_API_KEY"));
    assert.ok(code.content.includes("https://example.com/a?b=1"));

    await writeFile(join(tempDir, "plain.json"), `${JSON.stringify({ name: "demo", port: 51400 }, null, 2)}\n`, "utf8");
    const config = await parseProjectFileExcerpt(tempDir, "plain.json");
    assert.ok(config.content.includes("\"demo\""));
  });

  await test("parseProjectFileExcerpt rejects binary files", async () => {
    const binPath = join(tempDir, "data.bin");
    await writeFile(binPath, Buffer.from([0x01, 0x02, 0x00, 0x04, 0x05]));

    await assert.rejects(
      async () => {
        await parseProjectFileExcerpt(tempDir, "data.bin");
      },
      (err) => err.code === "BINARY_FILE_UNSUPPORTED",
    );
  });

  await test("parseProjectFileExcerpt handles truncation when maxBytes exceeded", async () => {
    const filePath = join(tempDir, "long.txt");
    const content = "A".repeat(100);
    await writeFile(filePath, content, "utf8");

    const excerpt = await parseProjectFileExcerpt(tempDir, "long.txt", {
      maxBytes: 30,
    });

    assert.equal(excerpt.truncated, true);
    assert.equal(excerpt.byteLength, 30);
  });
});
