/**
 * palette-catalog.js — 命令面板静态目录（v48 P-18）。
 *
 * 视图从 NAV_ITEMS + VIEW_TITLES 派生，设置页 / 配置面 / 高价值 Bot 动作
 * 各用一份注册表。禁止在 command-palette.js 再手写一份会过期的巨型清单。
 */

import { NAV_ITEMS } from "./nav-config.js";
import { VIEW_TITLES } from "../state.js";

export const BOT_SETTINGS_TABS = Object.freeze([
  { id: "general", label: "Bot 设置 · General", icon: "user", keywords: "settings general 昵称 头像 个人" },
  { id: "plugins", label: "Bot 设置 · Plugins / Private skills", icon: "puzzle", keywords: "settings plugins skills mcp private 私有技能 插件" },
  { id: "team", label: "Bot 设置 · 成员", icon: "users", keywords: "settings team members 成员 联系人 席位" },
  { id: "appearance", label: "Bot 设置 · Appearance", icon: "palette", keywords: "settings appearance theme 外观 主题" },
  { id: "updates", label: "Bot 设置 · Updates", icon: "refresh-cw", keywords: "settings updates release 更新 构建真相" },
]);

export const CONFIG_SURFACE_ITEMS = Object.freeze([
  { id: "providers", label: "配置 · 连接档案", icon: "plug", keywords: "config providers 连接 供应商 档案" },
  { id: "local-runtime", label: "配置 · 本机运行时", icon: "cpu", keywords: "config local-runtime ccswitch 本机 运行时" },
  { id: "capabilities", label: "配置 · 能力矩阵", icon: "puzzle", keywords: "config capabilities skills mcp 能力 技能" },
  { id: "hooks", label: "配置 · Hooks", icon: "git-branch", keywords: "config hooks 生命周期" },
  { id: "sources", label: "配置 · 源与席位", icon: "layers", keywords: "config sources seats 源 席位" },
]);

export const BOT_PALETTE_ACTIONS = Object.freeze([
  {
    id: "bot:create-routine",
    label: "新建例行",
    icon: "timer",
    keywords: "routine create 新建 例行 定时 grok",
    detail: "打开 Routines 六要素表单",
  },
  {
    id: "bot:open-channels",
    label: "打开渠道",
    icon: "satellite-dish",
    keywords: "channels 渠道 频道 slack webhook",
    detail: "打开 Bot 右栏 Channels",
  },
  {
    id: "bot:private-skills",
    label: "打开 Private skills",
    icon: "book-marked",
    keywords: "private skills 私有技能 插件 settings",
    detail: "打开 Bot 设置的私有技能库",
  },
  {
    id: "bot:kickoff-help",
    label: "Kickoff 帮助",
    icon: "circle-help",
    keywords: "kickoff help @mention 点名 群聊 派发 relay",
    detail: "如何用 @成员 发起协作 kickoff",
  },
  {
    id: "bot:save-skill",
    label: "把成功 run 存为 Private skill",
    icon: "bookmark-plus",
    keywords: "save skill private 沉淀 成功 run",
    detail: "仅对已成功的 run 开放；无成功 run 会如实提示",
  },
  {
    id: "bot:product-tour",
    label: "产品导览",
    icon: "compass",
    keywords: "tour guide onboarding 导览 新手 帮助 first-run",
    detail: "走一遍 514 Bot 现有表面，可随时跳过",
  },
  {
    id: "bot:capability-map",
    label: "能力地图",
    icon: "layers",
    keywords: "capability map 能力 地图 帮助 what can",
    detail: "对照注册表列出可打开的真实入口",
  },
]);

export const PALETTE_DEEP_VIEWS = Object.freeze({
  router: { icon: "route", keywords: "router 路由 model 模型 设置 派工 团队" },
  terminal: { icon: "terminal", keywords: "terminal 终端" },
  capabilities: { icon: "puzzle", keywords: "capabilities 能力 skills 技能 MCP" },
  memory: { icon: "brain", keywords: "memory 记忆 browser 浏览" },
  hero: { icon: "orbit", keywords: "hero constellation 星图 协作星图 orbit 团队" },
  appearance: { icon: "palette", keywords: "appearance theme 外观 主题 字号 深色 亮色" },
  browser: { icon: "globe", keywords: "browser 浏览器 内置浏览" },
});

