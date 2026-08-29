// 514cc v4.0 Forge：记忆浏览器后端（GET /api/memory + /api/memory/search）——
// handoff 目录 / .ai-shared 顶层文档 / 仓库内 MEMORY.md 三类根的统一只读视图。
// 全部路径由 repoRoot/aiSharedRoot 派生（MEMORY 发现不跟随 symlink 目录），天然限根在仓库内；
// 任何源缺失都如实降级为空根，不报错不伪造。
import { readFile, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { findMemoryFiles, listMarkdownFiles } from "./search.mjs";

const MAX_SEARCH_FILES = 400;
const MAX_FILE_BYTES = 512 * 1024;
const SNIPPET_RADIUS = 60;
const HARD_CAP = 50;

function collapse(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function snippetAround(body, needle) {
  const text = collapse(body);
  if (!text) return "";
  const index = text.toLowerCase().indexOf(needle);
  if (index < 0) return text.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + needle.length + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export class MemoryService {
  constructor({ repoRoot, aiSharedRoot }) {
    this.repoRoot = repoRoot;
    this.aiSharedRoot = aiSharedRoot;
  }

  #rel(path) {
    return path.slice(this.repoRoot.length + 1).split(sep).join("/");
  }

  /** 三类根的统一枚举（含绝对路径，仅供服务端内部读文件用；roots()/read() 共享同一清单）。 */
  async #enumerate() {
    const roots = [];
    // 根 1：handoff 交接目录
    const handoffDir = join(this.aiSharedRoot, "handoff");
    const handoffFiles = await listMarkdownFiles(handoffDir);
    if (handoffFiles.length) {
      roots.push({
        name: "handoff",
        path: this.#rel(handoffDir),
        files: handoffFiles.map((file) => ({
          name: file.name,
          size: file.size,
          mtime: new Date(file.mtimeMs).toISOString(),
          abs: file.path,
        })),
      });
    }
    // 根 2：.ai-shared 顶层 markdown（context.md / decisions.md / 其他治理文档）
    const sharedDir = this.aiSharedRoot;
    const sharedFiles = await listMarkdownFiles(sharedDir);
    if (sharedFiles.length) {
      roots.push({
        name: "ai-shared",
        path: this.#rel(sharedDir),
        files: sharedFiles.map((file) => ({
          name: file.name,
          size: file.size,
          mtime: new Date(file.mtimeMs).toISOString(),
          abs: file.path,
        })),
      });
    }
    // 根 3+：仓库内 MEMORY.md（每个文件一个根，挂在所在目录名下）
    for (const path of await findMemoryFiles(this.repoRoot)) {
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        roots.push({
          name: `memory:${basename(path)} (${this.#rel(join(path, ".."))})`,
          path: this.#rel(join(path, "..")),
          files: [{ name: basename(path), size: info.size, mtime: new Date(info.mtimeMs).toISOString(), abs: path }],
        });
      } catch {
        // 扫描期间消失的文件直接跳过
      }
    }
    return roots;
  }

  async roots() {
    const roots = await this.#enumerate();
    // 绝对路径不出服务端：对外清单只保留 rel 元数据
    return { roots: roots.map(({ files, ...rest }) => ({ ...rest, files: files.map(({ abs, ...file }) => file) })) };
  }

  /**
   * 只读文件内容：root+name 或 rel path 必须命中 #enumerate() 清单（前端只能点服务端
   * 列出的文件，不接受任意路径——免路径穿越面）。超过 MAX_FILE_BYTES 拒读并如实回报。
   */
  async read({ root: rootName = "", name: fileName = "", path: relPath = "" } = {}) {
    const roots = await this.#enumerate();
    let file = null;
    let foundRoot = null;
    if (relPath) {
      const wanted = String(relPath).replaceAll("\\", "/").replace(/^\.\//, "");
      for (const root of roots) {
        // 根目录（rel "."）拼出来会是 "./x.md"，归一到 "x.md" 再比
        const hit = root.files.find((entry) => [root.path, entry.name].filter((part) => part && part !== ".").join("/") === wanted);
        if (hit) {
          file = hit;
          foundRoot = root;
          break;
        }
      }
    } else {
      const root = roots.find((entry) => entry.name === String(rootName));
      file = root?.files.find((entry) => entry.name === String(fileName)) ?? null;
      foundRoot = root ?? null;
    }
    if (!file || !foundRoot) {
      throw Object.assign(new Error(`memory file not found: ${relPath || `${rootName}/${fileName}`}`), { code: "MEMORY_FILE_NOT_FOUND", httpStatus: 404 });
    }
    if (file.size > MAX_FILE_BYTES) {
      throw Object.assign(new Error(`file exceeds ${Math.round(MAX_FILE_BYTES / 1024)} KB read cap`), { code: "MEMORY_FILE_TOO_LARGE", httpStatus: 413 });
    }
    const content = await readFile(file.abs, "utf8");
    return {
      root: foundRoot.name,
      name: file.name,
      path: [foundRoot.path, file.name].filter((part) => part && part !== ".").join("/"),
      size: file.size,
      mtime: file.mtime,
      truncated: false,
      content,
    };
  }

  async search({ query = "" } = {}) {
    const needle = String(query ?? "").trim().toLowerCase();
    if (!needle) return { results: [] };
    const candidates = [];
    for (const file of await listMarkdownFiles(join(this.aiSharedRoot, "handoff"), { cap: MAX_SEARCH_FILES })) {
      candidates.push(file);
    }
    for (const file of await listMarkdownFiles(this.aiSharedRoot, { cap: 50 })) {
      candidates.push(file);
    }
    for (const path of await findMemoryFiles(this.repoRoot)) {
      try {
        const info = await stat(path);
        if (info.isFile()) candidates.push({ name: basename(path), path, mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        // 同上：消失即跳过
      }
    }
    const results = [];
    for (const file of candidates.slice(0, MAX_SEARCH_FILES)) {
      if (file.size > MAX_FILE_BYTES) continue;
      let text;
      try {
        text = await readFile(file.path, "utf8");
      } catch {
        continue;
      }
      const name = file.name.toLowerCase();
      const body = text.toLowerCase();
      let score = 0;
      if (name.includes(needle)) score += 100;
      if (body.includes(needle)) score += 40;
      if (!score) continue;
      const ageDays = (Date.now() - file.mtimeMs) / 86_400_000;
      score += Math.max(0, Math.round((10 - ageDays) * 10) / 10);
      results.push({
        path: this.#rel(file.path),
        name: file.name,
        snippet: snippetAround(text, needle),
        score,
      });
    }
    results.sort((a, b) => b.score - a.score);
    return { results: results.slice(0, HARD_CAP) };
  }
}
