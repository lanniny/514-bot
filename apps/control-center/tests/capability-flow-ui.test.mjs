import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("Skill and MCP configuration separates runtime projection, team menu and member scope", async () => {
  const [html, app, workbench, dataCss, shellCss, runtimeCss] = await Promise.all([
    readFile(resolve(root, "public/index.html"), "utf8"),
    readFile(resolve(root, "public/app.js"), "utf8"),
    readFile(resolve(root, "public/modules/ccswitch-panel.js"), "utf8"),
    readFile(resolve(root, "public/forge/data.css"), "utf8"),
    readFile(resolve(root, "public/forge/shell.css"), "utf8"),
    readFile(resolve(root, "public/forge/runtime-workbench.css"), "utf8"),
  ]);

  // 2026-09-09 设置工作区重排：独立 h2「能力中心」撤下，面板由 config-topology 的
  // 「能力」tab 命名（aria-labelledby），首屏让位给能力概览与生效链。
  assert.match(html, /id="config-surface-capabilities"[^>]*aria-labelledby="config-topology-capabilities"/);
  assert.match(html, /id="config-topology-capabilities"[\s\S]*?<span>能力<\/span>/);
  assert.match(html, /class="capability-bus"/);
  assert.match(html, /本机安装与投影[\s\S]+团队能力包[\s\S]+成员范围/);
  assert.match(html, /data-runtime-capability-jump="current"/);
  assert.match(html, /Skill 成员范围/);
  assert.match(html, /MCP 接入状态/);
  assert.doesNotMatch(html, /id="cap-skill-wizard"|id="cap-mcp-wizard"/);

  assert.match(html, /id="team-capability-flow"/);
  assert.match(html, /这里只选团队菜单，不安装资源、不授予权限/);
  assert.match(app, /team-capability-effective/);
  assert.match(app, /data-team-capability-jump/);

  const resourceTabs = workbench.slice(
    workbench.indexOf("function resourceTabs"),
    workbench.indexOf("function resourcesMarkup"),
  );
  assert.match(resourceTabs, /\["mcps", "MCP 投影"\]/);
  assert.match(resourceTabs, /\["skills", "Skill 安装"\]/);
  assert.match(workbench, /这里负责本机安装与 CLI live 投影/);
  assert.match(workbench, /data-ccs-action="mcp-import"/);
  assert.match(workbench, /data-ccs-action="skill-import"/);
  assert.match(workbench, /暂无托管 MCP/);
  assert.match(workbench, /暂无本机安装副本/);
  assert.match(workbench, /forge:open-capabilities/);
  assert.match(app, /addEventListener\("forge:open-capabilities"/);
  assert.match(app, /openLocalRuntimeWorkbench\("resources", \{ resourceTab: "skills" \}\)/);
  assert.match(app, /openLocalRuntimeWorkbench\("resources", \{ resourceTab: "mcps" \}\)/);
  assert.match(app, /data-mcp-edit=/);
  assert.match(app, /selectMcp:/);
  assert.match(app, /adoptIfMissing: true/);

  assert.match(dataCss, /\.capability-bus/);
  assert.match(shellCss, /\.team-capability-flow/);
  assert.match(runtimeCss, /\.ccs-capability-bridge/);
});
