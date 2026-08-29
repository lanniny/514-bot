/**
 * office-panel.js — 文档工坊：类型卡 + 章节编辑 + 模板带正文 + dryRun 计划 → 落盘。
 */
import { request, requestBlob, apiReady } from "./api.js";
import { lucideIcon } from "./lucide.js";

const KIND_META = {
  docx: { icon: "file-text", label: "Word 文档", blurb: "标题、章节、段落，可选表格。" },
  xlsx: { icon: "grid-2x2", label: "Excel 表格", blurb: "多张表，列名和行数据都能改。" },
  pptx: { icon: "layout-dashboard", label: "PPT 演示", blurb: "幻灯片标题、要点和备注。" },
};

const state = {
  kind: "docx",
  title: "未命名文档",
  fileName: "",
  draft: emptyDraft("docx", "未命名文档"),
  templates: [],
  history: [],
  historyFilter: "all",
  templateId: "",
  pendingPlan: null,
  lastResult: null,
  inspect: null,
  force: false,
  busy: false,
  error: "",
  gateError: null,
};

function esc(text) {
  return String(text ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function emptyDraft(kind, title) {
  if (kind === "docx") {
    return { sections: [{ heading: "概述", paragraphsText: "", tableText: "" }] };
  }
  if (kind === "xlsx") {
    return { sheets: [{ name: "汇总", columnsText: "项目, 数值", rowsText: "" }] };
  }
  return { slides: [{ title: title || "标题页", bulletsText: "", notes: "" }] };
}

function draftFromSpec(kind, spec, title) {
  if (kind === "docx") {
    const sections = (spec?.sections ?? []).map((section) => ({
      heading: section.heading || "",
      paragraphsText: (section.paragraphs ?? []).join("\n"),
      tableText: (section.table?.rows ?? []).map((row) => (Array.isArray(row) ? row : [row]).join(" | ")).join("\n"),
    }));
    return { sections: sections.length ? sections : emptyDraft("docx").sections };
  }
  if (kind === "xlsx") {
    const sheets = (spec?.sheets ?? []).map((sheet) => ({
      name: sheet.name || "Sheet1",
      columnsText: (sheet.columns ?? []).map((column) => column?.header ?? column ?? "").join(", "),
      rowsText: (sheet.rows ?? []).map((row) => (Array.isArray(row) ? row : [row]).join(" | ")).join("\n"),
    }));
    return { sheets: sheets.length ? sheets : emptyDraft("xlsx").sheets };
  }
  const slides = (spec?.slides ?? []).map((slide) => ({
    title: slide.title || "",
    bulletsText: (slide.bullets ?? []).join("\n"),
    notes: slide.notes || "",
  }));
  return { slides: slides.length ? slides : emptyDraft("pptx", title).slides };
}

function splitCells(line) {
  return String(line).split("|").map((cell) => cell.trim());
}

function compactSpec() {
  const title = state.title.trim() || "未命名文档";
  if (state.kind === "docx") {
    const sections = state.draft.sections.map((section) => {
      const paragraphs = section.paragraphsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const rows = section.tableText.split(/\r?\n/).map(splitCells).filter((row) => row.some(Boolean));
      return {
        heading: section.heading.trim(),
        paragraphs,
        ...(rows.length ? { table: { rows } } : {}),
      };
    }).filter((section) => section.heading || section.paragraphs.length || section.table);
    return { title, sections };
  }
  if (state.kind === "xlsx") {
    const sheets = state.draft.sheets.map((sheet) => ({
      name: sheet.name.trim() || "Sheet1",
      columns: sheet.columnsText.split(/[,，]/).map((header) => header.trim()).filter(Boolean).map((header) => ({ header })),
      rows: sheet.rowsText.split(/\r?\n/).map(splitCells).filter((row) => row.some(Boolean)),
    })).filter((sheet) => sheet.columns.length || sheet.rows.length || sheet.name);
    return { sheets };
  }
  return {
    title,
    slides: state.draft.slides.map((slide) => ({
      title: slide.title.trim() || title,
      bullets: slide.bulletsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      notes: slide.notes.trim(),
    })),
  };
}

function readIdentity(root) {
  state.title = root.querySelector("#office-title")?.value?.trim() || "未命名文档";
  state.fileName = root.querySelector("#office-filename")?.value?.trim() || "";
}

function syncDraft(root) {
  if (state.kind === "docx") {
    state.draft.sections.forEach((section, index) => {
      section.heading = root.querySelector(`[data-office-heading="${index}"]`)?.value ?? section.heading;
      section.paragraphsText = root.querySelector(`[data-office-paragraphs="${index}"]`)?.value ?? section.paragraphsText;
      section.tableText = root.querySelector(`[data-office-table="${index}"]`)?.value ?? section.tableText;
    });
    return;
  }
  if (state.kind === "xlsx") {
    state.draft.sheets.forEach((sheet, index) => {
      sheet.name = root.querySelector(`[data-office-sheet="${index}"]`)?.value ?? sheet.name;
      sheet.columnsText = root.querySelector(`[data-office-columns="${index}"]`)?.value ?? sheet.columnsText;
      sheet.rowsText = root.querySelector(`[data-office-rows="${index}"]`)?.value ?? sheet.rowsText;
    });
    return;
  }
  state.draft.slides.forEach((slide, index) => {
    slide.title = root.querySelector(`[data-office-slide="${index}"]`)?.value ?? slide.title;
    slide.bulletsText = root.querySelector(`[data-office-bullets="${index}"]`)?.value ?? slide.bulletsText;
    slide.notes = root.querySelector(`[data-office-notes="${index}"]`)?.value ?? slide.notes;
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function formatWhen(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toLocaleString("zh-CN", { hour12: false });
}

// latest-wins 门闩：启动引导与视图进入两条路径都会触发 refresh，旧响应不得覆盖新状态（同 market-panel 的 generation 惯例）
let refreshGeneration = 0;
async function refresh(root) {
  const generation = ++refreshGeneration;
  try {
    const [templates, history] = await Promise.all([
      request("/api/office/templates"),
      request("/api/office/history"),
    ]);
    if (generation !== refreshGeneration) return;
    state.templates = templates?.templates ?? [];
    state.history = history?.items ?? [];
    state.gateError = null;
  } catch (error) {
    if (generation !== refreshGeneration) return;
    if (/REMOTE_GATE/.test(error.message || "")) {
      state.gateError = error;
    } else {
      state.error = error.message;
    }
  }
  render(root);
}

function render(root) {
  if (state.gateError) {
    root.innerHTML = `
      <div class="office-empty">
        ${lucideIcon("lock", "icon lucide")}
        <h2>文档工坊门闸未开放</h2>
        <p>${esc(state.gateError.message)}</p>
      </div>`;
    return;
  }
  const meta = KIND_META[state.kind];
  const history = state.historyFilter === "all"
    ? state.history
    : state.history.filter((item) => item.kind === state.historyFilter);
  root.innerHTML = `
    <section class="office-deck">
      <div class="office-deck-head">
        <div>
          <h2>写一份能拿走的文件</h2>
          <p class="office-deck-lead">模板会带上章节正文。生成计划只预览，确认后才写到 output-docs/。</p>
        </div>
      </div>
      <div class="office-kind-grid" role="tablist" aria-label="文档类型">
        ${Object.entries(KIND_META).map(([kind, item]) => `
          <button type="button" class="office-kind-card${state.kind === kind ? " is-active" : ""}" data-office-kind="${kind}" role="tab" aria-selected="${state.kind === kind}">
            <span class="office-kind-icon">${lucideIcon(item.icon, "icon lucide")}</span>
            <strong>${item.label}</strong>
            <span>${item.blurb}</span>
          </button>`).join("")}
      </div>
      <div class="office-wizard">
        <div class="office-form">
          <label class="office-field">标题
            <input class="input" id="office-title" type="text" maxlength="80" value="${esc(state.title)}" />
          </label>
          <label class="office-field">文件名
            <input class="input" id="office-filename" type="text" maxlength="80" placeholder="留空则按标题生成，中文会保留" value="${esc(state.fileName)}" />
          </label>
          ${renderEditor()}
          <div class="office-form-actions">
            <button type="button" class="button button-primary" id="office-plan" ${state.busy ? "disabled" : ""}>
              ${lucideIcon("clipboard-list", "icon lucide")} ${state.busy ? "处理中…" : "生成计划"}
            </button>
            <button type="button" class="button" id="office-reset" ${state.busy ? "disabled" : ""}>清空正文</button>
          </div>
          ${state.error ? `<p class="office-form-msg is-error">${esc(state.error)}</p>` : `<p class="office-form-msg">${meta.blurb}</p>`}
          <div id="office-plan-result">${renderResult()}</div>
        </div>
        <aside class="office-guide">
          <h3>${lucideIcon("eye", "icon lucide")} 将写入</h3>
          ${renderOutline(compactSpec())}
        </aside>
      </div>
    </section>

    <div class="office-section-head">
      <h2 class="waveg-section-title">${lucideIcon("book-open", "icon lucide")} 模板</h2>
    </div>
    <div class="office-template-grid">
      ${state.templates.map((template) => `
        <article class="office-template${state.templateId === template.id ? " is-active" : ""}">
          <div class="waveg-card-head">
            ${lucideIcon(KIND_META[template.kind]?.icon ?? "file-text", "icon lucide")}
            <h3>${esc(template.title)}</h3>
            <span class="waveg-badge">${template.kind}</span>
          </div>
          <p class="subtle">${esc(template.blurb || "点一下，章节会填进左边。")}</p>
          <div class="waveg-card-actions">
            <button type="button" class="button" data-office-template="${esc(template.id)}">${lucideIcon("play", "icon lucide")} 用此模板</button>
          </div>
        </article>`).join("") || `<p class="subtle">模板读取失败或为空。</p>`}
    </div>

    <div class="office-section-head">
      <h2 class="waveg-section-title">${lucideIcon("history", "icon lucide")} 生成历史 <span class="office-count">${history.length}</span></h2>
      <div class="office-filter" role="group" aria-label="历史筛选">
        ${["all", "docx", "xlsx", "pptx"].map((key) => `
          <button type="button" class="office-filter-btn${state.historyFilter === key ? " is-active" : ""}" data-history-filter="${key}">${key === "all" ? "全部" : key}</button>`).join("")}
      </div>
    </div>
    <div class="office-history">
      ${history.map((item) => `
        <article class="office-history-card">
          <div class="waveg-card-head">
            ${lucideIcon(KIND_META[item.kind]?.icon ?? "file-text", "icon lucide")}
            <h3>${esc(item.fileName || item.path?.split(/[\\/]/).pop() || item.kind)}</h3>
            <span class="waveg-badge is-on">${((item.bytes || 0) / 1024).toFixed(1)} KB</span>
          </div>
          <dl class="waveg-kv">
            ${item.title ? `<dt>标题</dt><dd>${esc(item.title)}</dd>` : ""}
            <dt>时间</dt><dd>${esc(formatWhen(item.at))}</dd>
          </dl>
          <div class="waveg-card-actions">
            <button type="button" class="button" data-office-download="${esc(item.path)}">${lucideIcon("download", "icon lucide")} 下载</button>
            <button type="button" class="button" data-office-reveal="${esc(item.path)}">${lucideIcon("folder-open", "icon lucide")} 打开位置</button>
            <button type="button" class="button" data-office-copy="${esc(item.path)}">${lucideIcon("copy", "icon lucide")} 复制路径</button>
            <button type="button" class="button" data-office-inspect="${esc(item.path)}">${lucideIcon("scan-search", "icon lucide")} 检查结构</button>
          </div>
        </article>`).join("") || `<div class="office-empty"><p>还没有生成记录。左边写完，确认落盘后会出现在这里。</p></div>`}
    </div>
    <div id="office-inspect-result">${renderInspect()}</div>`;

  bind(root);
}

function renderEditor() {
  if (state.kind === "docx") {
    return `
      <div class="office-blocks">
        ${state.draft.sections.map((section, index) => `
          <article class="office-block">
            <div class="office-block-head">
              <strong>章节 ${index + 1}</strong>
              <button type="button" class="button" data-office-remove="section:${index}" ${state.draft.sections.length === 1 ? "disabled" : ""}>${lucideIcon("trash-2", "icon lucide")} 删除</button>
            </div>
            <label class="office-field">小标题<input class="input" data-office-heading="${index}" type="text" value="${esc(section.heading)}" /></label>
            <label class="office-field">段落（一行一段）<textarea class="input office-textarea" data-office-paragraphs="${index}" rows="3">${esc(section.paragraphsText)}</textarea></label>
            <label class="office-field">表格（可选，用 | 分列）<textarea class="input office-textarea" data-office-table="${index}" rows="3" placeholder="指标 | 本周">${esc(section.tableText)}</textarea></label>
          </article>`).join("")}
        <button type="button" class="button" id="office-add-block">${lucideIcon("plus", "icon lucide")} 加一节</button>
      </div>`;
  }
  if (state.kind === "xlsx") {
    return `
      <div class="office-blocks">
        ${state.draft.sheets.map((sheet, index) => `
          <article class="office-block">
            <div class="office-block-head">
              <strong>工作表 ${index + 1}</strong>
              <button type="button" class="button" data-office-remove="sheet:${index}" ${state.draft.sheets.length === 1 ? "disabled" : ""}>${lucideIcon("trash-2", "icon lucide")} 删除</button>
            </div>
            <label class="office-field">表名<input class="input" data-office-sheet="${index}" type="text" maxlength="31" value="${esc(sheet.name)}" /></label>
            <label class="office-field">列名（逗号分隔）<input class="input" data-office-columns="${index}" type="text" value="${esc(sheet.columnsText)}" /></label>
            <label class="office-field">行（用 | 分列）<textarea class="input office-textarea" data-office-rows="${index}" rows="4" placeholder="示例 | 42">${esc(sheet.rowsText)}</textarea></label>
          </article>`).join("")}
        <button type="button" class="button" id="office-add-block">${lucideIcon("plus", "icon lucide")} 加一张表</button>
      </div>`;
  }
  return `
    <div class="office-blocks">
      ${state.draft.slides.map((slide, index) => `
        <article class="office-block">
          <div class="office-block-head">
            <strong>第 ${index + 1} 页</strong>
            <button type="button" class="button" data-office-remove="slide:${index}" ${state.draft.slides.length === 1 ? "disabled" : ""}>${lucideIcon("trash-2", "icon lucide")} 删除</button>
          </div>
          <label class="office-field">页标题<input class="input" data-office-slide="${index}" type="text" value="${esc(slide.title)}" /></label>
          <label class="office-field">要点（一行一条）<textarea class="input office-textarea" data-office-bullets="${index}" rows="3">${esc(slide.bulletsText)}</textarea></label>
          <label class="office-field">备注<textarea class="input office-textarea" data-office-notes="${index}" rows="2">${esc(slide.notes)}</textarea></label>
        </article>`).join("")}
      <button type="button" class="button" id="office-add-block">${lucideIcon("plus", "icon lucide")} 加一页</button>
    </div>`;
}

function renderOutline(spec) {
  if (state.kind === "docx") {
    const sections = spec.sections ?? [];
    if (!sections.length) return `<p class="subtle">还没有章节。左边写一节，或用模板。</p>`;
    return `<ol class="office-outline">${sections.map((section) => `<li><strong>${esc(section.heading || "未命名章节")}</strong><span>${section.paragraphs.length} 段${section.table ? ` · 表 ${section.table.rows.length} 行` : ""}</span></li>`).join("")}</ol>`;
  }
  if (state.kind === "xlsx") {
    const sheets = spec.sheets ?? [];
    if (!sheets.length) return `<p class="subtle">还没有工作表。</p>`;
    return `<ol class="office-outline">${sheets.map((sheet) => `<li><strong>${esc(sheet.name)}</strong><span>${sheet.columns.length} 列 · ${sheet.rows.length} 行</span></li>`).join("")}</ol>`;
  }
  const slides = spec.slides ?? [];
  if (!slides.length) return `<p class="subtle">还没有幻灯片。</p>`;
  return `<ol class="office-outline">${slides.map((slide) => `<li><strong>${esc(slide.title)}</strong><span>${slide.bullets.length} 条要点${slide.notes ? " · 有备注" : ""}</span></li>`).join("")}</ol>`;
}

function renderResult() {
  if (state.pendingPlan) {
    const plan = state.pendingPlan.plan;
    return `
      <div class="office-review">
        <strong>${lucideIcon("clipboard-list", "icon lucide")} 创建计划</strong>
        <dl class="waveg-kv">
          <dt>类型</dt><dd>${esc(plan.kind)}</dd>
          <dt>文件</dt><dd>${esc(plan.fileName)}</dd>
          <dt>落点</dt><dd>${esc(plan.path)}</dd>
        </dl>
        ${renderPlanOutline(plan.outline)}
        <label class="office-force"><input type="checkbox" id="office-force" ${state.force ? "checked" : ""} /> 若同名文件已在，覆盖写入</label>
        <div class="office-form-actions">
          <button type="button" class="button button-primary" id="office-confirm">${lucideIcon("check", "icon lucide")} 确认落盘</button>
          <button type="button" class="button" id="office-cancel">取消</button>
        </div>
      </div>`;
  }
  if (state.lastResult) {
    const plan = state.lastResult.plan;
    return `
      <div class="office-review is-done">
        <strong>${lucideIcon("circle-check", "icon lucide")} 已生成</strong>
        <dl class="waveg-kv">
          <dt>文件</dt><dd>${esc(plan.fileName)}</dd>
          <dt>大小</dt><dd>${((plan.bytes || 0) / 1024).toFixed(1)} KB</dd>
        </dl>
        <div class="office-form-actions">
          <button type="button" class="button button-primary" data-office-download="${esc(plan.path)}">${lucideIcon("download", "icon lucide")} 下载</button>
          <button type="button" class="button" data-office-reveal="${esc(plan.path)}">${lucideIcon("folder-open", "icon lucide")} 打开位置</button>
          <button type="button" class="button" data-office-copy="${esc(plan.path)}">${lucideIcon("copy", "icon lucide")} 复制路径</button>
        </div>
      </div>`;
  }
  return "";
}

function renderPlanOutline(outline) {
  if (!outline) return "";
  if (outline.sections) {
    return `<ol class="office-outline">${outline.sections.map((section) => `<li>${esc(section.heading || "未命名")} · ${section.paragraphs} 段${section.tableRows ? ` · 表 ${section.tableRows} 行` : ""}</li>`).join("")}</ol>`;
  }
  if (outline.sheets) {
    return `<ol class="office-outline">${outline.sheets.map((sheet) => `<li>${esc(sheet.name)} · ${sheet.columns} 列 · ${sheet.rows} 行</li>`).join("")}</ol>`;
  }
  if (outline.slides) {
    return `<ol class="office-outline">${outline.slides.map((slide) => `<li>${esc(slide.title || "未命名")} · ${slide.bullets} 条要点</li>`).join("")}</ol>`;
  }
  return "";
}

function renderInspect() {
  if (!state.inspect) return "";
  const summary = state.inspect;
  const detail = summary.kind === "xlsx"
    ? (summary.sheets ?? []).map((sheet) => `${sheet.name}（${sheet.rows} 行 × ${sheet.columns} 列）`).join("、")
    : summary.kind === "docx"
      ? `${summary.paragraphs} 个段落 · ${summary.tables} 张表`
      : `${summary.slides} 页幻灯片`;
  return `
    <div class="office-review">
      <strong>${lucideIcon("scan-search", "icon lucide")} 结构摘要</strong>
      <dl class="waveg-kv">
        <dt>文件</dt><dd>${esc(summary.fileName || summary.path)}</dd>
        <dt>内容</dt><dd>${esc(detail)}</dd>
        <dt>大小</dt><dd>${((summary.bytes || 0) / 1024).toFixed(1)} KB</dd>
      </dl>
    </div>`;
}

function bind(root) {
  root.querySelectorAll("[data-office-kind]").forEach((button) => {
    button.addEventListener("click", () => {
      syncDraft(root);
      readIdentity(root);
      const kind = button.dataset.officeKind;
      if (kind === state.kind) return;
      state.kind = kind;
      state.templateId = "";
      state.draft = emptyDraft(kind, state.title);
      state.pendingPlan = null;
      render(root);
    });
  });
  root.querySelector("#office-title")?.addEventListener("input", (event) => {
    state.title = event.currentTarget.value;
    const guide = root.querySelector(".office-guide");
    if (guide) guide.innerHTML = `<h3>${lucideIcon("eye", "icon lucide")} 将写入</h3>${renderOutline(compactSpec())}`;
  });
  root.querySelector("#office-filename")?.addEventListener("input", (event) => {
    state.fileName = event.currentTarget.value;
  });
  root.querySelectorAll("textarea, input").forEach((input) => {
    if (input.id === "office-title" || input.id === "office-filename" || input.id === "office-force") return;
    input.addEventListener("input", () => {
      syncDraft(root);
      const guide = root.querySelector(".office-guide");
      if (guide) guide.innerHTML = `<h3>${lucideIcon("eye", "icon lucide")} 将写入</h3>${renderOutline(compactSpec())}`;
    });
  });
  root.querySelector("#office-add-block")?.addEventListener("click", () => {
    syncDraft(root);
    readIdentity(root);
    if (state.kind === "docx") state.draft.sections.push({ heading: "", paragraphsText: "", tableText: "" });
    else if (state.kind === "xlsx") state.draft.sheets.push({ name: `表${state.draft.sheets.length + 1}`, columnsText: "项目, 数值", rowsText: "" });
    else state.draft.slides.push({ title: "", bulletsText: "", notes: "" });
    render(root);
  });
  root.querySelectorAll("[data-office-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      syncDraft(root);
      const [kind, raw] = button.dataset.officeRemove.split(":");
      const index = Number(raw);
      if (kind === "section") state.draft.sections.splice(index, 1);
      if (kind === "sheet") state.draft.sheets.splice(index, 1);
      if (kind === "slide") state.draft.slides.splice(index, 1);
      render(root);
    });
  });
  root.querySelector("#office-reset")?.addEventListener("click", () => {
    readIdentity(root);
    state.draft = emptyDraft(state.kind, state.title);
    state.templateId = "";
    state.pendingPlan = null;
    state.lastResult = null;
    state.error = "";
    render(root);
  });
  root.querySelector("#office-plan")?.addEventListener("click", () => void planDocument(root));
  root.querySelector("#office-confirm")?.addEventListener("click", () => void confirmDocument(root));
  root.querySelector("#office-cancel")?.addEventListener("click", () => {
    state.pendingPlan = null;
    render(root);
  });
  root.querySelector("#office-force")?.addEventListener("change", (event) => {
    state.force = event.currentTarget.checked;
  });
  root.querySelectorAll("[data-office-template]").forEach((button) => {
    button.addEventListener("click", () => useTemplate(root, button.dataset.officeTemplate));
  });
  root.querySelectorAll("[data-history-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      syncDraft(root);
      readIdentity(root);
      state.historyFilter = button.dataset.historyFilter;
      render(root);
    });
  });
  root.querySelectorAll("[data-office-inspect]").forEach((button) => {
    button.addEventListener("click", () => void inspectFile(root, button.dataset.officeInspect));
  });
  root.querySelectorAll("[data-office-reveal]").forEach((button) => {
    button.addEventListener("click", () => void revealPath(button.dataset.officeReveal));
  });
  root.querySelectorAll("[data-office-copy]").forEach((button) => {
    button.addEventListener("click", () => void copyText(button.dataset.officeCopy));
  });
  root.querySelectorAll("[data-office-download]").forEach((button) => {
    button.addEventListener("click", () => void downloadFile(button.dataset.officeDownload));
  });
}