const VIEW_KEYWORDS = Object.freeze({
  bot: "514 bot agent chat master 代理 对话 工作台",
  workbench: "collaboration workbench 协作 任务 控制台",
  overview: "overview 总览 dashboard 健康",
  config: "config 配置 settings 设置 源 capabilities 能力 skills 技能 MCP 图谱 provider 供应商",
  router: PALETTE_DEEP_VIEWS.router.keywords,
  security: "security 安全 shield 诊断 设置",
  observability: "observability 观测 pulse delta handoff 交接 记忆 memory",
  sessions: "sessions 会话 conversation 历史",
  team: "team 团队 协作 roster agent 成员 星图 constellation 路由 派工",
  hero: PALETTE_DEEP_VIEWS.hero.keywords,
  bootstrapper: "bootstrapper 项目 创建 new project scaffold 脚手架",
  office: "office 文档 工坊 docx ppt",
  automations: "automation 自动化 定时 闲时 cron schedule 计划",
  appearance: PALETTE_DEEP_VIEWS.appearance.keywords,
  browser: PALETTE_DEEP_VIEWS.browser.keywords,
  market: "market plugin 市场 插件 skill mcp",
  plugins: "plugins 插件中心 项目插件",
  hosts: "hosts ssh 远程主机",
  channels: "channels 渠道",
  terminal: PALETTE_DEEP_VIEWS.terminal.keywords,
  capabilities: PALETTE_DEEP_VIEWS.capabilities.keywords,
  memory: PALETTE_DEEP_VIEWS.memory.keywords,
});

function viewItem(id, { label, icon, keywords }) {
  return {
    id,
    label,
    icon: icon || "layout-dashboard",
    group: "视图",
    keywords: keywords || "",
  };
}

/** 导航 + 标题表 + 深链视图的并集，id 即 setView 目标。 */
export function listPaletteViewItems() {
  const items = new Map();
  for (const [id, item] of Object.entries(NAV_ITEMS)) {
    items.set(id, viewItem(id, {
      label: VIEW_TITLES[id] || item.label,
      icon: item.icon,
      keywords: VIEW_KEYWORDS[id] || item.tooltip || "",
    }));
  }
  for (const [id, title] of Object.entries(VIEW_TITLES)) {
    if (items.has(id)) continue;
    const deep = PALETTE_DEEP_VIEWS[id] || {};
    items.set(id, viewItem(id, {
      label: title,
      icon: deep.icon,
      keywords: VIEW_KEYWORDS[id] || deep.keywords || "",
    }));
  }
  for (const [id, deep] of Object.entries(PALETTE_DEEP_VIEWS)) {
    if (items.has(id)) continue;
    items.set(id, viewItem(id, {
      label: id,
      icon: deep.icon,
      keywords: deep.keywords,
    }));
  }
  return [...items.values()];
}

export function listPaletteSettingsItems() {
  return BOT_SETTINGS_TABS.map((tab) => ({
    id: `bot-settings:${tab.id}`,
    label: tab.label,
    icon: tab.icon,
    group: "设置",
    keywords: tab.keywords,
    action: `bot-settings:${tab.id}`,
    detail: "打开 514 Bot 设置页",
  }));
}

export function listPaletteConfigItems() {
  return CONFIG_SURFACE_ITEMS.map((surface) => ({
    id: `config-surface:${surface.id}`,
    label: surface.label,
    icon: surface.icon,
    group: "配置",
    keywords: surface.keywords,
    action: `config-surface:${surface.id}`,
    detail: "打开配置图谱对应分页",
  }));
}

export function listPaletteBotActions() {
  return BOT_PALETTE_ACTIONS.map((item) => ({
    ...item,
    group: "514 Bot",
    action: item.id,
  }));
}

/** 不含运行时 extraItems（宏 / 模板）的静态目录，供测试锁覆盖下限。 */
export function listStaticPaletteCatalog() {
  return [
    ...listPaletteViewItems(),
    ...listPaletteSettingsItems(),
    ...listPaletteConfigItems(),
    ...listPaletteBotActions(),
  ];
}

export const PALETTE_COVERAGE_MINIMUM = 35;
export const REQUIRED_BOT_PALETTE_ACTIONS = Object.freeze(BOT_PALETTE_ACTIONS.map((item) => item.id));
