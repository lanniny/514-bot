/**
 * A/B 影子对照面板（v49）。
 *
 * ── 为什么需要它 ──
 * 后端的 A/B 影子对照能力**完整实现且零 UI 入口**：
 *   · `orchestrator.createShadowPair()`  —— src/orchestrator.mjs:5345，双腿派发 +
 *     对照腿强制 `permissionMode: "plan"`（只读）+ 建不出来时回滚主腿不留孤儿
 *   · `POST /api/runs/shadow`             —— server.mjs:2305
 *   · `GET  /api/runs/compare?a=&b=`      —— server.mjs:2315，返回对比矩阵 +
 *     verdicts + 可分享 Markdown（src/run-compare.mjs）
 * 2026-09-04 的 API 契约对账（scripts/api-contract-audit.mjs）实测：这两条端点
 * 在 `public/` 全量 44K 行里**零调用**，也无测试覆盖。
 *
 * 对"可问责的 AI 协作台"而言这恰是最该露出来的能力——同一任务派两个 CLI，
 * 谁更快、更省、更成，有据可查，而不是凭印象说"感觉 Codex 更靠谱"。
 *
 * ── 设计约束 ──
 * 1. **不塞进主 composer**。那条提交路径（app.js:24116）已承载会话/团队/权限/预算/
 *    模型/推理力度七类字段，再加一条对照腿只会让每个人的每次提交都变复杂。
 *    影子对照是**低频高价值**动作，配独立面板。
 * 2. **对照腿只读这件事必须在 UI 上说清**。后端强制 plan 模式，用户若以为两腿都会
 *    写盘，就会误判对比结果（"B 没改文件所以 B 不行"）。
 * 3. 全程 DOM API，零 innerHTML（`ui:lint` inner-html 基线 389，不往这笔债上加）。
 * 4. 派双腿会真实消耗预算 —— 提交前必须显式确认，不做一键静默双花。
 */

import { API } from "../api.js";

/**
 * 对照腿候选：能独立承担一轮的成员，排除主腿自己。
 *
 * memberCatalog 条目形状见 `src/adapters/manifest.mjs:648` createTeamCatalog：
 * `{ id, label, adapterLabel, teamMemberEligible, eligibilityReason, ... }`
 * —— **没有 name / memberId 字段**，不要凭直觉兜底那两个名字。
 * `teamMemberEligible=false` 的席位后端会拒（profile 禁用 / 命令未配 / adapter 不支持），
 * 列出来只会让用户点了才失败，所以这里过滤掉。
 */
export function shadowCandidates(members = [], primaryId = "") {
  const list = Array.isArray(members) ? members : [];
  return list.filter((member) => {
    if (!member || typeof member !== "object") return false;
    const id = String(member.id ?? "");
    if (!id || id === String(primaryId)) return false;
    return member.teamMemberEligible === true;
  });
}

/**
 * 把 compare 响应的矩阵折成"谁赢了哪几项"的计数，供顶部结论条使用。
 * 只数**可判定**的维度（两边都有数且不等），平局与缺数都不计入。
 */
export function tallyVerdicts(comparison) {
  const verdicts = Array.isArray(comparison?.verdicts) ? comparison.verdicts : [];
  let left = 0;
  let right = 0;
  for (const line of verdicts) {
    const text = String(line);
    // run-compare.mjs 的 verdict 文案固定以「左（A）」/「右（B）」开头
    if (text.startsWith("左（A）")) left += 1;
    else if (text.startsWith("右（B）")) right += 1;
  }
  return { left, right, decided: left + right, lines: verdicts };
}

function labelFor(members, id) {
  const found = (Array.isArray(members) ? members : [])
    .find((member) => String(member?.id ?? "") === String(id));
  if (!found) return String(id || "?");
  // adapterLabel 一起显示：影子对照的全部意义就是对比不同 CLI，
  // 只显示席位名（"评审席"）看不出跑的是 Codex 还是 Claude。
  const label = String(found.label || found.id);
  const adapter = String(found.adapterLabel || "");
  return adapter && adapter !== label ? `${label}（${adapter}）` : label;
}