async function planDocument(root) {
  syncDraft(root);
  readIdentity(root);
  state.busy = true;
  state.error = "";
  state.lastResult = null;
  render(root);
  try {
    const spec = compactSpec();
    const plan = await request("/api/office/generate", {
      method: "POST",
      body: { kind: state.kind, title: state.title, fileName: state.fileName, spec, dryRun: true },
    });
    state.pendingPlan = { kind: state.kind, title: state.title, fileName: state.fileName, spec, plan: plan.plan };
  } catch (error) {
    state.error = error.message;
  } finally {
    state.busy = false;
    render(root);
  }
}

async function confirmDocument(root) {
  if (!state.pendingPlan) return;
  state.busy = true;
  state.error = "";
  render(root);
  try {
    const done = await request("/api/office/generate", {
      method: "POST",
      body: {
        kind: state.pendingPlan.kind,
        title: state.pendingPlan.title,
        fileName: state.pendingPlan.fileName,
        spec: state.pendingPlan.spec,
        dryRun: false,
        force: state.force,
      },
    });
    state.lastResult = done;
    state.pendingPlan = null;
    state.error = ""; // 成功路径清掉历史错误（如上次 inspect/下载失败），不让旧错误常驻表单
    state.history = (await request("/api/office/history"))?.items ?? state.history;
  } catch (error) {
    if (/already exists|OFFICE_FILE_EXISTS/i.test(error.message || error.code || "")) {
      state.error = "同名文件已在。勾选覆盖后再确认。";
      state.force = false;
    } else {
      state.error = error.message;
    }
  } finally {
    state.busy = false;
    render(root);
  }
}

