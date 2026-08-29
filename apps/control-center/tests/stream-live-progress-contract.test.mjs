import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

async function source(path) {
  // Windows 工作区源码是 CRLF：统一归一化为 LF（同 codex-process-visibility）
  return (await readFile(`${root}/${path}`, "utf8")).replace(/\r\n/g, "\n");
}

// 源文件正则断言失败会把整份文件打进输出——一律用 includes 断言字面片段
function assertIncludes(source, snippet, message) {
  assert.ok(source.includes(snippet), message ?? `缺少：${snippet}`);
}

// 收敛层·第五轮（2026-08-17）：Codex 桌面参考图的「运行了命令…」转圈行与
// 「第 1/4 步 · 2 个文件已更改 +150 −24」进度条。数据面（codex item/started/completed
// 结构化 progress）早已在 SSE 流里，本轮是前端渲染层补全。
test("live process rows render from codexActivity started entries", async () => {
  const app = await source("public/app.js");
  assertIncludes(app, "function codexLiveActivities(runId)");
  assertIncludes(app, "function liveProcessRowsMarkup(run)");
  // 只接 command/file；reasoning 归呼吸行「正在思考」，一活不两显
  assertIncludes(app, 'entry.progress.kind === "command" || entry.progress.kind === "file"');
  // 等的是人（审批/恢复/问答）时不挂转圈假活
  assertIncludes(app, 'if (run.status === "waiting_approval" || run.status === "recovery_required" || run.pendingAsk) return ""; // 等的是人：在途 item 已暂停，不挂转圈假活');
  assertIncludes(app, 'data-stream-key="tail:live-items"');
  assertIncludes(app, 'lucideIcon("loader-circle", "icon forge-spin", 13)');
  // 行内时长复用秒级走时（tickLiveElapsed），不靠重渲
  assertIncludes(app, 'data-live-since="${escapeHtml(entry.since)}"');
});

test("breathing line stops duplicating command/file activity", async () => {
  const app = await source("public/app.js");
  assertIncludes(app, "const latestActivity = codexLiveActivities(run.id).at(-1);");
  assertIncludes(app, 'const activity = latestActivity?.progress.kind === "reasoning" ? "正在思考" : "";');
  // 既有契约锚点不动：reasoning 文案仍在 codexActivityText 里
  assertIncludes(app, 'if (entry.progress.kind === "reasoning") return "正在思考";');
});

test("turn progress bar: step counter + per-interaction file stats", async () => {
  const app = await source("public/app.js");
  assertIncludes(app, "function turnProgressMarkup(run)");
  assertIncludes(app, "function trackTurnFileStats(event)");
  // 步进口径与顶栏 meta 同源
  assertIncludes(app, "run.maxStepsPerInteraction ?? run.maxRounds");
  // 累加器重置/清账：新交互（user.message）与 run 收尾
  assertIncludes(app, 'if (event.type === "user.message" || /^run\\.(completed|failed|cancelled)$/.test(event.type)) {');
  // 只收 completed 的 file progress，数行复用 diffLineStats（不造第二份）
  assertIncludes(app, 'if (progress?.kind !== "file" || !Array.isArray(progress.changes)) return false;');
  assertIncludes(app, "const lines = diffLineStats(change.diff);");
  assertIncludes(app, 'data-stream-key="tail:progress"');
  // 无步进且无文件段时整条不渲染
  assertIncludes(app, 'if (!stepText && !fileCount) return "";');
});

test("tail assembly and pushEvent wiring", async () => {
  const app = await source("public/app.js");
  assertIncludes(
    app,
    "const tailMarkup = newerGate + liveProcessRowsMarkup(run) + turnProgressMarkup(run) + liveTurnMarkup(run)",
  );
  assertIncludes(app, "trackTurnFileStats(event); // 进行态文件变更累加");
});

test("console-form wave-5 styles present, centering discipline kept", async () => {
  const css = await source("public/forge/console-form.css");
  assertIncludes(css, ".live-process-row {");
  assertIncludes(css, ".turn-progress > summary {");
  assertIncludes(css, ".turn-progress[open] .turn-progress-caret {");
  assertIncludes(css, ".turn-progress-files {");
  // 第四轮居中教训：这两个类是会话流直接子级，inline 方向必须留给 margin-inline:auto，
  // 只能调 margin-block——margin-left/right:0 会静默击穿居中（.gov-note 破口同款）
  assertIncludes(css, ".live-process-rows {\n  margin-block: 2px;\n}");
  assertIncludes(css, ".turn-progress {\n  margin-block: 2px;");
  const wave5 = css.slice(css.indexOf("收敛层·第五轮"));
  assert.ok(!/\.(live-process-rows|turn-progress)\s*\{[^}]*margin-(left|right|inline)/.test(wave5),
    "live-process-rows/turn-progress 不允许设 inline 方向 margin（会盖掉居中 auto）");
});

test("wave-5 icon references exist in the lucide manifest", async () => {
  const manifest = JSON.parse(await source("public/lucide-icons.json"));
  const names = new Set((manifest.icons ?? []).map((icon) => icon.name ?? icon));
  for (const name of ["loader-circle", "chevron-right", "file-pen-line", "terminal"]) {
    assert.ok(names.has(name), `lucide manifest 缺少 ${name}`);
  }
});

test("context compaction is visible in the session stream and live turn", async () => {
  const app = await source("public/app.js");
  assertIncludes(app, '"run.context_compaction_started"');
  assertIncludes(app, '"run.context_compaction_completed"');
  assertIncludes(app, '"run.context_compaction_failed"');
  assertIncludes(app, "正在压缩上下文，请勿中断");
  assertIncludes(app, "function trackContextCompaction(event)");
  assertIncludes(app, '"assistant.partial_message"');
  assertIncludes(app, "本轮异常中止");
});
