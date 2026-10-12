import { createHash } from "node:crypto";
import { access, readdir, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findSecretCandidates } from "./redaction.mjs";
import { childProcessEnv, spawnCommand } from "./process-runner.mjs";
import { resolveControlSchemaPath, isWithin } from "./paths.mjs";

const MAX_CONFIG_BYTES = 5 * 1024 * 1024;
const MODULE_SOURCE_ID = "core.module";
const EXPECTED_ADAPTER_MANIFEST = "apps/control-center/src/adapters/manifest.mjs";
const CONTROL_SCHEMA_DEFINITIONS = new Map([
  ["control.models", "modelRegistry"],
  ["control.routing", "routingPolicy"],
  ["control.permissions", "permissionPolicy"],
  ["control.sources", "sourceRegistry"],
]);
const NON_ADAPTER_MODULES = new Set(["index", "manifest", "stream-utils", "native-commands", "adapter-sdk"]);
const REQUIRED_HANDOFF_PREFIXES = ["codex-to-", "grok-to-", "gemini-to-", "kimi-to-", "synthesis__"];
const EXPECTED_HANDOFF_REGISTRY = ".claude/hooks/handoff-sources.json";
const EXPECTED_DELTA_HOOKS = {
  claude: ".claude/hooks/stop-gate.py",
  codex: ".codex/hooks/stop-gate-codex.py",
};
const REQUIRED_DELTA_TEMPLATES = [
  "AGENTS.md",
  ".agents/skills/co-review/SKILL.md",
  "skills/review/codex-reviewer/SKILL.md",
  "skills/research/grok-researcher/SKILL.md",
];
const CODEX_HOOK_CONFIG = ".codex/hooks.json";
const REQUIRED_CODEX_HOOKS = new Map([
  [".codex/hooks/mirror-gate-codex.py", "SessionStart"],
  [".codex/hooks/route-gate-codex.py", "UserPromptSubmit"],
  [".codex/hooks/stop-gate-codex.py", "Stop"],
]);

function runPythonProgram(program, input, { parser, timeoutMs = 10_000 } = {}) {
  return runValidationProgram("python", ["-X", "utf8", "-c", program], input, { parser, timeoutMs });
}

function runValidationProgram(command, args, input, { parser, timeoutMs = 10_000 } = {}) {
  return new Promise((resolveResult) => {
    let child;
    try {
      // Keep validators in the child registry so an interrupted control plane
      // cannot leave validation helpers behind.
      child = spawnCommand(command, args, {
        env: childProcessEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolveResult({ ok: false, parser, error: error.message, stdout: "" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveResult(result);
    };
    timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, parser, error: "validator timed out", stdout });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 64_000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16_384) stderr += chunk.toString("utf8");
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") finish({ ok: false, parser, error: error.message, stdout });
    });
    child.once("error", (error) => finish({ ok: false, parser, error: error.message, stdout }));
    child.once("close", (code) => {
      finish({
        ok: code === 0,
        parser,
        error: code === 0 ? null : stderr.trim().slice(-4000) || `validator exited ${code}`,
        stdout,
      });
    });
    child.stdin.end(input, "utf8");
  });
}

function parseStaticModuleSpecifiers(source, { timeoutMs = 10_000 } = {}) {
  const program = [
    'const { SourceTextModule } = require("node:vm");',
    'let source = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { source += chunk; });',
    'process.stdin.on("end", () => {',
    '  try {',
    '    const module = new SourceTextModule(source, { identifier: "adapter-index.mjs" });',
    '    process.stdout.write(JSON.stringify(module.dependencySpecifiers));',
    '  } catch (error) {',
    '    process.stderr.write(error?.stack || String(error));',
    '    process.exitCode = 1;',
    '  }',
    '});',
  ].join("\n");
  return new Promise((resolveResult) => {
    let child;
    try {
      child = spawnCommand(process.execPath, ["--experimental-vm-modules", "-e", program], {
        env: childProcessEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolveResult({ ok: false, error: error.message, specifiers: [] });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: "module parser timed out", specifiers: [] });
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 64_000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16_384) stderr += chunk.toString("utf8");
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") finish({ ok: false, error: error.message, specifiers: [] });
    });
    child.once("error", (error) => finish({ ok: false, error: error.message, specifiers: [] }));
    child.once("close", (code) => {
      if (code !== 0) {
        finish({ ok: false, error: stderr.trim().slice(-4000) || `module parser exited ${code}`, specifiers: [] });
        return;
      }
      try {
        const specifiers = JSON.parse(stdout);
        if (!Array.isArray(specifiers) || specifiers.some((value) => typeof value !== "string")) {
          throw new TypeError("parser output is not a string array");
        }
        finish({ ok: true, error: null, specifiers });
      } catch (error) {
        finish({ ok: false, error: `module parser returned invalid JSON: ${error.message}`, specifiers: [] });
      }
    });
    child.stdin.end(source, "utf8");
  });
}

function runPythonValidator(kind, content, timeoutMs = 10_000) {
  const programs = {
    yaml: "import sys,yaml; yaml.safe_load(sys.stdin.read())",
    toml: "import sys,tomllib; tomllib.loads(sys.stdin.read())",
    python: "import sys; compile(sys.stdin.read(), '<control-center>', 'exec')",
  };
  const program = programs[kind];
  if (!program) return Promise.resolve({ ok: true, parser: "none" });
  return runPythonProgram(program, content, { parser: `python-${kind}`, timeoutMs });
}