/** 合格席位：teamMemberEligible=true 才可独立承担一轮，主腿与对照腿同一判据。 */
function eligibleMembers(list) {
  return (Array.isArray(list) ? list : []).filter((member) => member?.teamMemberEligible === true);
}

export function createShadowComparePanel({
  request, byId, state, toast = () => {}, confirmAction = null,
} = {}) {
  if (typeof request !== "function") throw new Error("createShadowComparePanel requires request()");
  if (typeof byId !== "function") throw new Error("createShadowComparePanel requires byId()");

  let pair = null;        // { primaryId, shadowId, compareUrl }
  let comparison = null;  // 最近一次 compare 响应
  let busy = false;

  function members() {
    return Array.isArray(state?.memberCatalog) ? state.memberCatalog : [];
  }

  function setStatus(message, tone = "") {
    const node = byId("shadow-status");
    if (!node) return;
    node.textContent = String(message);
    node.dataset.tone = tone;
  }

  /** 两个下拉共用的填充逻辑：条目形状固定为 { id, label, adapterLabel }。 */
  function fillSelect(select, candidates, emptyText) {
    const previous = select.value;
    select.replaceChildren();
    if (!candidates.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = emptyText;
      select.append(option);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    for (const member of candidates) {
      const option = document.createElement("option");
      option.value = String(member.id);
      option.textContent = labelFor(candidates, member.id);
      select.append(option);
    }
    if (previous && candidates.some((member) => String(member.id) === previous)) select.value = previous;
  }

  function renderShadowOptions() {
    const select = byId("shadow-target");
    if (!select) return;
    const primaryId = String(byId("shadow-primary")?.value || "");
    fillSelect(select, shadowCandidates(members(), primaryId), "无可用对照成员");
  }

  function renderPrimaryOptions() {
    const select = byId("shadow-primary");
    if (!select) return;
    const list = eligibleMembers(members());
    fillSelect(select, list, members().length ? "无可用席位（检查 CLI 配置）" : "团队成员未加载");
    renderShadowOptions();
  }

  function renderMatrix() {
    const body = byId("shadow-matrix-body");
    if (!body) return;
    body.replaceChildren();
    const rows = Array.isArray(comparison?.matrix) ? comparison.matrix : [];
    if (!rows.length) {
      const row = body.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 3;
      cell.className = "is-muted";
      cell.textContent = pair ? "两腿仍在运行，稍后刷新对比" : "尚未派发影子对照";
      return;
    }
    for (const item of rows) {
      const row = body.insertRow();
      row.insertCell().textContent = String(item?.field ?? "?");
      const left = row.insertCell();
      left.textContent = String(item?.left ?? "–");
      const right = row.insertCell();
      right.textContent = String(item?.right ?? "–");
      // 两边不同才高亮，相同的维度不制造视觉噪音
      if (String(item?.left) !== String(item?.right)) row.dataset.differs = "1";
    }
  }

  function renderVerdicts() {
    const list = byId("shadow-verdicts");
    if (!list) return;
    list.replaceChildren();
    const tally = tallyVerdicts(comparison);
    if (!tally.lines.length) return;
    for (const line of tally.lines) {
      const item = document.createElement("li");
      item.textContent = String(line);
      list.append(item);
    }
    const summary = byId("shadow-tally");
    if (summary) {
      summary.textContent = tally.decided
        ? `A 胜 ${tally.left} 项 · B 胜 ${tally.right} 项`
        : "可见维度上无显著差异";
    }
  }

  function renderLegs() {
    const node = byId("shadow-legs");
    if (!node) return;
    node.replaceChildren();
    if (!pair) return;
    const list = members();
    for (const [role, id, note] of [
      ["A（主腿）", pair.primaryId, "按你选的权限档执行"],
      ["B（对照腿）", pair.shadowId, "后端强制 plan 只读——不会写盘"],
    ]) {
      const item = document.createElement("div");
      item.className = "shadow-leg";
      const title = document.createElement("strong");
      title.textContent = `${role} ${labelFor(list, id)}`;
      const meta = document.createElement("span");
      meta.className = "is-muted";
      meta.textContent = `${id} · ${note}`;
      item.append(title, meta);
      node.append(item);
    }
  }

  function render() {
    renderLegs();
    renderMatrix();
    renderVerdicts();
    const refresh = byId("shadow-refresh");
    if (refresh) refresh.disabled = !pair || busy;
    const copy = byId("shadow-copy-markdown");
    if (copy) copy.disabled = !comparison?.markdown;
    const submit = byId("shadow-dispatch");
    if (submit) submit.disabled = busy;
  }

  async function dispatch() {
    if (busy) return;
    const prompt = String(byId("shadow-prompt")?.value || "").trim();
    const primaryId = String(byId("shadow-primary")?.value || "");
    const shadowAgentId = String(byId("shadow-target")?.value || "");
    if (!prompt) { setStatus("先写任务描述", "warn"); return; }
    if (!primaryId || !shadowAgentId) { setStatus("主腿与对照腿都要选", "warn"); return; }
    if (primaryId === shadowAgentId) { setStatus("对照腿必须与主腿不同", "warn"); return; }

    // 派双腿会真实花两份预算 —— 不做一键静默双花。
    // confirmAction 的真实签名是 { eyebrow, title, rows: [[label, value]], warning,
    // confirmLabel, danger }（app.js:25635）—— 不是 { title, body }。
    if (typeof confirmAction === "function") {
      const list = members();
      const ok = await confirmAction({
        eyebrow: "A/B 影子对照",
        title: "派发两条并行运行？",
        rows: [
          ["A（主腿）", `${labelFor(list, primaryId)} · 按所选权限执行`],
          ["B（对照腿）", `${labelFor(list, shadowAgentId)} · plan 只读，不写盘`],
          ["任务", prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt],
        ],
        warning: "两腿各自计费。对照腿被后端强制为 plan 只读，因此它不会产生文件改动——"
          + "对比时请按「结论质量」而非「是否落盘」判读。",
        confirmLabel: "派发双腿",
      });
      if (!ok) { setStatus("已取消", ""); return; }
    }

    busy = true;
    render();
    setStatus("派发中…", "");
    try {
      const payload = await request("/api/runs/shadow", {
        method: "POST",
        body: { input: { prompt, startAgentId: primaryId, shadowAgentId, execute: true } },
      });
      pair = {
        primaryId: payload?.primary?.id || "",
        shadowId: payload?.shadow?.id || "",
        compareUrl: payload?.compare || "",
      };
      comparison = null;
      setStatus("双腿已派发，运行结束后点「刷新对比」", "ok");
      toast("影子对照已派发");
    } catch (error) {
      setStatus(`派发失败：${error?.message || error}`, "error");
    } finally {
      busy = false;
      render();
    }
  }

  async function refresh() {
    if (!pair || busy) return;
    busy = true;
    render();
    try {
      const url = pair.compareUrl
        || `${API.runs}/compare?a=${encodeURIComponent(pair.primaryId)}&b=${encodeURIComponent(pair.shadowId)}`;
      comparison = await request(url);
      setStatus("对比已更新", "ok");
    } catch (error) {
      setStatus(`对比读取失败：${error?.message || error}`, "error");
    } finally {
      busy = false;
      render();
    }
  }

  async function copyMarkdown() {
    const markdown = comparison?.markdown;
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
      toast("对比报告已复制");
    } catch (error) {
      setStatus(`复制失败：${error?.message || error}`, "error");
    }
  }

  function mount() {
    byId("shadow-dispatch")?.addEventListener("click", () => { void dispatch(); });
    byId("shadow-refresh")?.addEventListener("click", () => { void refresh(); });
    byId("shadow-copy-markdown")?.addEventListener("click", () => { void copyMarkdown(); });
    byId("shadow-primary")?.addEventListener("change", renderShadowOptions);
    renderPrimaryOptions();
    render();
  }

  return { mount, render, renderPrimaryOptions, dispatch, refresh, copyMarkdown,
    get pair() { return pair; }, get comparison() { return comparison; } };
}
