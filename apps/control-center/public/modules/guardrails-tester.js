/**
 * guardrails-tester.js — W3.7 Guardrails 测试器
 *
 * 自初始化：挂载到观测视图 #guardrails-tester-root（容器不存在时静默跳过）。
 * 数据源（只读）：
 *   GET  /api/guardrails/rules → { source, count, rules: [{ kind, pattern }] }
 *   POST /api/guardrails/test  → { path, denied, matchedRules, evaluatedRules }
 * 用途：改权限/动文件前预览 deny-paths 命中；不替代运行时守卫，判定以服务端为准。
 */

import { lucideIcon } from "../lucide.js";
import { escapeHtml } from "../utils.js";
import { request as apiRequest, apiReady } from "../api.js";

const TEST_DEBOUNCE_MS = 300;

let _root = null;
let _inputEl = null;
let _resultEl = null;
let _metaEl = null;
let _rulesCount = null;
let _rulesError = "";
let _testTimer = 0;
let _testSeq = 0;

function shell() {
  return `<section class="grt" aria-label="Guardrails 测试器">
    <div class="grt-head">
      <span class="grt-icon">${lucideIcon("shield-alert")}</span>
      <div class="grt-title"><strong>Guardrails 测试器</strong><span data-grt-meta>加载 deny-paths 规则…</span></div>
    </div>
    <div class="grt-row">
      <input class="grt-input" type="text" data-grt-input
        placeholder="输入路径，如 ~/.ssh/id_rsa 或 C:\\Windows\\system32\\config.sys"
        aria-label="待测路径" spellcheck="false" autocomplete="off" />
      <button class="grt-btn" type="button" data-grt-test>测试</button>
    </div>
    <div class="grt-result" data-grt-result hidden></div>
  </section>`;
}

function renderMeta() {
  if (!_metaEl) return;
  if (_rulesError) {
    _metaEl.textContent = _rulesError;
    return;
  }
  _metaEl.textContent = _rulesCount === null
    ? "加载 deny-paths 规则…"
    : `deny-paths 共 ${_rulesCount} 条规则 · 实时预览，判定以服务端为准`;
}

function renderResult(outcome) {
  if (!_resultEl) return;
  _resultEl.hidden = false;
  if (outcome.error) {
    _resultEl.className = "grt-result is-error";
    _resultEl.innerHTML = `<strong>测试失败</strong><span>${escapeHtml(outcome.error)}</span>`;
    return;
  }
  const rules = Array.isArray(outcome.matchedRules) ? outcome.matchedRules : [];
  const ruleList = rules.length
    ? rules.map((rule) => `<li><code>${escapeHtml(rule.pattern)}</code><span>${rule.kind === "glob" ? "glob" : "前缀"}</span></li>`).join("")
    : "";
  if (outcome.denied) {
    _resultEl.className = "grt-result is-denied";
    _resultEl.innerHTML = `<strong>${lucideIcon("shield-alert")} 将被拒绝（命中 ${rules.length} 条）</strong><ul>${ruleList}</ul>`;
  } else {
    _resultEl.className = "grt-result is-allowed";
    _resultEl.innerHTML = `<strong>${lucideIcon("shield-check")} 未命中规则</strong><span>已对照 ${escapeHtml(String(outcome.evaluatedRules ?? 0))} 条规则，均不匹配。</span>`;
  }
}

async function runTest(path) {
  const seq = ++_testSeq;
  try {
    const outcome = await apiRequest("/api/guardrails/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (seq !== _testSeq || !_resultEl) return;
    renderResult(outcome);
  } catch (error) {
    if (seq !== _testSeq || !_resultEl) return;
    renderResult({ error: error?.message || "请求失败" });
  }
}

function scheduleTest(path) {
  if (_testTimer) clearTimeout(_testTimer);
  _testTimer = setTimeout(() => {
    _testTimer = 0;
    if (path) void runTest(path);
    else if (_resultEl) _resultEl.hidden = true;
  }, TEST_DEBOUNCE_MS);
}

async function loadRules() {
  try {
    const payload = await apiRequest("/api/guardrails/rules");
    _rulesCount = payload?.available === false ? null : (Number(payload?.count) || 0);
    _rulesError = payload?.available === false ? "deny-paths.txt 不可读——命中预览不可用（未知≠安全）" : "";
  } catch (error) {
    _rulesCount = null;
    _rulesError = `规则加载失败：${error?.message || "未知错误"}`;
  }
  renderMeta();
}

/** 挂载并初始化（幂等）。容器不存在时返回 false。 */
export function initGuardrailsTester(container) {
  if (!container || container.dataset.grtReady === "1") return Boolean(container);
  container.dataset.grtReady = "1";
  _root = container;
  container.innerHTML = shell();
  _inputEl = container.querySelector("[data-grt-input]");
  _resultEl = container.querySelector("[data-grt-result]");
  _metaEl = container.querySelector("[data-grt-meta]");
  container.querySelector("[data-grt-test]")?.addEventListener("click", () => {
    const path = _inputEl?.value?.trim();
    if (path) void runTest(path);
  });
  _inputEl?.addEventListener("input", () => scheduleTest(_inputEl.value.trim()));
  _inputEl?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const path = _inputEl.value.trim();
      if (path) void runTest(path);
    }
  });
  renderMeta();
  void loadRules();
  return true;
}

if (typeof document !== "undefined") {
  void apiReady.then(() => initGuardrailsTester(document.getElementById("guardrails-tester-root")));
}