function useTemplate(root, templateId) {
  const template = state.templates.find((item) => item.id === templateId);
  if (!template) return;
  syncDraft(root);
  state.kind = template.kind;
  state.title = template.spec?.title || template.title;
  state.fileName = "";
  state.templateId = template.id;
  state.draft = draftFromSpec(template.kind, template.spec, state.title);
  state.pendingPlan = null;
  state.lastResult = null;
  state.error = "";
  render(root);
  root.querySelector("#office-title")?.focus();
}

async function inspectFile(root, path) {
  try {
    const { summary } = await request("/api/office/inspect", { method: "POST", body: { path } });
    state.inspect = summary;
    state.error = "";
  } catch (error) {
    state.inspect = null;
    state.error = error.message;
  }
  syncDraft(root);
  readIdentity(root);
  render(root);
}

async function revealPath(path) {
  try {
    await request("/api/system/reveal", { method: "POST", body: { path } });
  } catch (error) {
    state.error = error.message;
    const root = document.getElementById("office-container");
    if (root) render(root);
  }
}

async function downloadFile(path) {
  try {
    const blob = await requestBlob(`/api/office/download?path=${encodeURIComponent(path)}`);
    state.error = "";
    const name = String(path).split(/[\\/]/).pop() || "document";
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = name;
    link.click();
    URL.revokeObjectURL(href);
  } catch (error) {
    state.error = error.message;
    const root = document.getElementById("office-container");
    if (root) render(root);
  }
}

/** 供 app.js 在切入视图时按需刷新。 */
export function refreshOfficePanel() {
  const root = document.getElementById("office-container");
  if (root) void refresh(root);
}

function bootWhenReady() {
  if (typeof document === "undefined") return;
  const start = () => void apiReady.then(() => {
    const root = document.getElementById("office-container");
    if (root) void refresh(root);
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

bootWhenReady();
