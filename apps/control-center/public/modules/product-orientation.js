/**
 * product-orientation.js — Phase C3 / v48 P-19
 *
 * 514 Bot 首次/按需导览 + 能力地图。文案指向真实可导航面，
 * 目的地从 nav-config / palette-catalog 解析，禁止再手写一份会过期的宣传册。
 *
 * 关闭偏好复用既有客户端 dismiss 约定（与 welcome-tip 同族 514cc-* localStorage），
 * 不另开 preferences.json / 项目偏好泵。
 */

import { escapeHtml } from "../utils.js";
import { NAV_ITEMS } from "./nav-config.js";
import { VIEW_TITLES } from "../state.js";
import {
  listPaletteViewItems,
  listPaletteSettingsItems,
  listPaletteBotActions,
} from "./palette-catalog.js";

export const PRODUCT_TOUR_DISMISS_KEY = "514cc-product-tour-dismissed";

/** 导览/地图里要讲的真实面。id 必须能在注册表或本模块 surfaces 里解析到。 */
export const BOT_ORIENTATION_SPOTLIGHT = Object.freeze([
  { ref: "nav:bot", hint: "左栏项目树与对话列表，是日常进出的入口" },
  { ref: "action:bot:kickoff-help", hint: "输入框 @ 点名；至少两位成员才走 kickoff" },
  { ref: "action:bot:create-routine", hint: "右栏 Routines：六要素表单，不是空日历" },
  { ref: "action:bot:open-channels", hint: "渠道默认 fail-closed，门闸未开时不会假装能发", gate: "channels" },
  { ref: "action:bot:private-skills", hint: "设置 → Plugins 里的私有技能库" },
  { ref: "action:bot:save-skill", hint: "仅成功 run 可沉淀；没有成功 run 会如实提示" },
  { ref: "nav:observability", hint: "handoff / 记忆浏览；不是 Bot 聊天摘要" },
  { ref: "surface:settlement-evidence", hint: "协作室右栏「证据」：结算卡与任务图，有 run 才有内容" },
]);

export const BOT_ORIENTATION_SURFACES = Object.freeze([
  {
    id: "settlement-evidence",
    label: "结算与证据",
    icon: "file-text",
    action: "bot:evidence",
    keywords: "settlement evidence delta 结算 证据 收敛",
    detail: "协作室右栏证据页；单聊没有任务图时不会假装有",
  },
]);

export const PRODUCT_TOUR_STEPS = Object.freeze([
  {
    id: "projects",
    title: "项目与对话",
    body: "左栏是项目树和会话列表。点一条对话进入中栏，不必先找「工作台」。",
    spotlight: "nav:bot",
  },
  {
    id: "composer",
    title: "输入框与多 @ kickoff",
    body: "中栏输入框直接派活。用 @ 点名成员；至少两位才会走协作 kickoff，单点名只是定向消息。",
    spotlight: "action:bot:kickoff-help",
  },
  {
    id: "routines-channels",
    title: "例行与渠道",
    body: "右栏 Routines 管定时活。Channels 接 Telegram 等 inbound——门闸未授权时这里会写明，而不是假装已接通。",
    spotlight: "action:bot:open-channels",
    gate: "channels",
  },
  {
    id: "skills",
    title: "Private skills 与存为技能",
    body: "设置 → Plugins 管理私有技能。成功 run 上的「沉淀为 Private skill」会带真实目标/结果草稿，缺字段不会编造。",
    spotlight: "action:bot:save-skill",
  },
  {
    id: "palette",
    title: "命令面板",
    body: "Ctrl/Cmd+K 搜视图、设置页和 Bot 动作。导览和能力地图也可以从面板或「帮助」再打开。",
    spotlight: "action:bot:capability-map",
  },
  {
    id: "settlement",
    title: "结算与证据",
    body: "协作室右栏「证据」页看结算卡和任务图。没有进行中的协作 run 时是空态，不会伪造 DELTA。",
    spotlight: "surface:settlement-evidence",
    requires: "settlement",
  },
]);

