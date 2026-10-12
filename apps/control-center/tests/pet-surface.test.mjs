/**
 * pet 面契约：瞬态脉冲枢纽、路由 kind 白名单、SSE 广播、静态资产放行。
 * 桌宠是装饰面：脉冲不落事件账本，静态白名单不放宽路径逃逸检查。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, readFile } from "node:fs/promises";

import { createPetHub } from "../src/pet/hub.mjs";
import { registerPetRoutes, petHubForTest } from "../src/pet/routes.mjs";
import {
  PUBLIC_ASSET_EXTS,
  PUBLIC_ASSET_PREFIXES,
  STATIC_ROUTES,
  contentTypeFor,
  createStaticServer,
  resolvePublicAsset,
} from "../src/static-assets.mjs";

function mockRouter() {
  const routes = new Map();
  const router = {
    use(method, prefix, handler) {
      routes.set(`${method} ${prefix}`, handler);
    },
  };
  router.get = (prefix, handler) => router.use("GET", prefix, handler);
  router.post = (prefix, handler) => router.use("POST", prefix, handler);
  return { router, routes };
}

function mockCtx() {
  const jsonCalls = [];
  let bodyPayload = { kind: "typing" };
  return {
    jsonCalls,
    setBody: (payload) => {
      bodyPayload = payload;
    },
    ctx: {
      body: async () => bodyPayload,
      json: (response, status, payload) => jsonCalls.push({ status, payload }),
    },
  };
}

function mockResponse() {
  const response = new EventEmitter();
  response.writeHeadCalls = [];
  response.written = [];
  response.writeHead = (status, headers) => {
    response.writeHeadCalls.push({ status, headers });
  };
  response.write = (chunk) => {
    response.written.push(String(chunk));
    return true;
  };
  response.end = () => {};
  return response;
}

test("pet hub broadcasts to subscribers and tolerates listener failures", () => {
  const hub = createPetHub();
  const seen = [];
  const unsubscribe = hub.subscribe((event) => seen.push(event));
  hub.subscribe(() => {
    throw new Error("listener boom");
  });
  assert.equal(hub.publish({ kind: "typing" }), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "typing");
  assert.equal(typeof seen[0].at, "number");
  unsubscribe();
  assert.equal(hub.publish({ kind: "typing" }), true);
  assert.equal(seen.length, 1, "unsubscribed listener no longer receives");
  assert.equal(hub.publish({ kind: "" }), false, "empty kind is rejected");
});

test("pet hub fails closed at subscriber capacity", () => {
  const hub = createPetHub();
  for (let index = 0; index < 8; index += 1) hub.subscribe(() => {});
  assert.throws(() => hub.subscribe(() => {}), /PET_HUB_CAPACITY|full/);
});

test("pet routes reject unknown input kinds and forward known pulses to the hub", async () => {
  const { router, routes } = mockRouter();
  const { ctx, jsonCalls, setBody } = mockCtx();
  registerPetRoutes(router, ctx);

  const inputHandler = routes.get("POST /api/pet/input");
  assert.ok(inputHandler, "POST /api/pet/input must be registered");

  setBody({ kind: "arbitrary" });
  const badResponse = mockResponse();
  const handledBad = await inputHandler({ on: () => {} }, badResponse, new URL("http://127.0.0.1/api/pet/input"), ctx);
  assert.equal(handledBad, true);
  assert.equal(jsonCalls[0].status, 400);
  assert.equal(jsonCalls[0].payload.code, "PET_INPUT_KIND");

  const hub = petHubForTest();
  const seen = [];
  const unsubscribe = hub.subscribe((event) => seen.push(event));
  setBody({ kind: "typing" });
  const goodResponse = mockResponse();
  await inputHandler({ on: () => {} }, goodResponse, new URL("http://127.0.0.1/api/pet/input"), ctx);
  setBody({ kind: "mouse" });
  const mouseResponse = mockResponse();
  await inputHandler({ on: () => {} }, mouseResponse, new URL("http://127.0.0.1/api/pet/input"), ctx);
  assert.deepEqual(seen.map((event) => event.kind), ["typing", "mouse"]);
  assert.equal(jsonCalls[1].status, 202);
  assert.equal(jsonCalls[2].status, 202);
  unsubscribe();
});

test("pet stream is a live SSE of hub pulses without replay", async () => {
  const { router, routes } = mockRouter();
  const { ctx } = mockCtx();
  registerPetRoutes(router, ctx);

  const streamHandler = routes.get("GET /api/pet/stream");
  assert.ok(streamHandler, "GET /api/pet/stream must be registered");

  const request = new EventEmitter();
  const response = mockResponse();
  const handled = await streamHandler(request, response, new URL("http://127.0.0.1/api/pet/stream"), ctx);
  assert.equal(handled, true);
  assert.equal(response.writeHeadCalls[0].status, 200);
  assert.match(response.writeHeadCalls[0].headers["content-type"], /text\/event-stream/);

  // 广播后帧到达；关流后不再收到
  petHubForTest().publish({ kind: "poke" });
  assert.ok(response.written.some((chunk) => chunk.includes("event: poke")));
  request.emit("close");
  petHubForTest().publish({ kind: "poke" });
  const pokesAfterClose = response.written.filter((chunk) => chunk.includes("event: poke")).length;
  assert.equal(pokesAfterClose, 1, "closed stream must not receive further pulses");
});

test("pet stream rejects capacity before SSE headers and releases a disconnected response", async () => {
  const { router, routes } = mockRouter();
  const { ctx, jsonCalls } = mockCtx();
  registerPetRoutes(router, ctx);
  const handler = routes.get("GET /api/pet/stream");
  const subscriptions = Array.from({ length: 8 }, () => petHubForTest().subscribe(() => {}));
  try {
    const response = mockResponse();
    await handler(new EventEmitter(), response, new URL("http://127.0.0.1/api/pet/stream"), ctx);
    assert.equal(response.writeHeadCalls.length, 0);
    assert.equal(jsonCalls[0].status, 503);
  } finally { subscriptions.forEach((unsubscribe) => unsubscribe()); }
  const response = mockResponse();
  await handler(new EventEmitter(), response, new URL("http://127.0.0.1/api/pet/stream"), ctx);
  assert.equal(petHubForTest().subscriberCount(), 1);
  response.emit("close");
  assert.equal(petHubForTest().subscriberCount(), 0);
});

test("static layer serves the pet page and its model assets without opening path escapes", async () => {
  assert.equal(STATIC_ROUTES["/pet"], "pet/index.html");
  assert.ok(PUBLIC_ASSET_PREFIXES.includes("/pet/"));
  for (const ext of [".png", ".moc3", ".flac"]) {
    assert.ok(PUBLIC_ASSET_EXTS.has(ext), `${ext} must be whitelisted for pet assets`);
  }
  assert.equal(resolvePublicAsset("/pet/pet-engine.js"), "pet/pet-engine.js");
  assert.equal(resolvePublicAsset("/vendor/pet/pixi.min.js"), "vendor/pet/pixi.min.js");
  assert.equal(resolvePublicAsset("/vendor/pet-models/bongo-standard/demomodel.moc3"), "vendor/pet-models/bongo-standard/demomodel.moc3");
  assert.equal(resolvePublicAsset("/pet/../server.mjs"), null);
  assert.equal(resolvePublicAsset("/pet/..\\server.mjs"), null);
  assert.equal(contentTypeFor("pet/index.html"), "text/html; charset=utf-8");
  assert.equal(contentTypeFor("x.png"), "image/png");
  assert.equal(contentTypeFor("x.moc3"), "application/octet-stream");
  assert.equal(contentTypeFor("x.flac"), "audio/flac");
});

test("all pinned BongoCat model modes ship complete referenced assets", async () => {
  const catalogRoot = new URL("../public/vendor/pet-models/", import.meta.url);
  const catalog = JSON.parse(await readFile(new URL("catalog.json", catalogRoot), "utf8"));
  assert.equal(catalog.commit, "5b979d85fe2cbddb064ac40cfd3e32de437891e2");
  assert.deepEqual(catalog.models.map((model) => model.id), ["standard", "keyboard", "gamepad"]);
  for (const model of catalog.models) {
    const manifestUrl = new URL(model.entry, catalogRoot);
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
    const modelRoot = new URL("./", manifestUrl);
    const refs = [
      manifest.FileReferences.Moc,
      manifest.FileReferences.DisplayInfo,
      ...manifest.FileReferences.Textures,
      ...manifest.FileReferences.Expressions.map((entry) => entry.File),
      ...Object.values(manifest.FileReferences.Motions).flat().flatMap((entry) => [entry.File, entry.Sound].filter(Boolean)),
      "resources/background.png",
      "resources/cover.png",
    ];
    await Promise.all(refs.map((relative) => access(new URL(relative, modelRoot))));
  }
  await access(new URL("LICENSE-MIT", catalogRoot));
  await access(new URL("NOTICE.md", catalogRoot));
});

test("generic models ship complete assets and stay out of the BongoCat asset contract", async () => {
  const catalogRoot = new URL("../public/vendor/pet-models/", import.meta.url);
  const catalog = JSON.parse(await readFile(new URL("catalog.json", catalogRoot), "utf8"));
  assert.ok(Array.isArray(catalog.genericModels), "genericModels must be declared separately from models");
  assert.deepEqual(catalog.genericModels.map((model) => model.id), ["whale"]);
  for (const model of catalog.genericModels) {
    const manifestUrl = new URL(model.entry, catalogRoot);
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
    const modelRoot = new URL("./", manifestUrl);
    // 通用模型没有 resources/background.png 约定，只能按自己清单里的引用核。
    const refs = [
      manifest.FileReferences.Moc,
      manifest.FileReferences.DisplayInfo,
      manifest.FileReferences.Physics,
      ...manifest.FileReferences.Textures,
      ...manifest.FileReferences.Expressions.map((entry) => entry.File),
      ...Object.values(manifest.FileReferences.Motions).flat().map((entry) => entry.File),
    ];
    assert.ok(manifest.FileReferences.Expressions.length >= 40, "expressions must be indexed");
    assert.ok(Object.keys(manifest.FileReferences.Motions).length >= 2, "motions must be indexed");
    await Promise.all(refs.map((relative) => access(new URL(relative, modelRoot))));
    await access(new URL("NOTICE.md", modelRoot));
  }
});

test("generic model declarations never reuse BongoCat-only parameters", async () => {
  const { WHALE_PET_MODEL } = await import("../public/pet/pet-models/whale.js");
  assert.equal(WHALE_PET_MODEL.kind, "generic");
  const drivable = Object.values(WHALE_PET_MODEL.drivable);
  // 猫专属参数在鲸鱼娘上 0 命中，写进去要么静默失效要么破坏物理输出。
  for (const id of ["CatParamLeftHandDown", "CatParamRightHandDown", "ParamMouseX", "ParamMouseY", "ParamCheek"]) {
    assert.ok(!drivable.includes(id), `${id} is BongoCat-only and must not be driven on a generic model`);
  }
  // Param3/4/5 在鲸鱼娘上是物理输出的眼睛高光，绝不能出现在可驱动白名单里。
  for (const id of ["Param3", "Param4", "Param5"]) {
    assert.ok(!drivable.includes(id), `${id} is a physics output on this model`);
  }
});

/**
 * 读 whale 目录下的真值：物理输出集合、表情文件写的参数、model3.json 的条目。
 * 全部从磁盘取，不读模型描述里的任何清单 —— 否则就是拿表验表。
 */
