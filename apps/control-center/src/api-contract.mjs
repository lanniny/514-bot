/**
 * API 契约提取器（v49 · 2026-09-04）——路由真相与前端调用面的**共享抽取口径**。
 *
 * ── 为什么要它 ──
 * 后端 `server.mjs` 是 123 条手写 if-链路由（`request.method === X && pathname === Y`），
 * 前端 `public/api.js` 是 92 条手写常量表。**两张表之间零机械关联**：
 *   · 前端调一个后端不存在的端点 → 运行时静默 404，往往被 toast 吞成"操作失败"
 *   · 后端加一条端点前端不知道 → 死能力，一直躺着没人用
 * 2026-09-04 首次对账实测出 **8 条零 UI 入口的后端能力**，其中 A/B 影子对照
 * （createShadowPair + 对比矩阵 + Markdown 报告）从头到尾写完却没有任何入口。
 *
 * ── 为什么不做 dsh 式 `initialize` 运行时握手 ──
 * DeepSeek Harness / Codex app-server 的能力协商解决的是**跨进程、跨版本**问题
 * （客户端与服务端可能是不同版本、不同机器）。514cc Console 前后端**同仓同版本部署**，
 * 运行时协商在这里是多余抽象——真正的问题是**开发期两张表会漂移**。
 * 所以做成构建期契约：抽取 → 对账 → 测试断言。比握手更早发现（提交前 vs 运行时）。
 *
 * ── 抽取口径（有意保守）──
 * 只抽**字面量**路由声明。动态拼接的路径抽不到，会表现为"前端调用无对应后端"，
 * 由 `KNOWN_DYNAMIC` 白名单显式登记——登记是有成本的动作，比默默放过好。
 *
 * 纯 Node ESM，供 `scripts/api-contract-audit.mjs`（人读报告）与
 * `tests/api-contract.test.mjs`（机械门禁）共用。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 路径参数归一化：`/api/runs/abc123` 与 `/api/runs/:id` 可比。 */
export function normalizePath(path) {
  return String(path ?? "")
    .replace(/\$\{[^}]*\}/g, ":p")       // 前端模板插值
    .replace(/:[A-Za-z_]\w*/g, ":p")      // 后端命名参数
    .replace(/\/+$/, "")
    || "/";
}

/**
 * test-only 门控变量名。`CONTROL_CENTER_TEST_MODE` 是主门控，但部分路由用派生的
 * 布尔变量（如 `testBusTailGateEnabled = process.env.CONTROL_CENTER_TEST_MODE === "1" && ...`）。
 * 只认主门控会把这类路由误判成生产死能力 —— 2026-09-04 实测踩到。
 */
const TEST_GATE_TOKENS = ["CONTROL_CENTER_TEST_MODE", "testBusTailGateEnabled"];

function isTestGated(line) {
  return TEST_GATE_TOKENS.some((token) => line.includes(token));
}

/**
 * 从 server.mjs 抽后端路由真相。
 * 返回 { exact: Map<path, {methods:Set, testOnly:boolean}>, prefixes: [{prefix, methods}] }
 */
export function extractBackendRoutes(serverPath) {
  const text = readFileSync(serverPath, "utf8");
  const exact = new Map();
  const prefixes = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const methods = [...line.matchAll(/method === "([A-Z]+)"/g)].map((m) => m[1]);
    const testOnly = isTestGated(line);
    for (const match of line.matchAll(/pathname === "(\/api\/[^"]*)"/g)) {
      const key = normalizePath(match[1]);
      if (!exact.has(key)) exact.set(key, { methods: new Set(), testOnly });
      const entry = exact.get(key);
      for (const method of methods.length ? methods : ["*"]) entry.methods.add(method);
      // 同一路径多行声明时，只要有一行不是 test-only，整体就不是
      if (!testOnly) entry.testOnly = false;
    }
    for (const match of line.matchAll(/pathname\.startsWith\("(\/api\/[^"]*)"\)/g)) {
      prefixes.push({ prefix: normalizePath(match[1]), methods: new Set(methods.length ? methods : ["*"]) });
    }
  }
  return { exact, prefixes };
}

function collectJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

/**
 * 从 public/ 抽前端调用面。
 *
 * 两种形态都抓：
 *   ① 字面量           `request("/api/runs")`
 *   ② API 常量 + 拼接   `` request(`${API.runs}/compare?a=...`) ``
 * 形态②在 2026-09-04 首版抽取器里是盲区 —— A/B 影子对照面板确实调了
 * `/api/runs/compare`，却被报成"后端有、前端不调"的死能力。误报会让
 * 死能力名单失去可信度（狼来了），所以必须抽到。
 *
 * 返回 Map<normalizedPath, Set<"file:line">>
 */
