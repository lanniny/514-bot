/**
 * W3.11 自定义快捷命令宏：dataRoot/macros.json，用户自定义 /token 宏展开为
 * 普通提示词轮（不伪装成 CLI 原生命令——native-commands 的 CLI 通道仍 fail-closed）。
 *
 * 宏形态：{ token: "/daily", promptTemplate: "做一次体检：$args", createdAt }
 * 展开：$args = token 后整段参数串；$1..$9 = 按空白切分的第 n 段。
 * 命中优先级：adapter 原生命令 > 宏（CLI 内建语义不被用户宏遮蔽）。
 */

import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const MACROS_FILE = "macros.json";
const MACRO_LIMIT = 64;
const TOKEN_PATTERN = /^\/[A-Za-z][A-Za-z0-9_-]{1,23}$/;

export function isValidMacroToken(token) {
  return TOKEN_PATTERN.test(String(token ?? "").trim());
}

export function expandMacroTemplate(template, argsString = "") {
  const raw = String(argsString ?? "").trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  return String(template ?? "")
    .replace(/\$args/g, raw)
    .replace(/\$(\d)/g, (_, index) => parts[Number(index) - 1] ?? "");
}

export function createMacroStore({ dataRoot, nowFn = Date.now } = {}) {
  if (!dataRoot) throw new TypeError("macro store needs dataRoot");
  const macrosPath = join(dataRoot, MACROS_FILE);
  let cache = null; // { macros: [] }；null = 未加载

  async function load() {
    if (cache) return cache;
    try {
      const raw = await readFile(macrosPath, "utf8");
      const parsed = JSON.parse(raw);
      cache = Array.isArray(parsed?.macros) ? { macros: parsed.macros } : { macros: [] };
    } catch {
      cache = { macros: [] };
    }
    return cache;
  }

  async function persist(model) {
    await mkdir(dirname(macrosPath), { recursive: true });
    const tempPath = `${macrosPath}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tempPath, JSON.stringify(model, null, 2), "utf8");
    await rename(tempPath, macrosPath);
  }

  function normalizeEntry(entry) {
    const token = String(entry?.token ?? "").trim();
    const promptTemplate = String(entry?.promptTemplate ?? "").trim();
    if (!isValidMacroToken(token)) {
      throw Object.assign(new Error("macro token must look like /name (2-24 chars)"), { code: "VALIDATION_FAILED" });
    }
    if (!promptTemplate) {
      throw Object.assign(new Error("macro promptTemplate is required"), { code: "VALIDATION_FAILED" });
    }
    if (promptTemplate.length > 32 * 1024) {
      throw Object.assign(new Error("macro promptTemplate exceeds 32 KiB"), { code: "VALIDATION_FAILED" });
    }
    return { token, promptTemplate, createdAt: entry?.createdAt ?? new Date(nowFn()).toISOString() };
  }

  async function list() {
    return (await load()).macros.map((entry) => ({ ...entry }));
  }

  /** 命中即展开；未命中返回 null（调用方继续走原 fail-closed 路径）。 */
  async function expand(prompt) {
    const model = await load();
    const text = String(prompt ?? "").trim();
    const match = /^\/[A-Za-z][A-Za-z0-9_-]{1,23}(?:\s+([\s\S]*))?$/.exec(text);
    if (!match) return null;
    const token = text.split(/\s+/)[0];
    const entry = model.macros.find((item) => item.token.toLowerCase() === token.toLowerCase());
    if (!entry) return null;
    return expandMacroTemplate(entry.promptTemplate, match[1] ?? "");
  }

  async function create(input = {}) {
    const model = await load();
    const entry = normalizeEntry(input);
    if (model.macros.length >= MACRO_LIMIT) {
      throw Object.assign(new Error(`macro limit (${MACRO_LIMIT}) reached`), { code: "MACRO_LIMIT_REACHED" });
    }
    if (model.macros.some((item) => item.token.toLowerCase() === entry.token.toLowerCase())) {
      throw Object.assign(new Error(`macro ${entry.token} already exists`), { code: "MACRO_CONFLICT" });
    }
    model.macros.push(entry);
    await persist(model);
    return entry;
  }

  async function remove(token) {
    const model = await load();
    const clean = String(token ?? "").trim();
    const index = model.macros.findIndex((item) => item.token.toLowerCase() === clean.toLowerCase());
    if (index < 0) {
      throw Object.assign(new Error(`macro ${clean} not found`), { code: "MACRO_NOT_FOUND" });
    }
    const [removed] = model.macros.splice(index, 1);
    await persist(model);
    return removed;
  }

  return Object.freeze({ list, expand, create, remove });
}