async function whaleGroundTruth() {
  const root = new URL("../public/vendor/pet-models/whale/", import.meta.url);
  const [physics, manifest] = await Promise.all([
    readFile(new URL("c_0120.physics3.json", root), "utf8").then(JSON.parse),
    readFile(new URL("c_0120.model3.json", root), "utf8").then(JSON.parse),
  ]);
  const physicsOutputs = new Set(physics.PhysicsSettings.flatMap((setting) => setting.Output.map((output) => output.Destination.Id)));
  const readExpression = async (name) => {
    const file = new URL(`expressions/${name}.exp3.json`, root);
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return new Set(parsed.Parameters.map((parameter) => parameter.Id));
  };
  return { root, physicsOutputs, readExpression, manifest };
}

/**
 * 一个表情「干净」= 它写的参数与引擎每帧写值的参数、与物理输出**都不相交**。
 * exp3 的 Blend 全是 Add，撞上引擎写值会互相抵消（表现成表情时有时无的闪烁），
 * 撞上物理输出则每帧被解算器覆盖。
 */
function collisionOf(written, driven, physicsOutputs) {
  return [...written].filter((id) => driven.has(id) || physicsOutputs.has(id));
}

test("generic expression pools are disjoint from driven and physics parameters", async () => {
  const { WHALE_PET_MODEL } = await import("../public/pet/pet-models/whale.js");
  const { physicsOutputs, readExpression } = await whaleGroundTruth();
  // 引擎每帧写的参数 = 白名单（celebrate 分支也只写白名单成员）。
  const driven = new Set(Object.values(WHALE_PET_MODEL.drivable));
  const pools = Object.entries(WHALE_PET_MODEL.expressionPools);
  assert.ok(pools.length >= 2, "ready/typing 这类长驻状态必须有轮换池");

  for (const [state, pool] of pools) {
    assert.ok(pool.length >= 4, `${state} 池太小，轮换会看起来像卡住`);
    for (const name of pool) {
      const written = await readExpression(name);
      const bad = collisionOf(written, driven, physicsOutputs);
      assert.deepEqual(bad, [], `${state} 池里的 ${name} 会与每帧写值/物理输出叠加：${bad.join(", ")}`);
    }
  }

  // 元验收：这条断言必须真的能变红，否则它只是装饰。
  // excited 是已知会撞车的表情（写 ParamEyeLOpen/ParamEyeROpen，与眨眼和引擎写值叠加）。
  const known = collisionOf(await readExpression("excited"), driven, physicsOutputs);
  assert.ok(known.length > 0, "碰撞检测器必须能识别出 excited 这种已知冲突，否则整条断言恒真");
});

