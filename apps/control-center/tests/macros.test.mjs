import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMacroStore, expandMacroTemplate, isValidMacroToken } from "../src/macros.mjs";

async function fixture() {
  return mkdtemp(join(tmpdir(), "macros-"));
}

test("macro token validation and template expansion", () => {
  assert.equal(isValidMacroToken("/daily"), true);
  assert.equal(isValidMacroToken("/release_check-1"), true);
  assert.equal(isValidMacroToken("/a"), false);
  assert.equal(isValidMacroToken("/1abc"), false);
  assert.equal(isValidMacroToken("daily"), false);
  assert.equal(isValidMacroToken("/too-long-token-name-xxxxx"), false, "25 name chars exceed the 24-char cap");

  assert.equal(expandMacroTemplate("体检：$args", "全量 深度"), "体检：全量 深度");
  assert.equal(expandMacroTemplate("对比 $1 和 $2", "alpha beta"), "对比 alpha 和 beta");
  assert.equal(expandMacroTemplate("无参数模板", ""), "无参数模板");
  assert.equal(expandMacroTemplate("缺失 $3", "a b"), "缺失 ");
});

test("macro store persists CRUD and expands case-insensitively", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createMacroStore({ dataRoot: root });

  assert.deepEqual(await store.list(), []);
  await store.create({ token: "/Daily", promptTemplate: "做一次 $args 体检" });
  await store.create({ token: "/release", promptTemplate: "跑收口链" });
  assert.equal((await store.list()).length, 2);

  assert.equal(await store.expand("/daily 全量"), "做一次 全量 体检", "token match is case-insensitive");
  assert.equal(await store.expand("/release"), "跑收口链");
  assert.equal(await store.expand("/unknown"), null, "unknown tokens pass through");
  assert.equal(await store.expand("不是命令"), null);

  await store.remove("/DAILY");
  assert.equal((await store.list()).length, 1);
  await store.remove("/release");
  assert.equal((await store.list()).length, 0);
  await assert.rejects(() => store.remove("/release"), { code: "MACRO_NOT_FOUND" });
});

test("macro store rejects invalid input and duplicates", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createMacroStore({ dataRoot: root });
  await store.create({ token: "/dup", promptTemplate: "x" });
  await assert.rejects(() => store.create({ token: "/dup", promptTemplate: "y" }), { code: "MACRO_CONFLICT" });
  await assert.rejects(() => store.create({ token: "bad", promptTemplate: "y" }), { code: "VALIDATION_FAILED" });
  await assert.rejects(() => store.create({ token: "/ok", promptTemplate: "  " }), { code: "VALIDATION_FAILED" });
  assert.throws(() => createMacroStore({}), { name: "TypeError" });
});
