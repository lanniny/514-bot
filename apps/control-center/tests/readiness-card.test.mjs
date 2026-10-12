import test from "node:test";
import assert from "node:assert/strict";
import { readinessCardMarkup, readinessViewModel } from "../public/modules/readiness-card.js";
import { readFile } from "node:fs/promises";

test("readiness card preserves unknown state and exposes the next real action", () => {
  const model = readinessViewModel({
    ready: false,
    steps: [
      { id: "project-anchor", status: "ready", title: "项目锚点", detail: "已识别" },
      { id: "executable-seat", status: "blocked", title: "可执行席位", detail: "没有可执行席位", nextStep: "配置一个 CLI" },
    ],
    nextAction: { text: "配置一个 CLI" },
  });
  assert.equal(model.next.id, "executable-seat");
  const html = readinessCardMarkup({
    ready: false,
    steps: [
      { id: "project-anchor", status: "ready", title: "项目锚点", detail: "已识别" },
      { id: "executable-seat", status: "blocked", title: "可执行席位", detail: "没有可执行席位", nextStep: "配置一个 CLI" },
    ],
  });
  assert.match(html, /data-readiness-action="config:sources"/);
  assert.match(html, /没有可执行席位/);
  assert.match(html, /待处理/);
});

test("ready state is explicit and does not invent steps", () => {
  const html = readinessCardMarkup({ ready: true, steps: [{ id: "default-team", status: "ready", title: "默认团队", detail: "默认团队" }] });
  assert.match(html, /data-readiness-state="ready"/);
  assert.match(html, /可以开始派工/);
  assert.doesNotMatch(html, /配置席位/);
});

test("loading and error states remain actionable", () => {
  assert.match(readinessCardMarkup(null), /正在检查你的工作环境/);
  assert.match(readinessCardMarkup({ error: "服务端不可用" }), /打开健康页/);
  assert.match(readinessCardMarkup({ error: "服务端不可用" }), /服务端不可用/);
});

test("Bot welcome surface consumes the server readiness contract", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /loadReadiness\(\)/);
  assert.match(app, /readinessCardMarkup\(state\.readinessLoading/);
  assert.match(app, /data-readiness-action/);
  assert.match(app, /API\.readiness/);
});