test("generic model expression names all resolve to real files and manifest entries", async () => {
  const { WHALE_PET_MODEL } = await import("../public/pet/pet-models/whale.js");
  const { root, manifest } = await whaleGroundTruth();
  const declared = new Set(manifest.FileReferences.Expressions.map((entry) => entry.Name));
  const referenced = [
    ...Object.values(WHALE_PET_MODEL.stateExpression),
    ...Object.values(WHALE_PET_MODEL.expressionPools).flat(),
  ];
  assert.ok(referenced.length >= 14, "至少语义签名 + 两个轮换池都要有内容");
  for (const name of referenced) {
    assert.ok(declared.has(name), `${name} 不在 model3.json 的 Expressions 里，运行时按名寻址会拿不到`);
    await access(new URL(`expressions/${name}.exp3.json`, root));
  }
});

test("generic model emote motions resolve to real Emote entries and are played by group", async () => {
  const { WHALE_PET_MODEL } = await import("../public/pet/pet-models/whale.js");
  const { manifest } = await whaleGroundTruth();
  const group = WHALE_PET_MODEL.emoteGroup;
  const entries = manifest.FileReferences.Motions[group];
  assert.ok(entries?.length >= 2, `${group} 组必须存在且不止一个动作`);
  // 声明表里的名字必须真在这个组里（顺序可以不同，集合必须一致）。
  const files = new Set(entries.map((entry) => entry.File.replace(/^motions\//, "").replace(/\.motion3\.json$/, "")));
  assert.deepEqual([...WHALE_PET_MODEL.motions].sort(), [...files].sort());
  // 关键：欢庆必须按组名随机播，不能写死索引 —— 写死会让 N-1 个动作永远播不到。
  const engine = await readFile(new URL("../public/pet/pet-engine.js", import.meta.url), "utf8");
  assert.match(engine, /motion\?\.\(model\.emoteGroup\)/, "欢庆必须按 emoteGroup 走随机动作");
  assert.doesNotMatch(engine, /motion\?\.\("Emote",\s*0\)/, "写死 Emote 索引会让其余动作永远播不到");
});

test("the generic branch only writes whitelisted parameters", async () => {
  const { WHALE_PET_MODEL } = await import("../public/pet/pet-models/whale.js");
  const engine = await readFile(new URL("../public/pet/pet-engine.js", import.meta.url), "utf8");
  const start = engine.indexOf("function applyGenericStateParams");
  assert.ok(start > 0, "通用分支必须存在");
  const body = engine.slice(start, engine.indexOf("\nfunction ", start + 1));
  const allowed = new Set(Object.values(WHALE_PET_MODEL.drivable));
  // 分支里以字符串字面量直接写参是绕过白名单的唯一途径，逐个抓出来核。
  const literals = [...body.matchAll(/\bset\(\s*"([^"]+)"/g)].map((match) => match[1]);
  const stray = literals.filter((id) => !allowed.has(id));
  assert.deepEqual(stray, [], `通用分支写了白名单外的参数：${stray.join(", ")}`);
  assert.doesNotMatch(body, /CatParam|ParamMouse/, "通用分支绝不能出现猫专属参数");
});

test("pet ring shortcut bar has no inline-style dependency and covers every sector count", async () => {
  const appRoot = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const [ring, css, html, engine] = await Promise.all([
    readFile(`${appRoot}/public/pet/pet-ring.js`, "utf8"),
    readFile(`${appRoot}/public/pet/pet.css`, "utf8"),
    readFile(`${appRoot}/public/pet/index.html`, "utf8"),
    readFile(`${appRoot}/public/pet/pet-engine.js`, "utf8"),
  ]);
  assert.match(html, /id="pet-ring"/, "环容器必须在文档里（引擎按 id 挂载）");
  // CSP 是 style-src 'self'：环的定位若依赖内联 style 会被浏览器丢掉，环塌成一条线。
  assert.doesNotMatch(ring, /\.style\.(left|top|transform)\s*=/, "扇区定位不得写内联样式");
  assert.doesNotMatch(ring, /style="/, "不得注入 style 属性");
  assert.match(ring, /dataset\.count/, "扇区数必须以 data-count 暴露给 CSS");
  assert.match(ring, /dataset\.ringIndex/, "每个扇区必须带 data-ring-index");

  // 一级 5 个分类，二级每页最多 6 项 + 1 个翻页 = 7，所以 CSS 必须覆盖 1..7。
  // 少一档就会有扇区落在圆心（未定位 = 全部叠在一起），这是肉眼才看得出的坏。
  for (let count = 1; count <= 7; count += 1) {
    for (let index = 0; index < count; index += 1) {
      assert.match(
        css,
        new RegExp(`\\.pet-ring-list\\[data-count="${count}"\\] \\.pet-ring-item\\[data-ring-index="${index}"\\]`),
        `count=${count} 的扇区 ${index} 缺少定位规则，会叠在圆心`,
      );
    }
  }
  // 环半径 + 扇区半宽必须装得进桌宠窗口。窗口是 300×280 **再乘 scale**（0.6~1.8），
  // 所以尺寸必须随视口收缩，否则调小后环会被挤出窗口。
  const radiusRule = css.match(/--ring-radius:\s*min\((\d+)px,\s*(\d+)vmin\)/);
  const itemRule = css.match(/--ring-item:\s*min\((\d+)px,\s*(\d+)vmin\)/);
  assert.ok(radiusRule, "环半径必须同时有 px 上限与 vmin 兜底（窗口会随 scale 缩放）");
  assert.ok(itemRule, "扇区尺寸必须同时有 px 上限与 vmin 兜底");
  const radius = Number(radiusRule[1]);
  const item = Number(itemRule[1]);
  // 默认尺寸 300×280 下 vmin = 2.8px，33vmin ≈ 92px ≥ 88px，即默认行为由 px 上限决定。
  assert.ok(radius + item / 2 <= 140, `环越界：半径 ${radius} + 半宽 ${item / 2} 超过窗口半高 140`);
  const vminRadius = Number(radiusRule[2]) * 2.8;
  assert.ok(vminRadius <= radius + 4, `vmin 兜底 ${vminRadius.toFixed(1)}px 不应超过 px 上限 ${radius} 太多，否则默认尺寸下环会突然缩小`);

  // 反向指令通道：模型切换必须落服务端台账，不能只改本地。
  assert.match(engine, /createPetCommandChannel/, "桌宠页必须开指令通道");
  assert.match(engine, /type: "set-model"/, "模型切换必须走服务端指令");
  assert.match(engine, /state\.pluginRevision/, "指令必须带 revision 做 CAS");
  // 一次性演出不得永久覆盖状态驱动。
  assert.match(engine, /lastGenericExpression = null/, "环形表情播完必须交还给状态驱动");

  // 二级页查的是 options[level]，level 就是 RING_ITEMS 的 id。键名对不上会**静默**
  // 返回空数组 —— 环弹得出来、点得下去，二级却永远空白，最容易漏。
  // 这条把「引擎给的键」与「ring 读的键」钉成同一个集合：两边必须完全一致。
  const optionsLiteral = ring.match(/let options = \{([^}]*)\}/);
  assert.ok(optionsLiteral, "ring 必须声明可展开层级的键集合");
  const ringKeys = [...optionsLiteral[1].matchAll(/([a-zA-Z]+)\s*:/g)].map((match) => match[1]).sort();
  const ringOptionsBody = engine.match(/function ringOptions\(\)\s*\{[\s\S]*?return \{([\s\S]*?)\};/);
  assert.ok(ringOptionsBody, "引擎必须提供 ringOptions()");
  const engineKeys = [...ringOptionsBody[1].matchAll(/^\s*([a-zA-Z]+)\s*:/gm)].map((match) => match[1]).sort();
  assert.deepEqual(engineKeys, ringKeys, `ringOptions() 的键 ${engineKeys} 与 ring 读的键 ${ringKeys} 必须完全一致（复数/单数不一致会静默空白）`);

  // 环形菜单进阶能力：SVG 图标、激活态指示、滚轮翻页、空白点击收起
  assert.match(ring, /createRingIcon/, "环形快捷栏必须具备矢量图标支持");
  assert.match(ring, /pet-ring-icon/, "扇区按钮必须渲染图标容器");
  assert.match(ring, /classList\.add\("is-active"\)/, "当前生效的模型必须带高亮指示");
  assert.match(ring, /stageEl\.addEventListener\("wheel"/, "二级子菜单必须支持滚轮翻页");
  assert.match(ring, /stageEl\.addEventListener\("click"/, "空白处点击必须支持平滑关闭");
  assert.match(css, /\.pet-ring-item\.is-active/, "CSS 必须定义激活态样式");
  assert.match(css, /\.pet-ring-track/, "CSS 必须定义背景轨道光环");

  // 三只猫模型必须声明 expressions 和 motions，二级菜单不再空白
  const { PET_MODELS } = await import("../public/pet/pet-settings.js");
  for (const catId of ["standard", "keyboard", "gamepad"]) {
    assert.ok(Array.isArray(PET_MODELS[catId].expressions) && PET_MODELS[catId].expressions.length > 0, `${catId} 必须声明表情列表`);
    assert.ok(Array.isArray(PET_MODELS[catId].motions) && PET_MODELS[catId].motions.length > 0, `${catId} 必须声明动作列表`);
  }
  assert.match(engine, /BONGO_EXPRESSION_MAP/, "猫表情映射表必须存在");
});

test("pet ring expression and motion execution preserves state and avoids frame overrides", async () => {
  const appRoot = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const engine = await readFile(`${appRoot}/public/pet/pet-engine.js`, "utf8");
  const { WHALE_PET_MODEL } = await import("../public/pet/pet-models/whale.js");
  const { manifest } = await whaleGroundTruth();

  // 1. 鲸鱼娘 Emote 动作索引与 model3.json 必须 1:1 严格对齐（0: bubblegum .. 5: spray）
  const emoteEntries = manifest.FileReferences.Motions.Emote.map((entry) =>
    entry.File.replace(/^motions\//, "").replace(/\.motion3\.json$/, "")
  );
  assert.deepEqual([...WHALE_PET_MODEL.motions], emoteEntries, "WHALE_MOTIONS 顺序必须与 model3.json 的 Emote 列表索引 0..5 完全对齐");

  // 2. 环形菜单表情展示期间，不能被状态机 tickState / syncGenericExpression 冲掉
  assert.match(engine, /if\s*\(ringPendingExpression\s*&&\s*Date\.now\(\)\s*<\s*ringExpressionUntil\)\s*return;/, "syncGenericExpression 必须保护环形菜单选中的表情");

  // 3. 猫模型表情与动作在每帧 applyStateParams 里必须有对应维持标志，不可被下帧硬抹归零
  assert.match(engine, /isDeskSlap/, "BongoCat 拍桌动作必须在 applyStateParams 中维持");
  assert.match(engine, /isWave/, "BongoCat 挥手动作必须在 applyStateParams 中维持");
  assert.match(engine, /isAscend/, "BongoCat 升天表情必须在 applyStateParams 中维持");
  assert.match(engine, /isThugLife/, "BongoCat 墨镜表情必须在 applyStateParams 中维持");

  // 4. 通用模型动作播放或表情展示期间，applyGenericStateParams 不得强行抹平头部/嘴巴
  assert.match(engine, /isMotionPlaying/, "通用模型动作播放期间不得被每帧状态抹平");
  assert.match(engine, /isCustomExpression/, "通用模型自定义表情展示期间不得清空开眼和嘴型");
});

test("pet page keeps the transparent-window contract and QA hooks gated", async () => {
  const appRoot = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const html = await readFile(`${appRoot}/public/pet/index.html`, "utf8");
  const css = await readFile(`${appRoot}/public/pet/pet.css`, "utf8");
  const engine = await readFile(`${appRoot}/public/pet/pet-engine.js`, "utf8");
  assert.doesNotMatch(html, /<style|style="/, "CSP style-src 'self' forbids inline styles");
  assert.match(html, /data-pet-state="loading"/);
  assert.match(css, /background:\s*transparent/, "pet window must stay transparent");
  assert.match(engine, /beforeModelUpdate/, "params must be applied after motions");
  assert.match(engine, /get\("qa"\) === "1"/, "test injection must be qa-gated");
  // 顶栏已移除（2026-10-03）：它会在 300×280 的窗口里盖住模型顶部，且与「拖模型」的直觉冲突。
  // 「退出互动 / 收起」改由右键环形菜单承担 —— 移除后必须确认替代入口真的在，否则功能净损失。
  assert.doesNotMatch(html, /pet-toolbar/, "顶栏不得回归");
  assert.doesNotMatch(engine, /toolbarEl/, "引擎不得残留顶栏引用");
  assert.match(engine, /type: "pet-request", request: "close"/, "收起必须有替代入口");
  assert.match(engine, /type: "pet-request", request: "interactive-off"/, "退出互动必须有替代入口");
});

test("pet window parity with upstream: wheel, hide-on-hover, native opacity", async () => {
  const appRoot = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const [engine, css, bridge] = await Promise.all([
    readFile(`${appRoot}/public/pet/pet-engine.js`, "utf8"),
    readFile(`${appRoot}/public/pet/pet.css`, "utf8"),
    readFile(`${appRoot}/public/modules/pet-bridge.js`, "utf8"),
  ]);
  // 滚轮缩放 / Ctrl+滚轮透明度（上游 window_wheel.c：5% 一档，Ctrl 切到透明度）。
  assert.match(engine, /WHEEL_SCALE_STEP = 0\.05/, "缩放步进要对齐上游的 5%");
  assert.match(engine, /WHEEL_OPACITY_STEP = 0\.05/, "透明度步进要对齐上游的 5%");
  assert.match(engine, /event\.ctrlKey/, "Ctrl+滚轮 才调透明度");
  assert.match(engine, /addEventListener\("wheel"/, "滚轮必须真的挂上");
  // 滚轮是临时微调：上游改的是 session 值，不落持久配置。落台账会被 CAS 打爆。
  assert.doesNotMatch(engine, /persistPetSettings/, "滚轮不得触发持久化回写");

  // 鼠标移入隐藏：上游把它门控在 pass_through（穿透）下（mouse.c:18-20）。
  // 互动模式下隐藏等于自杀 —— 鼠标一进来桌宠就没了，既不能拖也不能点。
  assert.match(engine, /state\.interactive\) \{[\s\S]{0,120}hoverHidden = false/, "互动模式必须强制退出隐藏态");
  assert.match(engine, /HOVER_HIDE_DELAY_MS = 1000/, "延迟对齐上游 hide_delay_seconds 默认 1s");
  // 判定必须走原生全局光标：透明区域上页面收不到 pointerenter。
  assert.match(engine, /pet_pointer_inside/, "光标进出必须由原生判定");
  assert.match(engine, /set_pet_overlay_rect/, "页面必须上报窗口几何");

  // 整窗透明度只能由主窗口下发（原生 Win32），不能只靠 CSS。
  assert.match(bridge, /set_pet_overlay_opacity/, "主窗口必须下发整窗透明度");
  assert.doesNotMatch(css, /data-hover-hidden/, "隐藏走原生整窗透明度，不再用 CSS");
});

test("only pet document aliases allow same-origin framing including cached responses", async () => {
  const { fileURLToPath } = await import("node:url");
  const securityHeaders = { "content-security-policy": "default-src 'self'; frame-ancestors 'none'; script-src 'self'", "x-frame-options": "DENY" };
  const server = createStaticServer({ publicRoot: fileURLToPath(new URL("../public", import.meta.url)), securityHeaders });
  for (const path of ["/pet", "/pet/", "/pet/index.html"]) {
    const response = mockResponse();
    assert.equal(await server.serveStatic(path, response), true);
    const headers = response.writeHeadCalls[0].headers;
    assert.equal(headers["x-frame-options"], "SAMEORIGIN");
    assert.match(headers["content-security-policy"], /frame-ancestors 'self'/);
    assert.doesNotMatch(headers["content-security-policy"], /frame-ancestors 'none'/);
    const cached = mockResponse();
    await server.serveStatic(path, cached, { headers: { "if-none-match": headers.etag } });
    assert.equal(cached.writeHeadCalls[0].status, 304);
    assert.equal(cached.writeHeadCalls[0].headers["x-frame-options"], "SAMEORIGIN");
  }
  const main = mockResponse();
  await server.serveStatic("/", main);
  assert.equal(main.writeHeadCalls[0].headers["x-frame-options"], "DENY");
  assert.equal(securityHeaders["x-frame-options"], "DENY");
  assert.equal(resolvePublicAsset("/pet/other.html"), null);
});