function schemaDiagnostics(stdout) {
  try {
    const parsed = JSON.parse(stdout || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function schemaResult(result) {
  const diagnostics = schemaDiagnostics(result.stdout);
  return {
    ok: result.ok,
    parser: result.parser,
    error: result.ok
      ? null
      : diagnostics.map((item) => `${item.path}: ${item.message}`).join("; ") || result.error,
  };
}

async function validateControlSchema(source, instance, timeoutMs = 10_000) {
  const definition = CONTROL_SCHEMA_DEFINITIONS.get(source.id);
  if (!definition) return { ok: true, parser: "JSON.parse" };
  let schema;
  try {
    const schemaPath = await resolveControlSchemaPath(source.path);
    schema = JSON.parse(await readFile(schemaPath, "utf8"));
  } catch (error) {
    return { ok: false, parser: "node-jsonschema", error: `cannot load control schema: ${error.message}` };
  }
  const result = await runValidationProgram(
    process.execPath,
    [fileURLToPath(new URL("./json-schema-worker.mjs", import.meta.url))],
    JSON.stringify({ schema, definition, instance }),
    { parser: "node-jsonschema", timeoutMs },
  );
  return schemaResult(result);
}

async function validateModuleSchema(source, content, timeoutMs = 10_000) {
  const schemaPath = resolve(dirname(source.path), "schemas", "module.schema.json");
  let schema;
  try {
    schema = JSON.parse(await readFile(schemaPath, "utf8"));
  } catch (error) {
    return { ok: false, parser: "python-yaml-jsonschema", error: `cannot load module schema: ${error.message}` };
  }
  const program = [
    "import json,sys,yaml,jsonschema",
    "p=json.load(sys.stdin)",
    "instance=yaml.safe_load(p['content'])",
    "schema=p['schema']",
    "jsonschema.Draft202012Validator.check_schema(schema)",
    "errors=sorted(jsonschema.Draft202012Validator(schema).iter_errors(instance),key=lambda e:list(e.path))",
    "print(json.dumps([{'path':'/'.join(map(str,e.path)) or '$','message':e.message} for e in errors],ensure_ascii=False))",
    "sys.exit(1 if errors else 0)",
  ].join(";");
  const result = await runPythonProgram(
    program,
    JSON.stringify({ schema, content }),
    { parser: "python-yaml-jsonschema", timeoutMs },
  );
  return schemaResult(result);
}

async function parseYamlDocument(content) {
  const program = "import json,sys,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read()),ensure_ascii=False))";
  const result = await runPythonProgram(program, content, { parser: "python-yaml" });
  if (!result.ok) throw new Error(result.error);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Python YAML parser returned invalid JSON: ${error.message}`);
  }
}

function normalizeRepoPath(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function compareExactSets(label, registeredValues, actualValues) {
  const registered = registeredValues.map(normalizeRepoPath).filter(Boolean);
  const actual = actualValues.map(normalizeRepoPath).filter(Boolean);
  const registeredSet = new Set(registered);
  const actualSet = new Set(actual);
  const errors = [];
  const duplicates = duplicateValues(registered);
  const missing = actual.filter((value) => !registeredSet.has(value));
  const ghosts = registered.filter((value) => !actualSet.has(value));
  if (duplicates.length) errors.push(`${label} has duplicate entries: ${duplicates.join(", ")}`);
  if (missing.length) errors.push(`${label} is missing disk entries: ${missing.join(", ")}`);
  if (ghosts.length) errors.push(`${label} has entries absent from disk: ${ghosts.join(", ")}`);
  return errors;
}

function hookPair(event, file) {
  return `${String(event || "")}::${normalizeRepoPath(file)}`;
}

function parsePythonHookCommand(command) {
  const match = String(command || "").trim().match(/^python(?:\.exe)?\s+(?:"([^"]+)"|'([^']+)'|(\S+))$/i);
  return match?.[1] || match?.[2] || match?.[3] || null;
}

/**
 * 把声明值解析成"仓库内相对路径"；逃逸仓库返回 null。
 *
 * ⚠️ 逃逸判据必须同时覆盖三种形态（烛 R1 致命 1，2026-10-09 实测修正）：
 *   1. 父级逃逸   `../outside`            → relative 得 `..\outside`
 *   2. 空相对     target === repoRoot     → relative 得 ""
 *   3. 跨盘符绝对 `C:\Windows\win.ini`    → relative 得**绝对路径**（Windows 上 relative
 *      跨盘符无法表达相对关系，直接返回目标绝对路径）——既非空也不以 `..` 开头，
 *      只查前两条会**静默放行**，随后 `resolve(repoRoot, target)` 丢弃 repoRoot，
 *      真的去访问仓库外。实测注入 `C:\Windows\win.ini` 曾得 valid=true 零错误。
 *
 * 因此第三条判据 `isAbsolute(relativePath)` 不可省——与 `paths.mjs` 的 `isWithin` 同源。
 */
function repositoryRelativePath(repoRoot, value) {
  const target = resolve(repoRoot, String(value || ""));
  const relativePath = relative(repoRoot, target);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) return null;
  if (isAbsolute(relativePath)) return null;
  return normalizeRepoPath(relativePath.split(sep).join("/"));
}

/**
 * plugin.json 声明面存在性校验（2026-10-09 补）。
 *
 * 背景：`.claude-plugin/plugin.json` 的 `components.{agents,skills}` 是**声明面**——
 * 它声明"这个 plugin 有哪些组件"。此前它**只被当作版本源读取**（validateVersionSurfaces），
 * 组件路径零校验，于是 2026-08-30 F-073 删除 skills/research/web-intel 目录后，
 * plugin.json 仍指着这个不存在的路径，静默漂移了 40 天。
 *
 * 判据分两层（缺一不可）：
 *   1. 每个声明路径**在磁盘上必须存在**（declared → disk）
 *   2. 每个磁盘 skill **必须被 module.yaml 注册**（disk → module.yaml）
 * 第 2 条不在这里重做——registry.skills 已在 validateSkillRegistry 做完整集合差；
 * 本校验只补第 1 条，即"plugin.json 这个消费者自己的视图是否与磁盘一致"。
 *
 * 不做的事（避免与 registry.skills 重复造第二份真源）：
 *   - 不校验 plugin.json 的 skills 列表是否覆盖磁盘全集。实测（2026-10-09）当前
 *     `components.agents[*].source ∪ components.skills[]` = 5 + 8 = 13 = `skills/` 磁盘全集，
 *     即**当下二者恰好相等**；但这是"当下成立"而非"契约规定"，把它写成等号会新增一条
 *     "加 skill 必须同步改 plugin.json"的义务（属产品决策，非本守卫职责）。
 *     注意口径：等号说的是**并集**（13），单看 `components.skills[]` 只有 8 条——
 *     5 个命名 Agent 的 source 已覆盖其中 5 个 skill，故 skills[] 只列了余下 8 个。
 *     磁盘 → 注册表方向的完整性由既有 `registry.skills` 承担，两者互补不重复。
 */
async function validatePluginManifest(repoRoot) {
  const manifestPath = resolve(repoRoot, ".claude-plugin", "plugin.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    return repositoryResult("registry.plugin", [`cannot parse .claude-plugin/plugin.json: ${error.message}`]);
  }
  const errors = [];
  const components = manifest?.components;
  // components 整体缺席 = 极简 manifest（无组件声明），按空视图通过；
  // 只有"声明了 components 但形状/路径不对"才算错——避免把无组件清单误判为漂移。
  if (components === undefined) return repositoryResult("registry.plugin", []);
  if (!components || typeof components !== "object" || Array.isArray(components)) {
    return repositoryResult("registry.plugin", ["plugin.json components must be an object"]);
  }

  const declared = [];
  const agents = components.agents;
  if (agents !== undefined) {
    if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
      errors.push("plugin.json components.agents must be an object");
    } else {
      for (const [code, entry] of Object.entries(agents)) {
        for (const field of ["source", "customize"]) {
          const value = entry?.[field];
          if (value === undefined) continue;
          if (typeof value !== "string" || !value.trim()) {
            errors.push(`plugin.json components.agents.${code}.${field} must be a non-empty string`);
            continue;
          }
          declared.push({ label: `agents.${code}.${field}`, path: value });
        }
      }
    }
  }
  if (components.skills !== undefined) {
    if (!Array.isArray(components.skills)) {
      errors.push("plugin.json components.skills must be an array");
    } else {
      for (const [index, value] of components.skills.entries()) {
        if (typeof value !== "string" || !value.trim()) {
          errors.push(`plugin.json components.skills[${index}] must be a non-empty string`);
          continue;
        }
        declared.push({ label: `skills[${index}]`, path: value });
      }
    }
  }
  for (const field of ["guardrails", "customize", "module_config", "rules"]) {
    const value = components[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim()) {
      errors.push(`plugin.json components.${field} must be a non-empty string`);
      continue;
    }
    declared.push({ label: field, path: value });
  }

  // 逐条存在性（用 access 而非 stat 文件类型判断：plugin.json 的路径既有文件也有目录）
  //
  // ⚠️ 纯字符串判据挡不住**链接穿透**（烛 R2 实测，2026-10-09 补）：
  //   `repositoryRelativePath` 只做 resolve 归一化、不碰磁盘，而 `access` 会**跟随**
  //   symlink/junction。于是"仓内 junction → 仓外目录"这种声明字符串完全合法，
  //   却真的把校验引到仓库外。实测：声明 `linked` 或 `linked/secret.md`
  //   （linked 是仓内 junction 指向仓外）→ valid=true 零错误。
  //   补 if 也挡不住——必须在 access 之后对**真实路径**再做一次边界判定。
  //   本仓库已有同款先例：config-manager.mjs 的 SYMLINK_REJECTED、workspace-explorer 拒 links。
  const realRepoRoot = await realpath(repoRoot);
  for (const entry of declared) {
    const relativePath = repositoryRelativePath(repoRoot, entry.path);
    if (!relativePath) {
      errors.push(`plugin.json components.${entry.label} escapes the repository: ${entry.path}`);
      continue;
    }
    const target = resolve(repoRoot, relativePath);
    try {
      await access(target);
    } catch {
      errors.push(`plugin.json components.${entry.label} points at a path absent from disk: ${relativePath}`);
      continue;
    }
    let realTarget;
    try {
      realTarget = await realpath(target);
    } catch {
      errors.push(`plugin.json components.${entry.label} cannot be resolved on disk: ${relativePath}`);
      continue;
    }
    if (!isWithin(realRepoRoot, realTarget)) {
      errors.push(
        `plugin.json components.${entry.label} resolves outside the repository through a link: ${relativePath}`,
      );
    }
  }
  if (declared.length === 0) errors.push("plugin.json declares no component paths to verify");
  return repositoryResult("registry.plugin", errors);
}

/**
 * 三层定制化（customize.toml）的**机械承载**（2026-10-09 补，缺口 C）。
 *
 * 背景：`rules.md §五` + `customize/README.md` 详述了三层 override 与 4 条合并规则，
 * 5 个 SKILL.md 都写着"解析 customize.toml 三层合并"。但在本轮之前**全仓零实现**——
 * 没有任何 mjs/py/ps1 做这个 merge，`customize/team/` 目录根本不存在，
 * `customize/personal/` 只有一个 `.gitignore`，全仓**零个 override 实例**。
 * 即：一份读起来像护栏的声明，40+ 天无消费者（与 plugin.json 死引用同一形态）。
 *
 * 本函数落地的是**可机械判定的那一半**——合并结果的结构正确性。判据不写死"必须有
 * 哪些键"（那会腐烂），而是**从磁盘真值派生**：
 *   · 合并三层 → 结果形状必须与 base（skill 内 customize.toml）一致
 *   · base 里的 `name` / `title` 只读 → override 改了必须报错（rules §五 明文）
 *   · `menu` 的替换语义 → code 不得重复、不得新增 base 没有的 code（README 的"无删除机制"
 *     + "按 code 匹配替换"两条合起来的机械推论）
 *
 * 明确**不做**的事（诚实边界）：不执行合并去驱动 agent 运行时行为——那需要 LLM 侧
 * 消费合并结果，属"LLM 现读"路径（SKILL.md 的 Step 1 已如此声明）。本校验只保证
 * "三层文件本身是自洽的"，不假装验证了"运行时真的用了它"。
 *
 * **真仓库当前是空跑**（烛 R2 实测）：5 个 agent skill、5 份 base、**0 个 override 实例**
 * → 内层循环迭代 0 次。本校验的有效性由 `tests/validator-governance.test.mjs` 的
 * fixture 保证（含突变验收），不靠真仓库有实例。**如实标注，不把"空跑全绿"当成"验证过了"。**
 */
const CUSTOMIZE_READONLY_FIELDS = Object.freeze(["name", "title"]);
/**
 * 三层 override 的层定义：`dir` 目录 + `suffix` 文件名后缀。
 *
 * ⚠️ personal 层的后缀是 `.user.toml`（`customize/README.md:8,56` + `personal/.gitignore`
 * 的 `*.user.toml` 都这么写）。初版一律拼 `${code}.toml`，导致 **personal 层永不校验**——
 * 而 personal 正是 `.gitignore` 的本地层、最没人 review 的一层。烛 R1 实测：
 * 同一份含 `agent.name` 违规的 override，写成 `codex-reviewer.user.toml` → valid=true
 * （未捕获），写成 `codex-reviewer.toml` → 才捕获。**照 README 写就绕过全部判据。**
 * 反向隐患同样实测确认：`codex-reviewer.toml` **不在** `.gitignore` 规则内，会意外入库。
 */
const CUSTOMIZE_LAYERS = Object.freeze([
  { dir: "team", suffix: ".toml" },
  { dir: "personal", suffix: ".user.toml" },
]);

/**
 * 用 Python 标准库 tomllib 解析 TOML（与 validateContent 的 `toml` 分支同一通道）。
 *
 * 为什么不手写解析器：初版手搓了一个"极简 TOML 子集"解析器，**在第一份真实文件上就
 * 撞墙**——`codex-reviewer/customize.toml` 的多行字符串（`"""` 跨行）触发
 * "unsupported line (agent)"，5 个 agent skill 全部解析失败。这正是不复用既有能力的
 * 代价（同 R1/R2 的教训）。仓库已有 `python -X utf8 -c "import tomllib"` 通道
 * （validateContent:169），直接复用，零新依赖、零方言风险。
 */
async function parseTomlDocument(content, label) {
  const program = "import json,sys,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read()),ensure_ascii=False))";
  const result = await runPythonProgram(program, content, { parser: "python-toml" });
  if (!result.ok) throw new Error(`${label}: ${result.error}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label}: Python TOML parser returned invalid JSON: ${error.message}`);
  }
}

async function readCustomizeLayer(repoRoot, relativePath, errors) {
  let text;
  try {
    text = await readFile(resolve(repoRoot, relativePath), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    errors.push(`${relativePath} unreadable: ${error.message}`);
    return null;
  }
  try {
    return await parseTomlDocument(text, relativePath);
  } catch (error) {
    errors.push(`${relativePath} parse failed: ${error.message}`);
    return null;
  }
}

/**
 * 递归比对 override 与 base 的键形状，返回错误列表（空 = 形状合法）。
 *
 * 覆盖三层 override 的全部键路径（不止 agent 一层）——烛 R2 实测：只查一层时
 * `[codex] invoke_patern = "typo"`、`[review_defaults] stricness` 这类**拼错键名**
 * 会静默通过。拼错键名 = override 写了个没人读的键，正是稀疏 override 最典型的
 * 静默失效形态（写的人以为生效了）。
 *
 * 语义边界：
 *   · base 是**标量**而 override 是表 → 报错（类型不兼容）
 *   · base 是**表**而 override 是标量 → 报错
 *   · base 是**数组**（含表数组）→ 只做"表数组元素的 code/id 不得重复"检查，
 *     不要求元素形状一致（README：数组=追加 / 有 code 的表数组=匹配替换+追加）
 *   · override 出现 base 没有的键 → 报错（README 的"无删除机制"只约束"不能删 base 条目"，
 *     不等于"可以随意新增未知键"；未知键必然是拼错或该进 base）
 */
function compareOverrideShape(layerPath, basePath, base, override, path = []) {
  const errors = [];
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    if (path.length) errors.push(`${layerPath} ${path.join(".")} must be a table`);
    return errors;
  }
  for (const [key, value] of Object.entries(override)) {
    const keyPath = [...path, key];
    if (!Object.hasOwn(base, key)) {
      errors.push(`${layerPath} declares key absent from ${basePath}: ${keyPath.join(".")}`);
      continue;
    }
    const baseValue = base[key];
    const overrideIsTable = value && typeof value === "object" && !Array.isArray(value);
    const baseIsTable = baseValue && typeof baseValue === "object" && !Array.isArray(baseValue);
    if (overrideIsTable !== baseIsTable) {
      errors.push(
        `${layerPath} ${keyPath.join(".")} shape mismatch: override is ${overrideIsTable ? "table" : "scalar/array"}, base is ${baseIsTable ? "table" : "scalar/array"}`,
      );
      continue;
    }
    if (overrideIsTable) {
      errors.push(...compareOverrideShape(layerPath, basePath, baseValue, value, keyPath));
      continue;
    }
    if (Array.isArray(value) && value.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      const codes = value.map((item) => item?.code ?? item?.id).filter((code) => code !== undefined);
      const duplicated = duplicateValues(codes.map(String));
      if (duplicated.length) {
        errors.push(`${layerPath} ${keyPath.join(".")} has duplicate code/id entries: ${duplicated.join(", ")}`);
      }
    }
  }
  return errors;
}

async function validateCustomizeLayers(repoRoot, moduleDocument) {
  const errors = [];
  const skillEntries = (Array.isArray(moduleDocument?.skills) ? moduleDocument.skills : [])
    .filter((skill) => skill?.path && String(skill.type || "") === "agent");

  for (const skill of skillEntries) {
    const basePath = `${skill.path}/customize.toml`;
    const base = await readCustomizeLayer(repoRoot, basePath, errors);
    if (!base) continue; // agent skill 无 customize.toml → 由 registry.skills 管，不在此报错

    for (const layer of CUSTOMIZE_LAYERS) {
      const layerPath = `customize/${layer.dir}/${skill.code}${layer.suffix}`;
      const override = await readCustomizeLayer(repoRoot, layerPath, errors);
      if (!override) continue;

      // 判据 1：只读字段（rules §五 明文：agent.name / agent.title 只读）
      for (const field of CUSTOMIZE_READONLY_FIELDS) {
        if (override?.agent && Object.hasOwn(override.agent, field)) {
          errors.push(`${layerPath} overrides read-only agent.${field} (rules.md §五: read-only)`);
        }
      }

      // 判据 2：override 只能出现在 base 已有的键路径上（稀疏 override 纪律）。
      // 逐层递归比对，不只查顶层与 agent 一层——烛 R2 实测：`[codex] invoke_patern = "typo"`
      // 与 `[review_defaults] stricness` 这种**键名拼错**在只查一层时会静默通过，
      // 而拼错正是稀疏 override 最典型的静默失效形态。
      errors.push(...compareOverrideShape(layerPath, basePath, base, override));

      // 判据 3：menu 内 code 不得重复。
      // ⚠️ 此处**只查重复，不查"是否新增 code"**——烛 R2 纠正了主驾的过度推论：
      // `customize/README.md:17` 明文「有 code/id 键的表数组 = 按键匹配替换，**新键追加**」。
      // "新键追加"管的是"遇到 base 没有的条目怎么办"，"无删除机制"管的是"不能删 base 条目"，
      // 二者不矛盾。主驾初版据"无删除"推出"menu 只能替换不能新增"，属**过严的假约束**
      // （会把合法的"给 agent 加一个自定义菜单项"误判为违规），已删除该判据。
      const overrideCodes = (override.agent?.menu || []).map((item) => item?.code).filter(Boolean);
      const duplicated = duplicateValues(overrideCodes);
      if (duplicated.length) errors.push(`${layerPath} menu has duplicate codes: ${duplicated.join(", ")}`);
    }
  }
  return repositoryResult("registry.customize", errors);
}

async function collectSkillDirectories(repoRoot) {
  const found = [];
  const walk = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name === "SKILL.md") {
        found.push(normalizeRepoPath(relative(repoRoot, dirname(path)).split(sep).join("/")));
      }
    }
  };
  await walk(resolve(repoRoot, "skills"));
  await walk(resolve(repoRoot, ".agents", "skills"));
  return found.sort();
}

function repositoryResult(id, errors, warnings = []) {
  return {
    id,
    valid: errors.length === 0,
    errors,
    warnings,
    parser: "repository-truth",
  };
}

async function validateSkillRegistry(repoRoot, moduleDocument) {
  const registeredSkills = Array.isArray(moduleDocument?.skills) ? moduleDocument.skills : [];
  const errors = [];
  if (!Array.isArray(moduleDocument?.skills)) errors.push("module.yaml skills must be an array");
  errors.push(...compareExactSets(
    "module.yaml skills",
    registeredSkills.map((skill) => skill?.path),
    await collectSkillDirectories(repoRoot),
  ));
  const duplicateCodes = duplicateValues(registeredSkills.map((skill) => String(skill?.code || "")).filter(Boolean));
  if (duplicateCodes.length) errors.push(`module.yaml skill codes are duplicated: ${duplicateCodes.join(", ")}`);
  return repositoryResult("registry.skills", errors);
}

async function validateAdapterRegistry(repoRoot, moduleDocument) {
  const adapterRoot = resolve(repoRoot, "apps", "control-center", "src", "adapters");
  const entries = await readdir(adapterRoot, { withFileTypes: true });
  const implementations = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => basename(entry.name, ".mjs"))
    .filter((name) => !NON_ADAPTER_MODULES.has(name))
    .sort();
  const registered = Array.isArray(moduleDocument?.control_center?.adapters)
    ? moduleDocument.control_center.adapters
    : [];
  const indexText = await readFile(resolve(adapterRoot, "index.mjs"), "utf8");
  const parsedImports = await parseStaticModuleSpecifiers(indexText);
  const imports = parsedImports.specifiers
    .map((specifier) => specifier.match(/^\.\/([a-z0-9-]+)\.mjs$/)?.[1])
    .filter((name) => name && !NON_ADAPTER_MODULES.has(name));
  const errors = [];
  if (!parsedImports.ok) errors.push(`adapter index static import parse failed: ${parsedImports.error}`);
  const declaredManifest = normalizeRepoPath(moduleDocument?.control_center?.adapter_manifest);
  if (declaredManifest !== EXPECTED_ADAPTER_MANIFEST) {
    errors.push(`module.yaml adapter manifest declares ${declaredManifest || "missing"}, expected ${EXPECTED_ADAPTER_MANIFEST}`);
  }
  if (!Array.isArray(moduleDocument?.control_center?.adapters)) {
    errors.push("module.yaml control_center.adapters must be an array");
  }
  errors.push(...compareExactSets("module.yaml control_center.adapters", registered, implementations));
  errors.push(...compareExactSets("adapter index imports", imports, implementations));
  const { templates } = await loadAdapterManifest(repoRoot);
  errors.push(...compareExactSets(
    "adapter manifest factory keys",
    [...new Set(templates.map((template) => template?.factoryKey))],
    implementations,
  ));
  return repositoryResult("registry.adapters", errors);
}

async function loadAdapterManifest(repoRoot) {
  const manifestPath = resolve(repoRoot, "apps", "control-center", "src", "adapters", "manifest.mjs");
  const manifestText = await readFile(manifestPath, "utf8");
  const moduleHash = createHash("sha256").update(manifestText).digest("hex").slice(0, 16);
  const manifestModule = await import(`${pathToFileURL(manifestPath).href}?registry=${moduleHash}`);
  if (!Array.isArray(manifestModule.ADAPTER_BINDINGS)) {
    throw new Error("adapter manifest must export ADAPTER_BINDINGS as an array");
  }
  if (!Array.isArray(manifestModule.ADAPTER_TEMPLATES)) {
    throw new Error("adapter manifest must export ADAPTER_TEMPLATES as an array");
  }
  return {
    bindings: manifestModule.ADAPTER_BINDINGS,
    templates: manifestModule.ADAPTER_TEMPLATES,
  };
}

async function validateModelWiring(repoRoot) {
  const modelsPath = resolve(repoRoot, "config", "control-center", "models.json");
  const [models, manifest] = await Promise.all([
    readFile(modelsPath, "utf8").then(JSON.parse),
    loadAdapterManifest(repoRoot),
  ]);
  const { bindings, templates } = manifest;
  const profiles = Array.isArray(models?.profiles) ? models.profiles : [];
  const modelIds = profiles.map((profile) => String(profile?.id || "")).filter(Boolean);
  const wiredIds = bindings.map((binding) => String(binding?.profileId || "")).filter(Boolean);
  const modelSet = new Set(modelIds);
  const errors = [];
  if (!Array.isArray(models?.profiles)) errors.push("models.json profiles must be an array");
  const duplicateModels = duplicateValues(modelIds);
  const duplicateWiring = duplicateValues(wiredIds);
  if (duplicateModels.length) errors.push(`models.json profile ids are duplicated: ${duplicateModels.join(", ")}`);
  if (duplicateWiring.length) errors.push(`adapter manifest profile ids are duplicated: ${duplicateWiring.join(", ")}`);
  const templateIds = templates.map((template) => String(template?.id || "")).filter(Boolean);
  const duplicateTemplates = duplicateValues(templateIds);
  if (duplicateTemplates.length) errors.push(`adapter template ids are duplicated: ${duplicateTemplates.join(", ")}`);
  const templateById = new Map(templates.map((template) => [String(template?.id || ""), template]));
  for (const [index, template] of templates.entries()) {
    if (!template || typeof template !== "object" || Array.isArray(template)) {
      errors.push(`adapter template ${index} must be an object`);
      continue;
    }
    for (const field of ["id", "factoryKey"]) {
      if (typeof template[field] !== "string" || !template[field].trim()) {
        errors.push(`adapter template ${index} has invalid ${field}`);
      }
    }
    for (const field of ["requiresCommand", "teamMemberEligible", "coordinatorCapable", "selectable"]) {
      if (typeof template[field] !== "boolean") {
        errors.push(`adapter template ${template.id || index} has invalid ${field}`);
      }
    }
  }
  for (const [index, binding] of bindings.entries()) {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      errors.push(`adapter manifest binding ${index} must be an object`);
      continue;
    }
    for (const field of ["profileId", "adapterId", "factoryKey"]) {
      if (typeof binding[field] !== "string" || !binding[field].trim()) {
        errors.push(`adapter manifest binding ${index} has invalid ${field}`);
      }
    }
    for (const field of ["requiresCommand", "teamMemberEligible", "coordinatorEligible"]) {
      if (typeof binding[field] !== "boolean") {
        errors.push(`adapter manifest binding ${binding.profileId || index} has invalid ${field}`);
      }
    }
    if (binding.fallbackFor != null && (typeof binding.fallbackFor !== "string" || !binding.fallbackFor.trim())) {
      errors.push(`adapter manifest binding ${binding.profileId || index} has invalid fallbackFor`);
    }
    if (binding.coordinatorEligible === true && binding.teamMemberEligible !== true) {
      errors.push(`adapter manifest binding ${binding.profileId || index} cannot coordinate without team membership`);
    }
    if (binding.fallbackFor && (binding.teamMemberEligible === true || binding.coordinatorEligible === true)) {
      errors.push(`adapter fallback ${binding.profileId || index} cannot be exposed as a team seat`);
    }
    const template = templateById.get(String(binding.adapterId || ""));
    if (!template) {
      errors.push(`adapter manifest binding ${binding.profileId || index} references unknown template ${binding.adapterId || "missing"}`);
    } else if (template.factoryKey !== binding.factoryKey) {
      errors.push(`adapter manifest binding ${binding.profileId || index} factory ${binding.factoryKey} does not match template ${template.id} factory ${template.factoryKey}`);
    }
  }

  const bindingByProfile = new Map(bindings.map((binding) => [String(binding?.profileId || ""), binding]));
  for (const profile of profiles) {
    const profileId = String(profile?.id || "");
    const binding = bindingByProfile.get(profileId);
    const configuredAdapter = String(profile?.adapter || "");
    if (binding) {
      if (configuredAdapter !== binding.adapterId) {
        errors.push(`model profile ${profileId} declares adapter ${configuredAdapter || "missing"}, expected ${binding.adapterId}`);
      }
      if (binding.fallbackFor) errors.push(`model profile ${profileId} cannot be declared as a fallback binding`);
      if (profile?.builtin === false) errors.push(`fixed system model profile ${profileId} cannot declare builtin=false`);
      continue;
    }
    if (profile?.builtin !== false) {
      errors.push(`model profile ${profileId || "<missing>"} has no fixed adapter binding; custom runtime seats must declare builtin=false`);
      continue;
    }
    const template = templateById.get(configuredAdapter);
    if (!template || template.selectable === false) {
      errors.push(`custom runtime seat ${profileId} references unsupported adapter template ${configuredAdapter || "missing"}`);
      continue;
    }
  }

  for (const binding of bindings) {
    const profileId = String(binding?.profileId || "");
    if (!profileId || modelSet.has(profileId)) continue;
    const fallbackFor = String(binding?.fallbackFor || "");
    if (!fallbackFor) {
      errors.push(`adapter manifest binding without model profile: ${profileId}`);
      continue;
    }
    const target = bindingByProfile.get(fallbackFor);
    if (!modelSet.has(fallbackFor) || !target || target.fallbackFor) {
      errors.push(`adapter fallback ${profileId} references invalid model profile ${fallbackFor}`);
    }
  }
  return repositoryResult("registry.models", errors);
}

function markdownStructuralLines(content) {
  const output = [];
  let inComment = false;
  let fence = null;
  for (const [index, rawLine] of String(content).split(/\r?\n/).entries()) {
    let line = rawLine;
    const initialTrimmed = line.trimStart();
    if (fence) {
      const closing = initialTrimmed.match(/^(`{3,}|~{3,})\s*$/)?.[1] || null;
      if (closing && closing[0] === fence[0] && closing.length >= fence.length) fence = null;
      continue;
    }

    let visible = "";
    let cursor = 0;
    while (cursor < line.length) {
      if (inComment) {
        const close = line.indexOf("-->", cursor);
        if (close < 0) {
          cursor = line.length;
          continue;
        }
        inComment = false;
        cursor = close + 3;
        continue;
      }
      const open = line.indexOf("<!--", cursor);
      if (open < 0) {
        visible += line.slice(cursor);
        break;
      }
      visible += line.slice(cursor, open);
      inComment = true;
      cursor = open + 4;
    }

    const trimmed = visible.trimStart();
    const opening = trimmed.match(/^(`{3,}|~{3,})/)?.[1] || null;
    if (opening) {
      fence = opening;
      continue;
    }
    if (!trimmed || trimmed.startsWith(">")) continue;
    output.push({ number: index + 1, text: visible.trimEnd() });
  }
  return output;
}

function markdownSections(lines, headingPattern) {
  const starts = [];
  for (const [index, line] of lines.entries()) {
    headingPattern.lastIndex = 0;
    if (headingPattern.test(line.text.trimStart())) starts.push(index);
  }
  return starts.map((start) => {
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^##(?:\s|$)/.test(lines[index].text.trimStart())) {
        end = index;
        break;
      }
    }
    return { heading: lines[start], lines: lines.slice(start + 1, end) };
  });
}

function rulesReleaseVersions(content) {
  const lines = markdownStructuralLines(content);
  const title = lines.find(({ text }) => /^#(?:\s|$)/.test(text.trimStart()) && !/^##/.test(text.trimStart()));
  const titleMinor = title?.text.trimStart().match(/\sv([0-9]+\.[0-9]+)\s*$/)?.[1] || null;
  const sections = markdownSections(lines, /^##\s+八、版本\s*$/);
  const errors = [];
  let release = null;
  if (sections.length !== 1) {
    errors.push(`rules.md must contain exactly one visible section 8 version heading, found ${sections.length}`);
  } else {
    const releasePattern = /^\s*-\s+\*\*v([0-9]+\.[0-9]+\.[0-9]+)\*\*/;
    release = sections[0].lines[0]?.text.match(releasePattern)?.[1] || null;
    if (!release) {
      errors.push("rules.md section 8 must begin with one formal current release line");
    } else {
      const currentLines = sections[0].lines.filter(({ text }) => text.match(releasePattern)?.[1] === release);
      if (currentLines.length !== 1) {
        errors.push(`rules.md section 8 must expose current release v${release} exactly once, found ${currentLines.length}`);
      }
    }
  }
  return { release, titleMinor, errors };
}

function changelogLatestRelease(content) {
  const headings = markdownStructuralLines(content)
    .filter(({ text }) => /^##(?:\s|$)/.test(text.trimStart()));
  const pattern = /^##\s+\d{4}-\d{2}-\d{2}\s+(?:-|—)\s+v([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/;
  const release = headings[0]?.text.trimStart().match(pattern)?.[1] || null;
  const errors = [];
  if (!release) errors.push("CHANGELOG.md first visible H2 must be a formal release heading");
  const declared = headings
    .map(({ text }) => text.trimStart().match(pattern)?.[1] || null)
    .filter(Boolean);
  const duplicates = duplicateValues(declared);
  if (duplicates.length) errors.push(`CHANGELOG.md has duplicate release headings: ${duplicates.join(", ")}`);
  return { release, errors };
}

function projectOverviewVersion(content, labelPattern) {
  const lines = markdownStructuralLines(content);
  const sections = markdownSections(lines, /^##\s+项目概览\s*$/);
  const errors = [];
  if (sections.length !== 1) {
    errors.push(`must contain exactly one visible project overview section, found ${sections.length}`);
    return { version: null, errors };
  }
  const matches = sections[0].lines
    .map(({ text }) => text.match(labelPattern)?.[1] || null)
    .filter(Boolean);
  if (matches.length !== 1) errors.push(`project overview must contain exactly one target version line, found ${matches.length}`);
  return { version: matches.length === 1 ? matches[0] : null, errors };
}

function readmeReleaseVersion(content) {
  const lines = markdownStructuralLines(content);
  const beforeFirstSection = [];
  for (const line of lines) {
    if (/^##(?:\s|$)/.test(line.text.trimStart())) break;
    beforeFirstSection.push(line);
  }
  const matches = beforeFirstSection
    .map(({ text }) => text.trim().match(/^v([0-9]+\.[0-9]+\.[0-9]+)\s*\|/)?.[1] || null)
    .filter(Boolean);
  return {
    version: matches.length === 1 ? matches[0] : null,
    errors: matches.length === 1
      ? []
      : [`README.md must contain exactly one formal version line before the first H2, found ${matches.length}`],
  };
}

async function validateVersionSurfaces(repoRoot, moduleDocument) {
  const paths = {
    rules: resolve(repoRoot, "rules.md"),
    changelog: resolve(repoRoot, "CHANGELOG.md"),
    agents: resolve(repoRoot, "AGENTS.md"),
    claude: resolve(repoRoot, "CLAUDE.md"),
    readme: resolve(repoRoot, "README.md"),
    plugin: resolve(repoRoot, ".claude-plugin", "plugin.json"),
  };
  const [rules, changelog, agents, claude, readme, pluginText] = await Promise.all(
    Object.values(paths).map((path) => readFile(path, "utf8")),
  );
  const plugin = JSON.parse(pluginText);
  const rulesVersions = rulesReleaseVersions(rules);
  const changelogVersion = changelogLatestRelease(changelog);
  const agentsVersion = projectOverviewVersion(agents, /^\s*-\s+\*\*版本\*\*[：:]\s*v([0-9]+\.[0-9]+\.[0-9]+)\s*$/);
  const claudeVersion = projectOverviewVersion(claude, /^\s*-\s+\*\*当前版本\*\*[：:]\s*\*\*v([0-9]+\.[0-9]+\.[0-9]+)\*\*/);
  const readmeVersion = readmeReleaseVersion(readme);
  const canonical = rulesVersions.release;
  const surfaces = new Map([
    ["rules.md latest release", canonical],
    ["CHANGELOG.md latest release", changelogVersion.release],
    ["module.yaml", moduleDocument?.version || null],
    ["AGENTS.md", agentsVersion.version],
    ["CLAUDE.md", claudeVersion.version],
    ["README.md", readmeVersion.version],
    [".claude-plugin/plugin.json", plugin?.version || null],
  ]);
  const errors = [
    ...rulesVersions.errors,
    ...changelogVersion.errors,
    ...agentsVersion.errors.map((error) => `AGENTS.md ${error}`),
    ...claudeVersion.errors.map((error) => `CLAUDE.md ${error}`),
    ...readmeVersion.errors,
  ];
  if (!canonical) errors.push("rules.md does not expose a latest full semantic version in section 8");
  for (const [label, version] of surfaces) {
    if (!version) errors.push(`${label} does not expose a formal version`);
    else if (canonical && version !== canonical) errors.push(`${label} declares ${version}, expected ${canonical}`);
  }
  const rulesMinor = rulesVersions.titleMinor;
  const expectedMinor = canonical?.split(".").slice(0, 2).join(".") || null;
  if (!rulesMinor) errors.push("rules.md title does not expose a major.minor version");
  else if (expectedMinor && rulesMinor !== expectedMinor) {
    errors.push(`rules.md title declares ${rulesMinor}, expected ${expectedMinor}`);
  }
  return repositoryResult("framework.version", errors);
}

function semverTuple(value) {
  const match = String(value || "").match(/^([0-9]+)\.([0-9]+)\.([0-9]+)$/);
  return match ? match.slice(1).map(Number) : null;
}

function semverAtLeast(value, minimum) {
  const actual = semverTuple(value);
  const expected = semverTuple(minimum);
  if (!actual || !expected) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== expected[index]) return actual[index] > expected[index];
  }
  return true;
}

async function validateRuntimeContracts(repoRoot, moduleDocument) {
  const [packageDocument, models, rules] = await Promise.all([
    readFile(resolve(repoRoot, "apps", "control-center", "package.json"), "utf8").then(JSON.parse),
    readFile(resolve(repoRoot, "config", "control-center", "models.json"), "utf8").then(JSON.parse),
    readFile(resolve(repoRoot, "rules.md"), "utf8"),
  ]);
  const errors = [];
  const nodeContract = String(moduleDocument?.dependencies?.node || "");
  const packageEngine = String(packageDocument?.engines?.node || "");
  const nodeVersion = nodeContract.match(/^>=(.+)$/)?.[1] || null;
  if (!nodeVersion || !semverAtLeast(nodeVersion, "22.5.0")) {
    errors.push(`module.yaml Node contract must be >=22.5.0 or newer, got ${nodeContract || "missing"}`);
  }
  if (packageEngine !== nodeContract) {
    errors.push(`apps/control-center/package.json engines.node declares ${packageEngine || "missing"}, expected ${nodeContract || "module dependency"}`);
  }

  // Python 可用性：validateContent / parseYamlDocument / parseTomlDocument 全部经
  // `python -X utf8 -c` 通道。Python 缺失时这些校验会以**"文件坏了"的面目**失败
  // （烛 R2：`parseTomlDocument` 把环境问题渲染成 `parse failed`），误导排查方向。
  // 故在 runtime.contracts 里显式探一次，把"环境缺 Python"与"配置真的坏了"分开记账。
  const pythonContract = String(moduleDocument?.dependencies?.python || "");
  const pythonProbe = await runPythonProgram("import sys; print(sys.version_info[0], sys.version_info[1])", "", {
    parser: "python-probe",
    timeoutMs: 10_000,
  });
  if (!pythonProbe.ok) {
    errors.push(
      `python is unavailable but is a declared runtime dependency (${pythonContract || "module.yaml dependencies.python"}): ${pythonProbe.error || "probe failed"}`,
    );
  } else {
    const [major, minor] = String(pythonProbe.stdout).trim().split(/\s+/).map(Number);
    const required = pythonContract.match(/^>=(\d+)\.(\d+)$/);
    if (required && (major < Number(required[1]) || (major === Number(required[1]) && minor < Number(required[2])))) {
      errors.push(`python ${major}.${minor} is below the declared contract ${pythonContract}`);
    }
  }

  const kimiDependency = String(moduleDocument?.dependencies?.["kimi-code-cli"] || "");
  const kimiContract = moduleDocument?.control_center?.provider_contracts?.kimi;
  if (!semverTuple(kimiDependency)) {
    errors.push(`module.yaml kimi-code-cli contract must be a full semantic version, got ${kimiDependency || "missing"}`);
  }
  if (!kimiContract || typeof kimiContract !== "object") {
    errors.push("module.yaml control_center.provider_contracts.kimi is missing");
  } else {
    if (String(kimiContract.cli_version || "") !== kimiDependency) {
      errors.push(`Kimi provider contract declares ${kimiContract.cli_version || "missing"}, expected dependency ${kimiDependency || "missing"}`);
    }
    if (kimiContract.read_only_permission_flag !== "--plan") {
      errors.push("Kimi read-only contract must explicitly carry --plan");
    }
    if (kimiContract.workspace_write_policy !== "fail-closed") {
      errors.push("Kimi workspace-write contract must be fail-closed");
    }
  }

  const profiles = Array.isArray(models?.profiles) ? models.profiles : [];
  const kimiProfile = profiles.find((profile) => profile?.id === kimiContract?.profile);
  if (!kimiProfile) {
    errors.push(`models.json is missing Kimi profile ${kimiContract?.profile || "missing"}`);
  } else {
    if (kimiProfile.adapter !== kimiContract?.adapter) {
      errors.push(`Kimi model profile adapter declares ${kimiProfile.adapter || "missing"}, expected ${kimiContract?.adapter || "missing"}`);
    }
    const localEvidence = Array.isArray(kimiProfile.evidence)
      ? kimiProfile.evidence.find((item) => item?.source === "local-cli")
      : null;
    if (!String(localEvidence?.detail || "").includes(`Kimi Code CLI ${kimiDependency}`)) {
      errors.push(`Kimi local-cli evidence does not identify version ${kimiDependency || "missing"}`);
    }
  }

  const externalCliSections = markdownSections(markdownStructuralLines(rules), /^##\s+四、外部 CLI/);
  if (externalCliSections.length !== 1) {
    errors.push(`rules.md must contain exactly one visible external CLI section, found ${externalCliSections.length}`);
  }
  const kimiRuleLine = externalCliSections[0]?.lines
    .find(({ text }) => /^\*\*Kimi Code CLI/.test(text.trimStart()))?.text || "";
  const rulesKimiVersion = kimiRuleLine.match(/：`kimi`\s+([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] || null;
  if (rulesKimiVersion !== kimiDependency) {
    errors.push(`rules.md Kimi contract declares ${rulesKimiVersion || "missing"}, expected ${kimiDependency || "module dependency"}`);
  }
  if (!kimiRuleLine.includes("--plan") || !kimiRuleLine.includes("fail-closed")) {
    errors.push("rules.md Kimi contract must state --plan read-only and fail-closed workspace-write semantics");
  }
  return repositoryResult("runtime.contracts", errors);
}

function safeRepositoryAsset(repoRoot, value) {
  const normalized = normalizeRepoPath(value);
  if (!normalized || normalized.startsWith("/") || normalized.startsWith("../")
    || normalized.includes("/../") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`unsafe repository asset path: ${value}`);
  }
  return { normalized, path: resolve(repoRoot, normalized) };
}

function parseHandoffRegistry(document) {
  const errors = [];
  const entries = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { entries, errors: ["handoff source registry must be an object"] };
  }
  if (document.schemaVersion !== 1) errors.push("handoff source registry schemaVersion must be 1");
  if (!Array.isArray(document.sources) || document.sources.length === 0) {
    errors.push("handoff source registry sources must be a non-empty array");
    return { entries, errors };
  }
  const sourceIds = [];
  const prefixes = [];
  for (const source of document.sources) {
    const id = String(source?.id || "");
    sourceIds.push(id);
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(id)) errors.push(`invalid handoff source id: ${id || "missing"}`);
    if (!Array.isArray(source?.prefixes) || source.prefixes.length === 0) {
      errors.push(`handoff source ${id || "missing"} has no prefixes`);
      continue;
    }
    for (const prefixValue of source.prefixes) {
      const prefix = String(prefixValue || "");
      prefixes.push(prefix);
      if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(prefix)) errors.push(`invalid handoff prefix: ${prefix || "missing"}`);
      entries.push([prefix, id]);
    }
  }
  const duplicateIds = duplicateValues(sourceIds.filter(Boolean));
  const duplicatePrefixes = duplicateValues(prefixes.filter(Boolean));
  if (duplicateIds.length) errors.push(`handoff source ids are duplicated: ${duplicateIds.join(", ")}`);
  if (duplicatePrefixes.length) errors.push(`handoff prefixes are duplicated: ${duplicatePrefixes.join(", ")}`);
  return { entries, errors };
}

function markdownCommentFreeLines(content) {
  const lines = [];
  let inComment = false;
  for (const rawLine of String(content).split(/\r?\n/)) {
    let visible = "";
    let cursor = 0;
    while (cursor < rawLine.length) {
      if (inComment) {
        const close = rawLine.indexOf("-->", cursor);
        if (close < 0) {
          cursor = rawLine.length;
          continue;
        }
        inComment = false;
        cursor = close + 3;
        continue;
      }
      const open = rawLine.indexOf("<!--", cursor);
      if (open < 0) {
        visible += rawLine.slice(cursor);
        break;
      }
      visible += rawLine.slice(cursor, open);
      inComment = true;
      cursor = open + 4;
    }
    lines.push(visible);
  }
  return lines;
}

function validateDeltaTemplate(path, content) {
  const errors = [];
  const deltaLines = markdownCommentFreeLines(content).filter((line) => line.includes("__DELTA__:"));
  const strictLine = /^__DELTA__:\s*([^\s|](?:[^|\r\n]*[^\s|])?)\s*\|\s*([012])\s*\|\s*(\S(?:[^\r\n]*\S)?)\s*$/;
  let hasCanonicalTemplate = false;
  for (const line of deltaLines) {
    const candidate = line.slice(line.indexOf("__DELTA__:")).replaceAll("`", "").trim();
    if (!candidate.includes("|")) continue;
    if (strictLine.test(candidate)) hasCanonicalTemplate = true;
    else errors.push(`${path} documents a non-copyable DELTA template: ${candidate}`);
  }
  if (!hasCanonicalTemplate) errors.push(`${path} is missing a copyable __DELTA__: <agent> | <single 0/1/2 score> | <evidence> example`);
  return errors;
}

async function probeDeltaHooks(hookPaths, registryPath) {
  const corpus = {
    valid_zero: "__DELTA__: 烛(Codex) | 0 | evidence(file.py:1)",
    valid_one: "header\n__DELTA__: 织 | 1 | evidence with spaces\n",
    valid_pipe_evidence: "__DELTA__: 鉴 | 2 | evidence A | evidence B",
    valid_tab_spacing: "__DELTA__:\t烛\t|\t1\t|\tevidence",
    valid_trailing_space: "__DELTA__: 烛 | 2 | evidence   ",
    mixed_valid_invalid: "__DELTA__: 烛 | 1 | evidence\n__DELTA__: 织 | 2推翻 | bad",
    labeled_score: "__DELTA__: 烛(Codex) | 1补强 | evidence",
    shorthand_score: "__DELTA__: 烛(Codex) | 0/1/2 | evidence",
    out_of_range: "__DELTA__: 烛(Codex) | 3 | evidence",
    double_digit_score: "__DELTA__: 烛(Codex) | 10 | evidence",
    decimal_score: "__DELTA__: 烛(Codex) | 1.0 | evidence",
    empty_agent: "__DELTA__:  | 1 | evidence",
    pipe_in_agent: "__DELTA__: 烛 | reviewer | 1 | evidence",
    empty_evidence: "__DELTA__: 烛(Codex) | 1 |   ",
    leading_space: " __DELTA__: 烛(Codex) | 1 | evidence",
    missing: "no ledger here",
  };
  const expected = {
    valid_zero: "valid",
    valid_one: "valid",
    valid_pipe_evidence: "valid",
    valid_tab_spacing: "valid",
    valid_trailing_space: "valid",
    mixed_valid_invalid: "invalid",
    labeled_score: "invalid",
    shorthand_score: "invalid",
    out_of_range: "invalid",
    double_digit_score: "invalid",
    decimal_score: "invalid",
    empty_agent: "invalid",
    pipe_in_agent: "invalid",
    empty_evidence: "invalid",
    leading_space: "missing",
    missing: "missing",
  };
  const session = "session-current";
  const marker = (value) => `<!-- 514cc-session-id: ${value} -->`;
  const mainCases = {
    exact_valid: {
      content: `${marker(session)}\n__DELTA__: 烛(Codex) | 1 | evidence(file.py:1)`,
      transcript: true,
    },
    exact_missing: { content: marker(session), transcript: true },
    exact_malformed: {
      content: `${marker(session)}\n__DELTA__: 烛(Codex) | 1补强 | evidence`,
      transcript: true,
    },
    foreign_malformed: {
      content: `${marker("session-foreign")}\n__DELTA__: 烛(Codex) | 1补强 | evidence`,
      transcript: true,
    },
    conflicting_malformed: {
      content: `${marker(session)}\n${marker("session-foreign")}\n__DELTA__: 烛(Codex) | 1补强 | evidence`,
      transcript: true,
    },
    exact_missing_without_transcript: { content: marker(session), transcript: false },
  };
  const expectedMainCases = {
    exact_valid: 0,
    exact_missing: 2,
    exact_malformed: 2,
    foreign_malformed: 0,
    conflicting_malformed: 0,
    exact_missing_without_transcript: 2,
  };
  const program = `
import importlib.util
import io
import json
import sys
import tempfile
from pathlib import Path

payload = json.load(sys.stdin)

def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def invoke_main(module, data):
    previous_stdin = sys.stdin
    previous_stderr = sys.stderr
    sys.stdin = io.StringIO(json.dumps(data, ensure_ascii=False))
    sys.stderr = io.StringIO()
    try:
        try:
            result = module.main()
        except SystemExit as exc:
            result = exc.code
        return int(result or 0)
    finally:
        sys.stdin = previous_stdin
        sys.stderr = previous_stderr

def run_case(module, case_name, case):
    with tempfile.TemporaryDirectory(prefix="514claude-delta-probe-", dir=payload["tempBase"]) as temporary:
        root = Path(temporary)
        handoff = root / ".ai-shared" / "handoff"
        handoff.mkdir(parents=True)
        (handoff / f"codex-to-all__{case_name}.md").write_text(case["content"], encoding="utf-8")
        data = {"cwd": str(root), "session_id": payload["session"]}
        if case.get("transcript"):
            transcript = root / "transcript.jsonl"
            transcript.write_text('{"timestamp":"2026-07-22T00:00:00Z"}\\n', encoding="utf-8")
            data["transcript_path"] = str(transcript)
        return invoke_main(module, data)

registry = Path(payload["registry"]).resolve()
reports = {}
for name, path in payload["hooks"].items():
    module = load_module(path, f"delta_probe_{name}")
    for symbol in ("HANDOFF_SOURCE_REGISTRY", "SESSION_MARKER_RE", "load_handoff_sources", "handoff_source", "delta_status", "main"):
        if not hasattr(module, symbol):
            raise RuntimeError(f"{name} hook lacks {symbol}")
    declared_registry = Path(module.HANDOFF_SOURCE_REGISTRY).resolve()
    sources = module.load_handoff_sources(registry)
    reports[name] = {
        "declaredRegistry": str(declared_registry),
        "sources": sorted([list(item) for item in sources]),
        "kimiSource": module.handoff_source("kimi-to-all__probe.md", sources),
        "statuses": {key: module.delta_status(value) for key, value in payload["corpus"].items()},
        "mainCases": {key: run_case(module, key, value) for key, value in payload["mainCases"].items()},
    }
print(json.dumps({"registry": str(registry), "reports": reports}, ensure_ascii=False))
`;
  const result = await runPythonProgram(
    program,
    JSON.stringify({ hooks: hookPaths, registry: registryPath, corpus, mainCases, session, tempBase: tmpdir() }),
    { parser: "python-delta-contract", timeoutMs: 20_000 },
  );
  if (!result.ok) return { errors: [result.error || "DELTA hook probe failed"], reports: null };
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return { errors: [`DELTA hook probe returned invalid JSON: ${error.message}`], reports: null };
  }
  const errors = [];
  const reports = parsed?.reports || {};
  for (const [name, report] of Object.entries(reports)) {
    if (report.declaredRegistry !== parsed.registry) errors.push(`${name} hook does not declare the shared handoff registry`);
    if (report.kimiSource !== "kimi-driver") errors.push(`${name} hook does not govern kimi-to- handoffs`);
    if (JSON.stringify(report.statuses) !== JSON.stringify(expected)) {
      errors.push(`${name} hook DELTA grammar is not the strict numeric contract`);
    }
    if (JSON.stringify(report.mainCases) !== JSON.stringify(expectedMainCases)) {
      errors.push(`${name} hook main does not enforce the exact/foreign/conflicting session contract`);
    }
  }
  if (!reports.claude || !reports.codex) errors.push("both Claude and Codex DELTA hooks must be probed");
  if (reports.claude && reports.codex) {
    if (JSON.stringify(reports.claude.sources) !== JSON.stringify(reports.codex.sources)) {
      errors.push("Claude and Codex hooks load different handoff prefix sets");
    }
    if (JSON.stringify(reports.claude.statuses) !== JSON.stringify(reports.codex.statuses)) {
      errors.push("Claude and Codex hooks implement different DELTA grammars");
    }
    if (JSON.stringify(reports.claude.mainCases) !== JSON.stringify(reports.codex.mainCases)) {
      errors.push("Claude and Codex hook main functions implement different session-bound gates");
    }
  }
  return { errors, reports };
}

async function validateHandoffGovernance(repoRoot, moduleDocument) {
  const errors = [];
  const harness = moduleDocument?.harness_hooks;
  const registryRelative = normalizeRepoPath(harness?.handoff_sources);
  if (registryRelative !== EXPECTED_HANDOFF_REGISTRY) {
    errors.push(`module.yaml handoff registry declares ${registryRelative || "missing"}, expected ${EXPECTED_HANDOFF_REGISTRY}`);
  }
  const registryPath = resolve(repoRoot, EXPECTED_HANDOFF_REGISTRY);
  let parsedRegistry = null;
  try {
    parsedRegistry = JSON.parse(await readFile(registryPath, "utf8"));
  } catch (error) {
    errors.push(`cannot load handoff source registry: ${error.message}`);
  }
  const parsed = parseHandoffRegistry(parsedRegistry);
  errors.push(...parsed.errors);
  const actualPrefixes = parsed.entries.map(([prefix]) => prefix);
  const declaredPrefixes = Array.isArray(harness?.required_handoff_prefixes)
    ? harness.required_handoff_prefixes.map(String)
    : [];
  errors.push(...compareExactSets("module.yaml required_handoff_prefixes", declaredPrefixes, actualPrefixes));
  for (const prefix of REQUIRED_HANDOFF_PREFIXES) {
    if (!actualPrefixes.includes(prefix)) errors.push(`handoff source registry is missing required prefix: ${prefix}`);
  }

  const contract = harness?.delta_contract;
  if (JSON.stringify(contract?.scores) !== JSON.stringify([0, 1, 2])) {
    errors.push("module.yaml DELTA scores must be exactly [0, 1, 2]");
  }
  if (contract?.evidence_required !== true) errors.push("module.yaml DELTA evidence_required must be true");
  const hookEntries = Array.isArray(harness?.hooks) ? harness.hooks : [];
  const listedHooks = hookEntries.map((hook) => normalizeRepoPath(hook?.file));
  const hookPaths = {};
  for (const [name, expectedPath] of Object.entries(EXPECTED_DELTA_HOOKS)) {
    const declared = normalizeRepoPath(contract?.hooks?.[name]);
    if (declared !== expectedPath) errors.push(`module.yaml ${name} DELTA hook declares ${declared || "missing"}, expected ${expectedPath}`);
    if (!listedHooks.includes(expectedPath)) errors.push(`harness_hooks.hooks does not register ${expectedPath}`);
    const hookEntry = hookEntries.find((hook) => normalizeRepoPath(hook?.file) === expectedPath);
    if (hookEntry && hookEntry.event !== "Stop") errors.push(`${expectedPath} must be registered for the Stop event`);
    hookPaths[name] = resolve(repoRoot, expectedPath);
  }
  const claudeStopRole = String(hookEntries.find(
    (hook) => normalizeRepoPath(hook?.file) === EXPECTED_DELTA_HOOKS.claude,
  )?.role || "");
  for (const prefix of REQUIRED_HANDOFF_PREFIXES) {
    if (!claudeStopRole.includes(prefix)) errors.push(`Claude stop-gate role omits governed prefix ${prefix}`);
  }
  if (!/(?:缺失|missing)/i.test(claudeStopRole)) errors.push("Claude stop-gate role does not describe missing DELTA enforcement");
  if (!/(?:格式非法|malformed|invalid)/i.test(claudeStopRole)) errors.push("Claude stop-gate role does not describe malformed DELTA enforcement");

  const templateAssets = Array.isArray(contract?.template_assets) ? contract.template_assets : [];
  for (const templateValue of templateAssets) {
    try {
      const asset = safeRepositoryAsset(repoRoot, templateValue);
      errors.push(...validateDeltaTemplate(asset.normalized, await readFile(asset.path, "utf8")));
    } catch (error) {
      errors.push(error.message);
    }
  }
  for (const requiredTemplate of REQUIRED_DELTA_TEMPLATES) {
    if (!templateAssets.map(normalizeRepoPath).includes(requiredTemplate)) {
      errors.push(`module.yaml DELTA template assets are missing ${requiredTemplate}`);
    }
  }

  if (parsedRegistry) {
    const probe = await probeDeltaHooks(hookPaths, registryPath);
    errors.push(...probe.errors);
    if (probe.reports) {
      const expectedEntries = [...parsed.entries].sort((left, right) => {
        const prefixOrder = left[0].localeCompare(right[0]);
        return prefixOrder || left[1].localeCompare(right[1]);
      });
      for (const [name, report] of Object.entries(probe.reports)) {
        if (JSON.stringify(report.sources) !== JSON.stringify(expectedEntries)) {
          errors.push(`${name} hook does not load the complete handoff source registry`);
        }
      }
    }
  }
  return repositoryResult("governance.handoff", errors);
}

async function validateCodexHookRegistry(repoRoot, moduleDocument) {
  const errors = [];
  const expectedPairs = [...REQUIRED_CODEX_HOOKS].map(([file, event]) => hookPair(event, file));
  const declaredHooks = Array.isArray(moduleDocument?.harness_hooks?.hooks)
    ? moduleDocument.harness_hooks.hooks
    : [];
  const declaredPairs = declaredHooks
    .filter((hook) => normalizeRepoPath(hook?.file).startsWith(".codex/hooks/"))
    .map((hook) => hookPair(hook?.event, hook?.file));
  errors.push(...compareExactSets("module.yaml Codex hook registry", declaredPairs, expectedPairs));

  const configPath = resolve(repoRoot, CODEX_HOOK_CONFIG);
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    errors.push(`cannot load ${CODEX_HOOK_CONFIG}: ${error.message}`);
  }

  const actualPairs = [];
  const hookEvents = config?.hooks;
  if (config && (!hookEvents || typeof hookEvents !== "object" || Array.isArray(hookEvents))) {
    errors.push(`${CODEX_HOOK_CONFIG} hooks must be an object`);
  }
  for (const [event, groups] of Object.entries(hookEvents || {})) {
    if (!Array.isArray(groups)) {
      errors.push(`${CODEX_HOOK_CONFIG} event ${event} must be an array`);
      continue;
    }
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) {
        errors.push(`${CODEX_HOOK_CONFIG} event ${event} has a group without a hooks array`);
        continue;
      }
      for (const hook of group.hooks) {
        if (hook?.type !== "command") continue;
        const target = parsePythonHookCommand(hook.command);
        if (!target) continue;
        const file = repositoryRelativePath(repoRoot, target);
        if (file?.startsWith(".codex/hooks/")) actualPairs.push(hookPair(event, file));
      }
    }
  }
  const duplicateActualPairs = duplicateValues(actualPairs);
  if (duplicateActualPairs.length) {
    errors.push(`${CODEX_HOOK_CONFIG} has duplicate 514cc hooks: ${duplicateActualPairs.join(", ")}`);
  }
  errors.push(...compareExactSets(`${CODEX_HOOK_CONFIG} 514cc hooks`, actualPairs, expectedPairs));
  errors.push(...compareExactSets("module.yaml versus .codex/hooks.json", declaredPairs, actualPairs));

  for (const file of REQUIRED_CODEX_HOOKS.keys()) {
    try {
      await readFile(resolve(repoRoot, file), "utf8");
    } catch (error) {
      errors.push(`cannot load registered Codex hook ${file}: ${error.message}`);
    }
  }
  return repositoryResult("governance.hooks", errors);
}

export async function validateRepositoryTruth(repoRoot) {
  let moduleDocument;
  try {
    moduleDocument = await parseYamlDocument(await readFile(resolve(repoRoot, "module.yaml"), "utf8"));
  } catch (error) {
    return [repositoryResult("registry.module", [`cannot parse module.yaml: ${error.message}`])];
  }
  const validators = [
    ["registry.skills", () => validateSkillRegistry(repoRoot, moduleDocument)],
    ["registry.adapters", () => validateAdapterRegistry(repoRoot, moduleDocument)],
    ["registry.plugin", () => validatePluginManifest(repoRoot)],
    ["registry.customize", () => validateCustomizeLayers(repoRoot, moduleDocument)],
    ["registry.models", () => validateModelWiring(repoRoot)],
    ["framework.version", () => validateVersionSurfaces(repoRoot, moduleDocument)],
    ["runtime.contracts", () => validateRuntimeContracts(repoRoot, moduleDocument)],
    ["governance.handoff", () => validateHandoffGovernance(repoRoot, moduleDocument)],
    ["governance.hooks", () => validateCodexHookRegistry(repoRoot, moduleDocument)],
  ];
  return Promise.all(validators.map(async ([id, validate]) => {
    try {
      return await validate();
    } catch (error) {
      return repositoryResult(id, [error.message]);
    }
  }));
}

export async function validateContent(source, content) {
  const errors = [];
  const warnings = [];
  if (typeof content !== "string") errors.push("content must be a string");
  if (typeof content === "string" && Buffer.byteLength(content, "utf8") > MAX_CONFIG_BYTES) {
    errors.push(`content exceeds ${MAX_CONFIG_BYTES} bytes`);
  }
  if (typeof content === "string" && content.includes("\0")) errors.push("NUL bytes are not allowed");
  if (errors.length) return { valid: false, errors, warnings, parser: "preflight" };

  let parser = source.kind;
  if (source.kind === "json") {
    try {
      const parsed = JSON.parse(content);
      parser = "JSON.parse";
      const result = await validateControlSchema(source, parsed);
      parser = result.parser;
      if (!result.ok) errors.push(result.error);
    } catch (error) {
      errors.push(error.message);
    }
  } else if (source.kind === "yaml" && source.id === MODULE_SOURCE_ID) {
    const result = await validateModuleSchema(source, content);
    parser = result.parser;
    if (!result.ok) errors.push(result.error);
  } else if (["yaml", "toml", "python"].includes(source.kind)) {
    const result = await runPythonValidator(source.kind, content);
    parser = result.parser;
    if (!result.ok) errors.push(result.error);
  } else if (source.kind === "markdown") {
    const opens = content.match(/<frozen-after-approval(?:\s[^>]*)?>/g)?.length || 0;
    const closes = content.match(/<\/frozen-after-approval>/g)?.length || 0;
    if (opens !== closes) errors.push("unbalanced frozen-after-approval markers");
    if (!content.trim()) warnings.push("document is empty");
    parser = "markdown-guards";
  }

  const secretCandidates = findSecretCandidates(content);
  if (secretCandidates.length) errors.push(...secretCandidates);
  return { valid: errors.length === 0, errors, warnings, parser };
}