function storageGet(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function storageSet(storage, key, value) {
  try {
    if (value == null) storage?.removeItem(key);
    else storage?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function readProductTourDismissed(storage = globalThis.localStorage) {
  return storageGet(storage, PRODUCT_TOUR_DISMISS_KEY) === "1";
}

export function writeProductTourDismissed(dismissed, storage = globalThis.localStorage) {
  return storageSet(storage, PRODUCT_TOUR_DISMISS_KEY, dismissed ? "1" : null);
}

export function shouldAutoStartProductTour(storage = globalThis.localStorage) {
  return !readProductTourDismissed(storage);
}

function registryByRef() {
  const map = new Map();
  for (const item of listPaletteViewItems()) {
    map.set(`nav:${item.id}`, {
      ref: `nav:${item.id}`,
      id: item.id,
      label: item.label,
      icon: item.icon,
      group: item.group || "视图",
      action: null,
      view: item.id,
      keywords: item.keywords || "",
      detail: NAV_ITEMS[item.id]?.tooltip || VIEW_TITLES[item.id] || "",
    });
  }
  for (const item of listPaletteSettingsItems()) {
    const tab = item.id.replace(/^bot-settings:/, "");
    map.set(`settings:${tab}`, {
      ref: `settings:${tab}`,
      id: item.id,
      label: item.label,
      icon: item.icon,
      group: "设置",
      action: item.action,
      view: null,
      keywords: item.keywords || "",
      detail: item.detail || "",
    });
  }
  for (const item of listPaletteBotActions()) {
    map.set(`action:${item.id}`, {
      ref: `action:${item.id}`,
      id: item.id,
      label: item.label,
      icon: item.icon,
      group: item.group || "514 Bot",
      action: item.action || item.id,
      view: null,
      keywords: item.keywords || "",
      detail: item.detail || "",
    });
  }
  for (const surface of BOT_ORIENTATION_SURFACES) {
    map.set(`surface:${surface.id}`, {
      ref: `surface:${surface.id}`,
      id: surface.id,
      label: surface.label,
      icon: surface.icon,
      group: "514 Bot",
      action: surface.action,
      view: null,
      keywords: surface.keywords || "",
      detail: surface.detail || "",
    });
  }
  return map;
}

export function resolveOrientationRef(ref, registries = registryByRef()) {
  return registries.get(ref) || null;
}

function gateState(gate, { channelStatus = "unknown" } = {}) {
  if (gate !== "channels") return { available: true, status: "ready", reason: "" };
  if (channelStatus === "gated") {
    return {
      available: false,
      status: "gated",
      reason: "渠道门闸未开放——到「安全诊断 → 远程门闸」授权 chat-channels 后可用",
    };
  }
  if (channelStatus === "error") {
    return {
      available: false,
      status: "error",
      reason: "频道状态读取失败，不假装已经接通",
    };
  }
  if (channelStatus === "empty") {
    return {
      available: true,
      status: "empty",
      reason: "还没有连接频道——打开后按真实空态引导，不会伪造已接入通道",
    };
  }
  return { available: true, status: channelStatus || "unknown", reason: "" };
}

export function listProductTourSteps({ settlementPresent = true } = {}) {
  return PRODUCT_TOUR_STEPS.filter((step) => step.requires !== "settlement" || settlementPresent);
}

export function listCapabilityMapItems({
  channelStatus = "unknown",
  settlementPresent = true,
} = {}) {
  const registries = registryByRef();
  const items = [];
  for (const spotlight of BOT_ORIENTATION_SPOTLIGHT) {
    if (spotlight.ref === "surface:settlement-evidence" && !settlementPresent) continue;
    const resolved = resolveOrientationRef(spotlight.ref, registries);
    if (!resolved) continue;
    const gate = gateState(spotlight.gate, { channelStatus });
    items.push({
      ...resolved,
      hint: spotlight.hint || resolved.detail,
      gate: spotlight.gate || null,
      available: gate.available,
      status: gate.status,
      reason: gate.reason,
    });
  }
  return items;
}

export function productTourStepModel(index, {
  settlementPresent = true,
  channelStatus = "unknown",
} = {}) {
  const steps = listProductTourSteps({ settlementPresent });
  const total = steps.length;
  const safeIndex = Math.min(Math.max(0, Number(index) || 0), Math.max(0, total - 1));
  const step = steps[safeIndex];
  if (!step) return null;
  const resolved = resolveOrientationRef(step.spotlight);
  const gate = gateState(step.gate, { channelStatus });
  return {
    ...step,
    index: safeIndex,
    total,
    isFirst: safeIndex === 0,
    isLast: safeIndex === total - 1,
    destination: resolved,
    available: gate.available,
    status: gate.status,
    reason: gate.reason,
  };
}

export function productTourStepMarkup(model) {
  if (!model) return "";
  const dest = model.destination;
  const gateNote = model.reason
    ? `<p class="bot-orientation-gate is-${escapeHtml(model.status)}" role="status">${escapeHtml(model.reason)}</p>`
    : "";
  const destNote = dest
    ? `<p class="bot-orientation-dest">去向：<strong>${escapeHtml(dest.label)}</strong></p>`
    : "";
  return `
    <div class="bot-product-tour-step" data-product-tour-id="${escapeHtml(model.id)}">
      <p class="bot-orientation-progress">${model.index + 1} / ${model.total}</p>
      <h3>${escapeHtml(model.title)}</h3>
      <p>${escapeHtml(model.body)}</p>
      ${destNote}
      ${gateNote}
    </div>`;
}

export function capabilityMapMarkup(items) {
  if (!items.length) {
    return `<p class="bot-plugin-empty">能力地图没有解析到注册表项——请检查 palette-catalog / nav-config。</p>`;
  }
  const groups = new Map();
  for (const item of items) {
    const group = item.group || "514 Bot";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
  }
  return [...groups.entries()].map(([group, rows]) => {
    const cards = rows.map((item) => {
      const gated = !item.available;
      const action = item.action || (item.view ? `view:${item.view}` : "");
      const unlock = item.gate === "channels" && gated
        ? `<button class="bot-text-button" type="button" data-capability-action="view:security">去授权</button>`
        : "";
      return `<article class="bot-capability-card${gated ? " is-gated" : ""}" data-capability-ref="${escapeHtml(item.ref)}">
        <div>
          <strong>${escapeHtml(item.label)}</strong>
          <p>${escapeHtml(item.hint || item.detail || "")}</p>
          ${item.reason ? `<p class="bot-orientation-gate is-${escapeHtml(item.status)}" role="status">${escapeHtml(item.reason)}</p>` : ""}
        </div>
        <div class="bot-capability-card-actions">
          <button class="bot-text-button" type="button" data-capability-action="${escapeHtml(action)}"${gated ? " disabled" : ""}>${gated ? "暂不可用" : "打开"}</button>
          ${unlock}
        </div>
      </article>`;
    }).join("");
    return `<section class="bot-capability-group"><h3>${escapeHtml(group)}</h3>${cards}</section>`;
  }).join("");
}
