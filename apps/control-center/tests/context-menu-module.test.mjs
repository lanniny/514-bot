// UI-AUDIT Wave B 契约：右键菜单展示层抽取到 modules/context-menu.js
// 行为锁定：triggerMarkup 转义用户可控 id/label；app.js 保留同名委托（调用点与测试零改动）
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createContextMenu } from "../public/modules/context-menu.js";

const root = fileURLToPath(new URL("..", import.meta.url));

test("triggerMarkup escapes user-controlled id and label", () => {
  const menu = createContextMenu({
    getMenuRoot: () => ({}),
    icons: { more: "M6 12a2 2 0 1 0 .01 0z" },
  });
  const markup = menu.triggerMarkup("run", 'x" onmouseover="alert(1)', "<script>alert(2)</script>");
  assert.ok(!markup.includes('x" onmouseover'), "id 未转义会注入属性");
  assert.ok(markup.includes("data-run-menu="), "run 类触发器必须写 data-run-menu");
  assert.ok(markup.includes("&lt;script&gt;"), "label 必须 HTML 转义");
  const projectMarkup = menu.triggerMarkup("project", "p1", "更多");
  assert.ok(projectMarkup.includes("data-project-menu="), "project 类触发器必须写 data-project-menu");
});

test("factory API surface pins the presentation contract", () => {
  const menu = createContextMenu({ getMenuRoot: () => null, icons: { more: "", plus: "" } });
  for (const key of ["show", "hide", "showFromTrigger", "triggerMarkup", "lastPosition"]) {
    assert.equal(typeof menu[key], "function", `缺 API：${key}`);
  }
  assert.deepEqual(menu.lastPosition(), { x: 0, y: 0 });
});

test("app.js wires delegates to the module and keeps MENU_ICONS as injected dependency", async () => {
  const app = await readFile(`${root}/public/app.js`, "utf8");
  assert.ok(app.includes('from "./modules/context-menu.js"'), "app.js 必须引入抽取后的菜单模块");
  assert.ok(app.includes("const contextMenu = createContextMenu("), "app.js 必须创建展示层实例");
  for (const fn of ["menuTriggerMarkup", "hideContextMenu", "showContextMenu", "showContextMenuFromTrigger"]) {
    assert.ok(app.includes(`function ${fn}(`), `委托函数缺失：${fn}`);
  }
  assert.ok(!app.includes("lastMenuPos"), "旧模块级 lastMenuPos 必须删除（状态归工厂闭包）");
  assert.ok(!app.includes("contextMenuCleanup"), "旧模块级 contextMenuCleanup 必须删除（状态归工厂闭包）");
});
