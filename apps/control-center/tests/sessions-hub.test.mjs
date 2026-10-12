/**
 * tests/sessions-hub.test.mjs
 * 验证跨 CLI 会话聚合中心 (Sessions Hub v4.1) 的行为契约与渲染逻辑。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createSessionsHubPage } from "../public/modules/sessions-hub.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

test("sessions-title and editorial-headline contract preserved in index.html", async () => {
  const html = await readFile(join(appRoot, "public/index.html"), "utf8");
  assert.match(
    html,
    /<h1[^>]*id="sessions-title"[^>]*class="[^"]*editorial-headline[^"]*"|<h1[^>]*class="[^"]*editorial-headline[^"]*"[^>]*id="sessions-title"/,
    "会话聚合视图标题 #sessions-title 必须保留 editorial-headline",
  );
  assert.match(html, /id="sessions-groups"/, "必须保留 #sessions-groups 容器");
});

test("sessions-hub page renders loading skeleton when data is null", () => {
  const container = { innerHTML: "" };
  const state = { sessionsData: null, sessionsError: null };
  const page = createSessionsHubPage({
    state,
    elements: { "sessions-groups": container },
    request: async () => ({}),
    toast: () => {},
    switchView: () => {},
    byId: () => null,
  });

  page.render();
  assert.match(container.innerHTML, /skeleton--card/, "未加载时必须呈现卡片骨架屏");
});

test("sessions-hub page renders error emptyState on failure", () => {
  const container = { innerHTML: "" };
  const state = { sessionsData: null, sessionsError: "IO error reading directory" };
  const page = createSessionsHubPage({
    state,
    elements: { "sessions-groups": container },
    request: async () => ({}),
    toast: () => {},
    switchView: () => {},
    byId: () => null,
  });

  page.render();
  assert.match(container.innerHTML, /empty-state--error/, "失败时必须呈现错误态空状态");
  assert.match(container.innerHTML, /IO error reading directory/, "必须呈现具体错误详情");
  assert.match(container.innerHTML, /重新扫描/, "必须包含重试行动入口");
});

test("sessions-hub renders metrics, search input, source pills, and session cards", () => {
  const container = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
  const state = {
    sessionsData: {
      sources: [
        {
          source: "claude",
          label: "Claude Code",
          available: true,
          sessionCount: 2,
          sessions: [
            {
              id: "sess-claude-123456789",
              scope: "project-alpha",
              summary: "帮我重构前端路由模块",
              size: 24500,
              modifiedAt: "2026-09-14T08:30:00.000Z",
            },
          ],
        },
        {
          source: "codex",
          label: "Codex CLI",
          available: true,
          sessionCount: 1,
          sessions: [
            {
              id: "sess-codex-987654321",
              scope: "2026/09",
              summary: "审查安全边界防御",
              size: 15200,
              modifiedAt: "2026-09-14T07:15:00.000Z",
            },
          ],
        },
      ],
    },
  };

  const page = createSessionsHubPage({
    state,
    elements: { "sessions-groups": container },
    request: async () => ({}),
    toast: () => {},
    switchView: () => {},
    byId: () => null,
  });

  page.render();

  // 指标卡
  assert.match(container.innerHTML, /聚合会话总数/, "必须渲染指标卡：会话总数");
  assert.match(container.innerHTML, /已接入 CLI 工具/, "必须渲染指标卡：CLI 工具");

  // 工具栏
  assert.match(container.innerHTML, /id="sessions-search-input"/, "必须包含搜索输入框");
  assert.match(container.innerHTML, /data-filter-source="all"/, "必须包含全部筛选胶囊");
  assert.match(container.innerHTML, /data-filter-source="claude"/, "必须包含 Claude 筛选胶囊");
  assert.match(container.innerHTML, /data-filter-source="codex"/, "必须包含 Codex 筛选胶囊");

  // 卡片
  assert.match(container.innerHTML, /session-card/, "必须渲染会话卡片");
  assert.match(container.innerHTML, /project-alpha/, "卡片必须展示范围与项目");
  assert.match(container.innerHTML, /重构前端路由模块/, "卡片必须展示会话摘要");
  assert.match(container.innerHTML, /data-action="preview"/, "必须包含浏览记录按钮");
  assert.match(container.innerHTML, /data-action="relay"/, "必须包含导入 514 Bot 按钮");
  assert.match(container.innerHTML, /data-action="reveal"/, "必须包含定位文件按钮");
});

test("sessions-hub CSS is declared in data.css with dark and wallpaper mode rules", async () => {
  const css = await readFile(join(appRoot, "public/forge/data.css"), "utf8");
  assert.match(css, /\.sessions-hub-metrics/, "必须定义指标网格样式");
  assert.match(css, /\.sessions-hub-toolbar/, "必须定义工具栏样式");
  assert.match(css, /\.session-card/, "必须定义会话卡片样式");
  assert.match(css, /\.sessions-drawer/, "必须定义预览抽屉样式");
  assert.match(css, /body\.team-bg-active #view-sessions/, "必须提供壁纸沉浸态样式");
});