export function extractFrontendCalls(publicDir, { repoRoot = publicDir } = {}) {
  const calls = new Map();
  const apiConstants = readApiConstants(join(publicDir, "api.js"));
  for (const file of collectJsFiles(publicDir)) {
    const rel = file.replace(repoRoot, "").replace(/^[\\/]/, "").replace(/\\/g, "/");
    readFileSync(file, "utf8").split("\n").forEach((raw, index) => {
      const line = raw.replace(/\r$/, "");
      const site = `${rel}:${index + 1}`;
      const record = (path) => {
        const key = normalizePath(path);
        if (!calls.has(key)) calls.set(key, new Set());
        calls.get(key).add(site);
      };
      // ① 字面量
      for (const match of line.matchAll(/["'`](\/api\/[^"'`?#]*)/g)) record(match[1]);
      // ② `${API.xxx}/suffix` —— 把常量替换成它的值再归一化
      for (const match of line.matchAll(/\$\{API\.([a-zA-Z]+)\}([^"'`?#]*)/g)) {
        const base = apiConstants.get(match[1]);
        if (base) record(`${base}${match[2]}`);
      }
    });
  }
  return calls;
}

/** 读 api.js 的端点常量表（仅字符串字面量项；函数式常量由模板形态②的后缀覆盖）。 */
function readApiConstants(apiPath) {
  const map = new Map();
  let text = "";
  try {
    text = readFileSync(apiPath, "utf8");
  } catch {
    return map;   // api.js 缺失时退化为只抓字面量，不抛
  }
  for (const match of text.matchAll(/^\s+([a-zA-Z]+):\s*"(\/api\/[^"]*)"/gm)) {
    map.set(match[1], match[2]);
  }
  return map;
}

/** 前端路径是否被某条后端路由覆盖。返回命中方式或 null。 */
export function matchBackend(callPath, backend) {
  if (backend.exact.has(callPath)) return "exact";
  for (const { prefix } of backend.prefixes) {
    if (callPath === prefix || callPath.startsWith(`${prefix}/`)) return "prefix";
  }
  // 前端写了具体值、后端声明为参数段的情况
  const lastAsParam = callPath.replace(/\/[^/:]+$/, "/:p");
  if (backend.exact.has(lastAsParam)) return "param";
  const midAsParam = callPath.replace(/\/[^/:]+\/([^/]+)$/, "/:p/$1");
  if (backend.exact.has(midAsParam)) return "param";
  return null;
}

/**
 * 已知的"后端有、前端不调"端点白名单。
 *
 * 登记一条 = 明确承认"这个能力当前没有 UI 入口"，并写清原因。
 * **这份名单只应变短，不应变长**——它是死能力的账本，不是豁免券。
 * 加新端点却不接 UI 时，测试会逼你要么接 UI、要么在这里写下理由。
 */
export const KNOWN_UI_LESS = Object.freeze({
  "/api/budget/monthly": "月度预算读写：Console 当前只做单轮预算闸，月度视图未排期",
  "/api/capabilities/skills": "创建 skill：能力面板只做读与开关，创建仍走文件系统",
  "/api/observability/pulse": "轻量心跳：供外部探针轮询，非 UI 消费（tests/ 有覆盖）",
  "/api/roster": "运行时花名册原始快照：memberCatalog 已在 bootstrap 里给了 UI 版本",
  "/api/security/remote-gates/open": "远程闸打开：UI 走 grant/revoke 两个显式动作，open 供脚本用",
  "/api/security/sweep": "密钥巡检触发/读取：当前由 pre-commit 与 mirror-gate 消费，UI 未排期",
});

/**
 * 完整对账。
 * @returns {{
 *   orphans: Array<{path:string, sites:string[]}>,   前端调、后端无 —— 运行时必 404
 *   dead: Array<{path:string, methods:string[]}>,    后端有、前端不调且未登记
 *   staleWhitelist: string[],                        白名单里已经有 UI 的（该删掉）
 *   counts: object
 * }}
 */
export function auditApiContract({ serverPath, publicDir, repoRoot }) {
  const backend = extractBackendRoutes(serverPath);
  const calls = extractFrontendCalls(publicDir, { repoRoot });

  const orphans = [];
  for (const [path, sites] of calls) {
    if (!matchBackend(path, backend)) orphans.push({ path, sites: [...sites] });
  }

  // 反向：把每条前端调用映射回它命中的后端声明
  const covered = new Set();
  for (const path of calls.keys()) {
    if (backend.exact.has(path)) covered.add(path);
    const lastAsParam = path.replace(/\/[^/:]+$/, "/:p");
    if (backend.exact.has(lastAsParam)) covered.add(lastAsParam);
    const midAsParam = path.replace(/\/[^/:]+\/([^/]+)$/, "/:p/$1");
    if (backend.exact.has(midAsParam)) covered.add(midAsParam);
    for (const { prefix } of backend.prefixes) {
      if (path === prefix || path.startsWith(`${prefix}/`)) covered.add(prefix);
    }
  }

  const dead = [];
  for (const [path, entry] of backend.exact) {
    if (covered.has(path) || entry.testOnly) continue;
    if (Object.hasOwn(KNOWN_UI_LESS, path)) continue;
    dead.push({ path, methods: [...entry.methods].sort() });
  }

  // 白名单里已经接了 UI 的条目该被删除 —— 否则名单会永久留着过期条目
  const staleWhitelist = Object.keys(KNOWN_UI_LESS).filter((path) => covered.has(path));

  return {
    orphans: orphans.sort((a, b) => a.path.localeCompare(b.path)),
    dead: dead.sort((a, b) => a.path.localeCompare(b.path)),
    staleWhitelist,
    counts: {
      backendExact: backend.exact.size,
      backendPrefix: backend.prefixes.length,
      frontendCalls: calls.size,
      whitelisted: Object.keys(KNOWN_UI_LESS).length,
    },
  };
}
