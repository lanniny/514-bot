/**
 * W2.5 导航单一真源：desktop 侧栏 / topbar / mobile 底栏三套导航由同一份
 * NAV_ITEMS + NAV_GROUPS 生成，任何视图增删只改这里，杜绝三份手写清单漂移
 * （此前 mobile 缺 channels/market/hosts、sidebar 缺 workbench/config，qa-ui
 * 曾因多套导航选择器歧义出恒超时）。
 *
 * 纯数据 + 渲染函数，零依赖，可在 node --test 中直接断言。
 * 视图集合是三表面的统一超集；is-active/aria-current 由 app.js setView 统一同步。
 */

/**
 * UI-AUDIT P0-5：automations / security 此前只存在于 VIEW_TITLES 与深层入口
 * （workbench 侧栏行、config 设置轨），主导航里完全没有入口——高价值的定时编排
 * 与安全体检对新用户等于不存在。此处提级为第五组「治理」，主导航即产品地图。
 * terminal / browser / appearance 保持工具定位（底栏终端 + 设置轨），不占导航位。
 */
export const NAV_GROUPS = [
  { id: "collab", label: "工作空间", views: ["bot", "automations", "plugins", "sessions"] },
  { id: "create", label: "协作工具", views: ["team", "workbench", "office", "bootstrapper", "channels"] },
  { id: "resources", label: "配置与资源", views: ["config", "market", "hosts"] },
  { id: "observe", label: "运行与安全", views: ["overview", "observability", "security"] },
];

export const NAV_ITEMS = {
  bot: { icon: "messages-square", label: "514 Bot", short: "对话", tooltip: "514 Bot 项目与对话", primary: true },
  workbench: { icon: "terminal", label: "运行控制台", short: "控制台", tooltip: "运行控制台" },
  plugins: { icon: "puzzle", label: "插件中心", short: "插件", tooltip: "项目插件中心" },
  team: { icon: "users", label: "团队协作", short: "团队", tooltip: "团队协作" },
  channels: { icon: "satellite-dish", label: "渠道", short: "渠道", tooltip: "渠道" },
  bootstrapper: { icon: "rocket", label: "项目启动器", short: "启动器", tooltip: "项目启动器" },
  office: { icon: "file-type", label: "文档工坊", short: "文档", tooltip: "文档工坊" },
  overview: { icon: "layout-dashboard", label: "系统总览", short: "总览", tooltip: "系统总览" },
  observability: { icon: "activity", label: "体系观测", short: "观测", tooltip: "体系观测" },
  sessions: { icon: "message-circle", label: "会话聚合", short: "会话", tooltip: "会话聚合" },
  market: { icon: "store", label: "市场", short: "市场", tooltip: "市场" },
  hosts: { icon: "server", label: "远程主机", short: "主机", tooltip: "远程主机" },
  config: { icon: "settings", label: "配置", short: "配置", tooltip: "配置" },
  automations: { icon: "timer", label: "自动化", short: "自动化", tooltip: "定时任务与编排（原深埋于协作台侧栏）" },
  security: { icon: "shield-check", label: "安全诊断", short: "安全", tooltip: "权限、密钥与暴露面体检（原深埋于设置轨）" },
};

export function navViews() {
  return NAV_GROUPS.flatMap((group) => group.views);
}

function buttonMarkup(view, item, { labelKey, className, extraClass = "" }) {
  const label = item[labelKey];
  const aria = ` aria-label="${item.tooltip}"`;
  const title = ` title="${item.tooltip}"`;
  return `        <button class="${className}${item.primary ? ` ${extraClass}` : ""}" type="button" data-view="${view}"${title}${aria}>\n`
    + `          <svg aria-hidden="true" class="icon lucide"><use href="#lucide-${item.icon}"></use></svg><span>${label}</span>\n`
    + `        </button>`;
}

export function renderNavigation({ doc = document } = {}) {
  const mounts = {
    primary: doc.querySelector('[data-nav-surface="primary"]'),
    topbar: doc.querySelector('[data-nav-surface="topbar"]'),
    mobile: doc.querySelector('[data-nav-surface="mobile"]'),
    settings: doc.querySelector('[data-nav-surface="settings"]'),
  };
  const rendered = {};
  if (mounts.primary) {
    rendered.primary = NAV_GROUPS.map((group) => {
      const items = group.views
        .map((view) => buttonMarkup(view, NAV_ITEMS[view], { labelKey: "label", className: "nav-item", extraClass: "nav-primary" }))
        .join("\n");
      return `          <div class="nav-group" role="group" aria-labelledby="nav-group-${group.id}">\n`
        + `            <p class="nav-group-label" id="nav-group-${group.id}">${group.label}</p>\n`
        + `${items}\n`
        + `          </div>`;
    }).join("\n\n");
    mounts.primary.innerHTML = rendered.primary;
  }
  if (mounts.settings) {
    // 侧栏隐藏后，原导航整体迁入设置配置面板（同一真源，杜绝双写漂移）：
    // settings-rail-item 复用设置轨既有样式/搜索过滤/激活态同步，data-view 走全局委托切视图。
    rendered.settings = NAV_GROUPS.map((group) => {
      const items = group.views
        .map((view) => buttonMarkup(view, NAV_ITEMS[view], { labelKey: "label", className: "settings-rail-item" }))
        .join("\n");
      return `<p class="settings-rail-label">${group.label}</p>\n${items}`;
    }).join("\n");
    mounts.settings.innerHTML = rendered.settings;
  }
  if (mounts.topbar) {
    rendered.topbar = NAV_GROUPS.map((group) => group.views
      .map((view) => buttonMarkup(view, NAV_ITEMS[view], { labelKey: "short", className: "topnav-item" }))
      .join("\n")).join("\n          <span class=\"topnav-divider\" aria-hidden=\"true\"></span>\n");
    mounts.topbar.innerHTML = rendered.topbar;
  }
  if (mounts.mobile) {
    rendered.mobile = NAV_GROUPS.flatMap((group) => group.views)
      .map((view) => buttonMarkup(view, NAV_ITEMS[view], { labelKey: "short", className: "mobile-nav-item" }))
      .join("\n");
    mounts.mobile.innerHTML = rendered.mobile;
  }
  return rendered;
}
