/**
 * office.mjs — Wave G 文档工坊核心（进程内 OOXML 生成，超越 codeg 外挂 officecli）。
 *
 * 契约（v40 设计 §3.3）：
 *   - docx / xlsx / pptx 进程内生成；dryRun 默认 true（计划→确认→落盘）
 *   - 输出围栏：targetDir 必须在 allowlist 根内；fileName 禁分隔符与 ..
 *   - inspect 只读解析结构摘要；history 追加落 jsonl
 *   - 计划带 outline（章节/表/页），同名文件需 force，中文标题可进文件名
 */

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile, rename } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { isWithin } from "./paths.mjs";

const require = createRequire(import.meta.url);
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } = require("docx");
const ExcelJS = require("exceljs");
const PptxGenJS = require("pptxgenjs");

const KINDS = new Set(["docx", "xlsx", "pptx"]);
const HISTORY_CAP = 50;
const HISTORY_ROLLOVER_BYTES = 5 * 1024 * 1024;
const DOWNLOAD_CAP = 20 * 1024 * 1024;
const MIME = Object.freeze({
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
});

function officeError(code, message, httpStatus = 400) {
  return Object.assign(new Error(message), { code, httpStatus });
}

function assertSafeFileName(fileName) {
  const name = String(fileName || "").trim();
  if (!name) throw officeError("OFFICE_BAD_FILENAME", "fileName is required");
  if (/[/\\]/.test(name) || name.includes("..") || /[\u0000-\u001f]/.test(name)) {
    throw officeError("OFFICE_BAD_FILENAME", `unsafe fileName: ${name}`, 403);
  }
  return name;
}

