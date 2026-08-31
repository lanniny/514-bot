/**
 * W2.5 导航单一真源：desktop 侧栏 / topbar / mobile 底栏三套导航由同一份
 * NAV_ITEMS + NAV_GROUPS 生成，任何视图增删只改这里，杜绝三份手写清单漂移
 * （此前 mobile 缺 channels/market/hosts、sidebar 缺 workbench/config，qa-ui
 * 曾因多套导航选择器歧义出恒超时）。
 *
 * 纯数据 + 渲染函数，零依赖，可在 node --test 中直接断言。
 * 视图集合是三表面的统一超集；is-active/aria-current 由 app.js setView 统一同步。
 */

export const NAV_GROUPS = [
  { id: "collab", label: "协作", views: ["bot", "workbench", "team", "channels"] },
  { id: "create", label: "创建", views: ["bootstrapper", "office"] },
  { id: "observe", label: "观测", views: ["overview", "observability", "sessions"] },
  { id: "resources", label: "资源", views: ["market", "hosts", "config"] },
];

export const NAV_ITEMS = {
  bot: { icon: "messages-square", label: "514 Bot", short: "对话", tooltip: "514 Bot 项目与对话", primary: true },
  workbench: { icon: "panel-left", label: "协作台", short: "协作台", tooltip: "514 Bot 协作台" },
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
};

export function navViews() {
  return NAV_GROUPS.flatMap((group) => group.views);
}

function buttonMarkup(view, item, { labelKey, className, extraClass = "" }) {
  const label = item[labelKey];
  const aria = ` aria-label="${item.tooltip}"`;
  const title = ` title="${item.tooltip}"`;
  return `        <button class="${className}${item.primary ? ` ${extraClass}` : ""}" type="button" data-view="${view}"${title}${aria}>\n`
    + `          <svg class="icon lucide"><use href="#lucide-${item.icon}"></use></svg><span>${label}</span>\n`
    + `        </button>`;
}

export function renderNavigation({ doc = document } = {}) {
  const mounts = {
    primary: doc.querySelector('[data-nav-surface="primary"]'),
    topbar: doc.querySelector('[data-nav-surface="topbar"]'),
    mobile: doc.querySelector('[data-nav-surface="mobile"]'),
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