export function slugifyOfficeName(title, kind) {
  const slug = String(title || "document")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "document"}.${kind}`;
}

export function outlineOf(kind, spec = {}, title = "") {
  if (kind === "docx") {
    return {
      title: String(spec.title || title || ""),
      sections: (spec.sections ?? []).map((section) => ({
        heading: String(section?.heading || ""),
        paragraphs: Array.isArray(section?.paragraphs) ? section.paragraphs.length : 0,
        tableRows: Array.isArray(section?.table?.rows) ? section.table.rows.length : 0,
      })),
    };
  }
  if (kind === "xlsx") {
    return {
      sheets: (spec.sheets ?? []).map((sheet) => ({
        name: String(sheet?.name || "Sheet1"),
        columns: Array.isArray(sheet?.columns) ? sheet.columns.length : 0,
        rows: Array.isArray(sheet?.rows) ? sheet.rows.length : 0,
      })),
    };
  }
  return {
    title: String(spec.title || title || ""),
    slides: (spec.slides ?? []).map((slide) => ({
      title: String(slide?.title || ""),
      bullets: Array.isArray(slide?.bullets) ? slide.bullets.length : 0,
      notes: Boolean(slide?.notes),
    })),
  };
}

export function createOfficeService({ repoRoot, dataRoot, eventStore = null } = {}) {
  const root = resolve(repoRoot);
  const allowedRoots = [join(root, "output-docs"), join(resolve(dataRoot), "office-output")];
  const historyPath = join(resolve(dataRoot), "office-history.jsonl");

  function audit(type, detail) {
    void eventStore?.emit?.(type, detail, { sensitivity: "internal", agentId: "control-plane" })?.catch?.(() => {});
  }

  function resolveTargetDir(targetDir) {
    const candidate = resolve(String(targetDir || allowedRoots[0]));
    if (!allowedRoots.some((allowed) => isWithin(allowed, candidate))) {
      throw officeError("OFFICE_PATH_BOUNDARY", `targetDir escapes allowed roots: ${candidate}`, 403);
    }
    return candidate;
  }

  function resolveReadPath(filePath) {
    const candidate = resolve(String(filePath || ""));
    if (isWithin(root, candidate) || allowedRoots.some((allowed) => isWithin(allowed, candidate))) {
      return candidate;
    }
    throw officeError("OFFICE_PATH_BOUNDARY", `path escapes allowed roots: ${candidate}`, 403);
  }

  async function buildDocx(spec = {}) {
    const children = [];
    if (spec.title) {
      children.push(new Paragraph({ text: String(spec.title), heading: HeadingLevel.TITLE }));
    }
    for (const section of spec.sections ?? []) {
      if (section?.heading) {
        children.push(new Paragraph({ text: String(section.heading), heading: HeadingLevel.HEADING_1 }));
      }
      for (const paragraph of section?.paragraphs ?? []) {
        children.push(new Paragraph({ children: [new TextRun(String(paragraph))] }));
      }
      if (Array.isArray(section?.table?.rows) && section.table.rows.length) {
        const rows = section.table.rows.map((row) => new TableRow({
          children: (Array.isArray(row) ? row : [row]).map((cell) => new TableCell({
            children: [new Paragraph({ children: [new TextRun(String(cell))] })],
            width: { size: 100 / Math.max(1, (Array.isArray(row) ? row : [row]).length), type: WidthType.PERCENTAGE },
          })),
        }));
        children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
      }
    }
    if (!children.length) children.push(new Paragraph({ children: [new TextRun("")] }));
    const document = new Document({
      creator: "514 Forge",
      title: String(spec.title || "514 document"),
      sections: [{ children }],
    });
    return Packer.toBuffer(document);
  }

  async function buildXlsx(spec = {}) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "514 Forge";
    const sheets = Array.isArray(spec.sheets) && spec.sheets.length ? spec.sheets : [{ name: "Sheet1", columns: [], rows: [] }];
    for (const sheetSpec of sheets) {
      const sheet = workbook.addWorksheet(String(sheetSpec?.name || "Sheet1").slice(0, 31));
      if (Array.isArray(sheetSpec?.columns) && sheetSpec.columns.length) {
        sheet.columns = sheetSpec.columns.map((column) => ({
          header: String(column?.header ?? column ?? ""),
          key: String(column?.key ?? column ?? "").replace(/\W+/g, "_") || "col",
          width: Number(column?.width) || 18,
        }));
      }
      for (const row of sheetSpec?.rows ?? []) {
        if (Array.isArray(row)) sheet.addRow(row);
        else if (row && typeof row === "object") sheet.addRow(row);
      }
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  async function buildPptx(spec = {}) {
    const pptx = new PptxGenJS();
    pptx.author = "514 Forge";
    if (spec.title) pptx.title = String(spec.title);
    const slides = Array.isArray(spec.slides) && spec.slides.length ? spec.slides : [{ title: spec.title || "514", bullets: [] }];
    for (const slideSpec of slides) {
      const slide = pptx.addSlide();
      if (slideSpec?.title) slide.addText(String(slideSpec.title), { x: 0.5, y: 0.4, w: "90%", fontSize: 28, bold: true, color: "363636" });
      const bullets = (slideSpec?.bullets ?? []).map((line) => ({ text: String(line), options: { bullet: true } }));
      if (bullets.length) slide.addText(bullets, { x: 0.6, y: 1.4, w: "85%", h: 4.5, fontSize: 16, color: "4a4a4a" });
      if (slideSpec?.notes) slide.addNotes(String(slideSpec.notes));
    }
    return Buffer.from(await pptx.write({ outputType: "nodebuffer" }));
  }

  const builders = { docx: buildDocx, xlsx: buildXlsx, pptx: buildPptx };

  async function generate({ kind, title, targetDir, fileName, spec = {}, dryRun = true, force = false } = {}) {
    const safeKind = String(kind || "").toLowerCase();
    if (!KINDS.has(safeKind)) throw officeError("OFFICE_BAD_KIND", `kind must be one of ${[...KINDS].join("/")}`);
    const name = assertSafeFileName(fileName || slugifyOfficeName(title, safeKind));
    const withExt = extname(name) ? name : `${name}.${safeKind}`;
    const dir = resolveTargetDir(targetDir);
    const fullPath = join(dir, withExt);
    const outline = outlineOf(safeKind, spec, title);
    const plan = {
      kind: safeKind,
      path: fullPath,
      fileName: withExt,
      targetDir: dir,
      dryRun: dryRun !== false,
      title: String(title || spec.title || ""),
      sections: safeKind === "docx" ? (spec.sections ?? []).length : undefined,
      sheets: safeKind === "xlsx" ? (spec.sheets ?? []).length : undefined,
      slides: safeKind === "pptx" ? (spec.slides ?? []).length : undefined,
      outline,
    };
    if (dryRun !== false) {
      return { ok: true, dryRun: true, plan };
    }
    const exists = await stat(fullPath).then((info) => info.isFile()).catch(() => false);
    if (exists && force !== true) {
      throw officeError("OFFICE_FILE_EXISTS", `file already exists (pass force to overwrite): ${fullPath}`, 409);
    }
    const buffer = await builders[safeKind]({ ...spec, title: title ?? spec.title });
    if (!buffer?.length) throw officeError("OFFICE_BUILD_EMPTY", "generator produced empty output", 500);
    await mkdir(dir, { recursive: true });
    // pid+uuid 临时名：固定名在同名并发生成时会互相踩写/半成品 rename（对齐全仓原子写惯例）
    const tmp = join(dir, `.${withExt}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tmp, buffer);
    await rename(tmp, fullPath);
    await appendHistory({ kind: safeKind, path: fullPath, fileName: withExt, title: plan.title, bytes: buffer.length, at: new Date().toISOString() });
    audit("office.generate", { kind: safeKind, fileName: withExt, bytes: buffer.length });
    return { ok: true, dryRun: false, plan: { ...plan, bytes: buffer.length } };
  }

  async function inspect({ path: filePath } = {}) {
    const candidate = resolveReadPath(filePath);
    const info = await stat(candidate).catch(() => null);
    if (!info?.isFile()) throw officeError("OFFICE_NOT_FOUND", `file not found: ${candidate}`, 404);
    const ext = extname(candidate).slice(1).toLowerCase();
    if (!KINDS.has(ext)) throw officeError("OFFICE_BAD_KIND", `unsupported extension: ${ext}`);
    const summary = { path: candidate, kind: ext, bytes: info.size, fileName: basename(candidate) };
    if (ext === "xlsx") {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(candidate);
      summary.sheets = workbook.worksheets.map((sheet) => ({ name: sheet.name, rows: sheet.rowCount, columns: sheet.columnCount }));
    } else if (ext === "docx") {
      const raw = await unzipEntry(candidate, "word/document.xml");
      summary.paragraphs = (raw.match(/<w:p[ >]/g) || []).length;
      summary.tables = (raw.match(/<w:tbl>/g) || []).length;
    } else {
      const raw = await listZipEntries(candidate);
      summary.slides = raw.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry)).length;
    }
    audit("office.inspect", { kind: ext, bytes: info.size });
    return { ok: true, summary };
  }

  async function readDocument(filePath) {
    const candidate = resolveReadPath(filePath);
    const info = await stat(candidate).catch(() => null);
    if (!info?.isFile()) throw officeError("OFFICE_NOT_FOUND", `file not found: ${candidate}`, 404);
    const ext = extname(candidate).slice(1).toLowerCase();
    if (!KINDS.has(ext)) throw officeError("OFFICE_BAD_KIND", `unsupported extension: ${ext}`);
    if (info.size > DOWNLOAD_CAP) throw officeError("OFFICE_TOO_LARGE", "file exceeds 20MB download cap", 413);
    const bytes = await readFile(candidate);
    return {
      path: candidate,
      fileName: basename(candidate),
      kind: ext,
      bytes,
      contentType: MIME[ext],
    };
  }

  /** 追加并按需轮转：超过 HISTORY_ROLLOVER_BYTES（约 5MB）时重写为最近 HISTORY_CAP*4 条，防无限增长。 */
  async function appendHistory(entry) {
    try {
      await appendFile(historyPath, `${JSON.stringify(entry)}\n`, "utf8");
      const info = await stat(historyPath).catch(() => null);
      if (info && info.size > HISTORY_ROLLOVER_BYTES) {
        const lines = (await readFile(historyPath, "utf8")).trim().split("\n").filter(Boolean);
        const kept = lines.slice(-(HISTORY_CAP * 4));
        // pid+uuid 临时名：固定 `.tmp` 在并发轮转/崩溃残留时会互踩（对齐全仓原子写惯例）
        const tmp = `${historyPath}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(tmp, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
        await rename(tmp, historyPath);
      }
    } catch { /* 历史记账失败不阻塞生成主流程 */ }
  }

  async function history() {
    let lines = [];
    try {
      lines = (await readFile(historyPath, "utf8")).trim().split("\n").filter(Boolean);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return lines.slice(-HISTORY_CAP).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean).reverse();
  }

  function templates() {
    return [
      {
        id: "weekly-report",
        kind: "docx",
        title: "周报模板",
        blurb: "进展、风险、下周计划，带一张指标表。",
        spec: {
          title: "本周工作报告",
          sections: [
            { heading: "本周进展", paragraphs: ["完成了…", "推进了…"] },
            { heading: "风险与阻塞", paragraphs: ["无。有的话写清谁在等什么。"] },
            { heading: "下周计划", paragraphs: ["优先做…"] },
            { heading: "关键指标", paragraphs: [], table: { rows: [["指标", "本周", "备注"], ["交付", "3", ""], ["缺陷", "0", ""]] } },
          ],
        },
      },
      {
        id: "data-sheet",
        kind: "xlsx",
        title: "数据表模板",
        blurb: "一张汇总表，列好项目和数值就能填。",
        spec: {
          sheets: [{
            name: "汇总",
            columns: [{ header: "项目" }, { header: "数值" }, { header: "备注" }],
            rows: [["示例", 42, "可改"], ["合计", 42, ""]],
          }],
        },
      },
      {
        id: "demo-deck",
        kind: "pptx",
        title: "演示模板",
        blurb: "封面、议程、收束三页，备注留给口述。",
        spec: {
          title: "演示文稿",
          slides: [
            { title: "标题页", bullets: ["一句话讲清这次要说什么"], notes: "先报结论。" },
            { title: "议程", bullets: ["背景", "方案", "下一步"], notes: "" },
            { title: "下一步", bullets: ["谁在什么时候做什么"], notes: "收束到可执行项。" },
          ],
        },
      },
    ];
  }

  return { generate, inspect, history, templates, readDocument, resolveTargetDir };
}

function officeZipError(tool, code) {
  return Object.assign(new Error(`${tool} exited with code ${code ?? "?"} — 文件可能不是合法的 Office(zip) 格式`), { code: "OFFICE_INSPECT_FAILED", httpStatus: 422 });
}

async function unzipEntry(filePath, entry) {
  const { spawn } = await import("node:child_process");
  const command = process.platform === "win32"
    ? ["powershell", ["-NoProfile", "-Command", `Add-Type -A System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('${filePath.replace(/'/g, "''")}'); $e=$z.GetEntry('${entry}'); if($e){$r=New-Object IO.StreamReader($e.Open()); $r.ReadToEnd(); $r.Close()}; $z.Dispose()`]]
    : ["unzip", ["-p", filePath, entry]];
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(command[0], command[1], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout.on("data", (chunk) => { out += chunk; });
    // 退出码非 0 必须报错：静默返回空串会让"0 段落"与空文档无法区分
    proc.on("close", (code) => {
      if (code === 0 || (process.platform === "win32" && out)) resolvePromise(out);
      else rejectPromise(officeZipError(command[0], code));
    });
    proc.on("error", rejectPromise);
  });
}

async function listZipEntries(filePath) {
  const { spawn } = await import("node:child_process");
  const command = process.platform === "win32"
    ? ["powershell", ["-NoProfile", "-Command", `Add-Type -A System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('${filePath.replace(/'/g, "''")}'); $z.Entries | ForEach-Object { $_.FullName }; $z.Dispose()`]]
    : ["unzip", ["-Z1", filePath]];
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(command[0], command[1], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout.on("data", (chunk) => { out += chunk; });
    proc.on("close", (code) => {
      if (code === 0 || (process.platform === "win32" && out)) resolvePromise(out.split(/\r?\n/).filter(Boolean));
      else rejectPromise(officeZipError(command[0], code));
    });
    proc.on("error", rejectPromise);
  });
}
