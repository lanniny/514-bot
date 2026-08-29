/**
 * 一键壁纸同步契约（任务 #11）：
 * 「同步此壁纸到所有团队」按钮的防漂移栅栏。
 *
 * 覆盖：
 *   1. 交互落点：按钮在 #team-background-picker 区域内渲染，复用既有按钮类、
 *      无内联 style（CSP style-src 'self'），且在 app.js 元素注册表与
 *      renderTeamBackgroundPicker 的只读门控（内置团队不可见）双侧在册。
 *   2. 确认门控：点击绑定直达 syncTeamBackgroundToAllTeams，函数体内任何
 *      request() 之前必须经过 confirmAction 且拒绝即返回；同步通道只送
 *      appearance 补丁走既有 PUT /api/teams/:id，不新增端点。
 *   3. 保护规则（行为层）：teamBgSyncTargets 在 vm 沙箱内真实求值——
 *      内置团队与源团队自身必须被剔除，只留其他用户团队；
 *      服务端 update() 对内置团队的 FROZEN_BLOCK 作为纵深防御在册。
 *   4. HTTP 往返（隔离服务）：无自定义媒体的用户团队，按客户端同路径
 *      （PUT appearance 补丁）同步后回读一致，内置团队配置不变，
 *      直接 PUT 内置团队被 403 拒绝；预设分支先 PUT 清标记再 DELETE 残留字节。
 *   5. 自定义媒体端到端（隔离服务）：字节逐团队复制后回读与源一致且标记归
 *      image:"custom"；目标改走预设同步后孤儿字节被清（404 BACKGROUND_NOT_FOUND）
 *      且标记归空。
 *
 * 读源码断言 + vm 行为断言 + 隔离服务端往返，不起浏览器。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { spawnTestServer, stopTestServer, waitForUrl } from "./server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

async function source(path) {
  return (await readFile(`${appRoot}/${path}`, "utf8")).replace(/\r\n/g, "\n");
}

/** 从 startMarker 后第一个开括号起做括号配平截取，得到可断言的代码块。 */
function extractBlock(sourceText, startMarker, open = "{", close = "}") {
  const start = sourceText.indexOf(startMarker);
  assert.ok(start >= 0, `找不到契约锚点：${startMarker}`);
  const openIndex = sourceText.indexOf(open, start);
  let depth = 0;
  for (let index = openIndex; index < sourceText.length; index += 1) {
    if (sourceText[index] === open) depth += 1;
    else if (sourceText[index] === close) {
      depth -= 1;
      if (depth === 0) return sourceText.slice(start, index + 1);
    }
  }
  assert.fail(`括号配平失败：${startMarker}`);
}

test("同步按钮落点在背景区块内，注册/渲染门控双侧在册且无内联 style", async () => {
  const html = await source("public/index.html");
  const app = await source("public/app.js");

  // 按钮必须落在 #team-background-picker 区块内（滑杆之后、区块收尾之前）。
  const pickerStart = html.indexOf('id="team-background-picker"');
  const buttonStart = html.indexOf('id="team-bg-sync-all"');
  const pickerEnd = html.indexOf('id="team-bg-sync-all"') > 0 ? html.indexOf("供应商绑定", pickerStart) : -1;
  assert.ok(pickerStart >= 0, "index.html 缺少 #team-background-picker");
  assert.ok(buttonStart > pickerStart, "同步按钮必须位于背景选择器区块内");
  assert.ok(buttonStart < pickerEnd, "同步按钮不得越出背景区块（须位于供应商绑定段之前）");
  const button = html.match(/<button[^>]*id="team-bg-sync-all"[^>]*>/);
  assert.ok(button, "缺少 #team-bg-sync-all 按钮");
  assert.doesNotMatch(button[0], /style=/, "同步按钮不得内联 style（CSP style-src 'self' 会拦截）");
  assert.match(button[0], /class="[^"]*button secondary/, "同步按钮必须复用既有 secondary 按钮类");

  // app.js 元素注册表在册，否则 elements["team-bg-sync-all"] 恒为 null。
  assert.match(app, /"team-bg-sync-all",/, "app.js 元素注册表缺 team-bg-sync-all");

  // 渲染门控：内置只读团队、未落盘草稿、无壁纸源（无预设且无自定义媒体）不得看见同步入口。
  const render = extractBlock(app, "function renderTeamBackgroundPicker(");
  assert.match(render, /syncAll\.hidden = readOnly \|\| !team\?\.id \|\| !hasWallpaper/, "renderTeamBackgroundPicker 缺同步按钮的只读/无团队/无壁纸门控");
  assert.match(render, /const hasWallpaper = hasImage \|\| \(preset && preset !== "none"\);/, "无壁纸判定必须同时看自定义媒体与预设（非 none）");
});

test("点击路径有确认门控：confirmAction 先于任何请求，且通道只送 appearance 补丁", async () => {
  const app = await source("public/app.js");

  // 点击绑定直达同步函数（不经草稿保存路径）。
  assert.match(
    app,
    /elements\["team-bg-sync-all"\]\?\.addEventListener\("click", \(\) => void syncTeamBackgroundToAllTeams\(\)\)/,
    "同步按钮点击必须绑定 syncTeamBackgroundToAllTeams",
  );

  const sync = extractBlock(app, "async function syncTeamBackgroundToAllTeams(");
  const confirmIndex = sync.indexOf("confirmAction(");
  const firstRequestIndex = sync.indexOf("await request(");
  const firstBlobIndex = sync.indexOf("await requestBlob(");
  assert.ok(confirmIndex >= 0, "同步函数必须经过 confirmAction 确认门控");
  assert.match(sync, /if \(!proceed\) return;/, "确认被拒必须直接返回，不得发起任何写入");
  assert.ok(confirmIndex < firstRequestIndex, "confirmAction 必须先于任何 PUT/POST/DELETE 请求");
  assert.ok(confirmIndex < firstBlobIndex, "confirmAction 必须先于媒体字节拉取");

  // 通道契约：逐团队走既有 PUT /api/teams/:id，只送 appearance 补丁（目标团队
  // 的名称/成员/提示词不动）；不新增服务端端点。
  assert.match(sync, /body: \{ appearance: appearancePatch \}/, "同步 PUT 必须只携带 appearance 补丁");
  assert.match(sync, /`\$\{API\.teams\}\/\$\{encodeURIComponent\(target\.id\)\}`/, "同步必须走既有 /api/teams/:id 通道");

  // 同步面契约：只复制背景相关字段（壁纸/滤镜/动效/播放），玻璃/字体等全局偏好不入面。
  for (const field of ["background:", "motion:", "filter:", "playback:"]) {
    assert.ok(sync.includes(field), `appearancePatch 缺同步字段：${field}`);
  }
  for (const forbidden of ["glass", "fontFace", "accent"]) {
    assert.ok(!sync.toLowerCase().includes(forbidden), `同步面不得携带全局偏好：${forbidden}`);
  }

  // 活跃团队被覆盖后必须刷新舞台。
  assert.match(sync, /applyActiveTeamBackground\(\)/, "同步成功后必须按需重挂氛围层");
});

test("预设同步顺序：先 PUT 落 image:\"\" 清标记，成功后才 DELETE 残留字节", async () => {
  const app = await source("public/app.js");
  const sync = extractBlock(app, "async function syncTeamBackgroundToAllTeams(");

  // 预设分支（非 custom 的 else 段）：DELETE 反转会在 PUT 失败时留下「字节已删但标记仍指 custom」的悬空态。
  const loopStart = sync.indexOf("for (const target of targets)");
  assert.ok(loopStart >= 0, "缺少逐团队同步循环");
  const elseBranch = sync.slice(sync.indexOf("} else {", loopStart));
  const putIndex = elseBranch.indexOf('method: "PUT"');
  const deleteIndex = elseBranch.indexOf('method: "DELETE"');
  assert.ok(putIndex >= 0 && deleteIndex >= 0, "预设分支必须同时包含 PUT 与 DELETE");
  assert.ok(putIndex < deleteIndex, "预设分支必须先 PUT 清标记再 DELETE 残留字节（破坏性顺序反转会悬空标记）");

  // DELETE 不得依赖本地可能陈旧的 target.appearance 快照判定（幂等清理无条件走）。
  assert.ok(!sync.includes('target.appearance?.background?.image === "custom"'),
    "DELETE 判定不得依赖本地可能陈旧的 target.appearance 快照");
  assert.match(elseBranch, /await request\(API\.teamBackground\(target\.id\), \{ method: "DELETE" \}\);/,
    "预设分支必须无条件幂等清理残留字节");
});

test("自定义媒体同步失败附注与循环节流渲染在册", async () => {
  const app = await source("public/app.js");
  const sync = extractBlock(app, "async function syncTeamBackgroundToAllTeams(");

  // POST 字节成功但 PUT 失败 = 「新字节+旧配置」半成品，失败清单必须附注区分。
  assert.match(sync, /bytesWritten/, "同步循环必须跟踪目标字节写入态");
  assert.match(sync, /\$\{bytesWritten \? "（壁纸字节已写入，仅配置未更新）" : ""\}/,
    "失败清单必须对字节已写入的半成品附注");

  // 节流渲染：循环内不得全量级联渲染，循环结束后统一渲染一次。
  assert.ok(!sync.includes("replaceTeamInState("), "同步循环内不得逐目标触发 replaceTeamInState 全量渲染");
  assert.match(sync, /upsertTeamInState\(saved\);/, "循环内只更数组项（无渲染）");
  const loopEnd = sync.indexOf("}", sync.lastIndexOf("upsertTeamInState(saved);") + 1);
  const renderIndex = sync.indexOf("renderTeams();");
  assert.ok(renderIndex > loopEnd, "全量渲染必须在逐团队循环结束后统一走一次");
});

test("保护规则：内置团队与源团队被跳过（行为层），服务端冻结作纵深防御", async () => {
  const app = await source("public/app.js");
  const teamsSource = await source("src/teams.mjs");

  // 行为层：把 teamBgSyncTargets 原文喂进 vm 沙箱真实求值——过滤逻辑是
  // 保护规则的核心，不能只靠源码字面断言。
  const targetsSource = extractBlock(app, "function teamBgSyncTargets(");
  const state = {
    teams: [
      { id: "team-514cc", name: "514cc", builtin: true },
      { id: "team-source", name: "壁纸源", builtin: false },
      { id: "team-other-a", name: "甲", builtin: false },
      { id: "team-other-b", name: "乙", builtin: false },
      { id: "", name: "无标识幽灵", builtin: false },
    ],
  };
  const targets = vm.runInNewContext(`(${targetsSource})("team-source")`, { state });
  assert.deepEqual(
    targets.map((team) => team.id),
    ["team-other-a", "team-other-b"],
    "同步目标必须剔除内置团队、源团队自身与无标识记录",
  );

  // 源码层：同步入口对只读内置源团队直接拒绝。
  const sync = extractBlock(app, "async function syncTeamBackgroundToAllTeams(");
  assert.match(sync, /if \(!source \|\| source\.builtin \|\| teamBgSyncBusy \|\| teamBgUploadBusy\) return;/, "内置团队作为同步源必须被拒绝");
  assert.match(sync, /teamBgSyncTargets\(source\.id\)/, "同步目标清单必须来自带保护过滤的 teamBgSyncTargets");

  // 纵深防御：即便客户端过滤失效，服务端 update()/背景端点对内置团队也是冻结的。
  assert.match(teamsSource, /if \(id === BUILTIN_TEAM\.id\) fail\("the builtin 514cc team is frozen and cannot be modified", "FROZEN_BLOCK"\)/, "服务端 update 必须冻结内置团队");
});

test("同步通道 HTTP 往返：appearance 补丁逐团队生效且内置团队不可变", { timeout: 90_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-wallpaper-sync-"));
  const token = "e2e-wallpaper-sync-token-0123456789";
  const env = {
    CONTROL_CENTER_TOKEN: token,
    CONTROL_CENTER_DATA_DIR: dataRoot,
    CONTROL_CENTER_PORT: "0",
  };
  const child = spawnTestServer({ env });
  t.after(async () => {
    if (child && child.exitCode == null && child.signalCode == null) {
      await stopTestServer(child, { token }).catch(() => {});
    }
    await rm(dataRoot, { recursive: true, force: true });
  });

  const origin = new URL(await waitForUrl(child)).origin;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  // 两个无自定义媒体的用户团队：A 为壁纸源，B 为同步目标。
  const createTeam = async (name) => {
    const response = await fetch(`${origin}/api/teams`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name, members: ["codex-technical"] }),
    });
    assert.equal(response.status, 201, `创建团队 ${name} 失败`);
    return response.json();
  };
  const teamA = await createTeam("壁纸源团队");
  const teamB = await createTeam("壁纸目标团队");

  // 给 A 设置完整氛围配置（走既有 PUT /api/teams/:id，服务端 cleanBackground 清洗）。
  const sourceAppearance = {
    background: { preset: "aurora", image: "" },
    motion: "rich",
    filter: { blur: 6, brightness: 1.1, contrast: 1.05, saturation: 0.9, dim: 0.2 },
    playback: { rate: 1.5, flipped: true, paused: false },
  };
  const putA = await fetch(`${origin}/api/teams/${encodeURIComponent(teamA.id)}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ appearance: sourceAppearance }),
  });
  assert.equal(putA.status, 200, "给源团队设置壁纸失败");
  const savedA = await putA.json();
  assert.deepEqual(savedA.appearance, sourceAppearance, "源团队氛围配置落盘必须与请求一致");

  // 模拟客户端同步路径：按保护规则筛目标（非内置、非源），逐团队只送 appearance 补丁。
  const listResponse = await fetch(`${origin}/api/teams`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(listResponse.status, 200);
  const { teams } = await listResponse.json();
  const targets = teams.filter((team) => team?.id && team.id !== teamA.id && !team.builtin);
  assert.deepEqual(targets.map((team) => team.id), [teamB.id], "保护过滤后目标应只剩 B");
  for (const target of targets) {
    const response = await fetch(`${origin}/api/teams/${encodeURIComponent(target.id)}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ appearance: savedA.appearance }),
    });
    assert.equal(response.status, 200, `同步到 ${target.name} 失败`);
  }

  // 回读验证：B 拿到与 A 相同的氛围配置，且 B 的名称/成员未被同步面污染。
  const verifyResponse = await fetch(`${origin}/api/teams`, { headers: { authorization: `Bearer ${token}` } });
  const { teams: afterTeams } = await verifyResponse.json();
  const afterA = afterTeams.find((team) => team.id === teamA.id);
  const afterB = afterTeams.find((team) => team.id === teamB.id);
  const builtin = afterTeams.find((team) => team.id === "team-514cc");
  assert.deepEqual(afterB.appearance, savedA.appearance, "目标团队必须拿到与源团队一致的氛围配置");
  assert.equal(afterB.name, "壁纸目标团队", "同步不得改动目标团队的名称");
  assert.deepEqual(afterB.members, ["codex-technical"], "同步不得改动目标团队的成员");
  assert.deepEqual(afterA.appearance, sourceAppearance, "源团队自身不得被同步改动");
  assert.deepEqual(builtin.appearance, { background: { preset: "none", image: "" } }, "内置团队氛围配置必须保持出厂态");

  // 纵深防御：客户端过滤若失效，直接 PUT 内置团队也必须被服务端 403 拒绝。
  const frozen = await fetch(`${origin}/api/teams/team-514cc`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ appearance: sourceAppearance }),
  });
  assert.equal(frozen.status, 403, "直接 PUT 内置团队必须被冻结拒绝");
  const frozenBody = await frozen.json();
  assert.equal(frozenBody?.error?.code, "FROZEN_BLOCK");

  await stopTestServer(child, { token });
});

// 与 avatars.test.mjs 同款最小合法 JPEG（同步面端到端只需合法字节载体，不依赖外部资源）
function minimalJpeg() {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0xff, 0xd9,
  ]);
}

function jpegDataUrl() {
  return `data:image/jpeg;base64,${minimalJpeg().toString("base64")}`;
}

test("自定义媒体同步端到端：字节复制回读一致，预设同步清孤儿字节", { timeout: 90_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-wallpaper-media-"));
  const token = "e2e-wallpaper-media-token-0123456789";
  const env = {
    CONTROL_CENTER_TOKEN: token,
    CONTROL_CENTER_DATA_DIR: dataRoot,
    CONTROL_CENTER_PORT: "0",
  };
  const child = spawnTestServer({ env });
  t.after(async () => {
    if (child && child.exitCode == null && child.signalCode == null) {
      await stopTestServer(child, { token }).catch(() => {});
    }
    await rm(dataRoot, { recursive: true, force: true });
  });

  const origin = new URL(await waitForUrl(child)).origin;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const createTeam = async (name) => {
    const response = await fetch(`${origin}/api/teams`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name, members: ["codex-technical"] }),
    });
    assert.equal(response.status, 201, `创建团队 ${name} 失败`);
    return response.json();
  };
  const teamA = await createTeam("媒体源团队");
  const teamB = await createTeam("媒体目标团队");

  // ① 源团队上传自定义媒体：POST 后服务端自动落 image:"custom" 标记。
  const postA = await fetch(`${origin}/api/team-backgrounds/${encodeURIComponent(teamA.id)}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ dataUrl: jpegDataUrl() }),
  });
  assert.equal(postA.status, 200, "源团队上传自定义媒体失败");
  const savedA = await postA.json();
  assert.equal(savedA.appearance?.background?.image, "custom", "上传后标记必须归 image:custom");
  const bytesA = Buffer.from(await (await fetch(`${origin}/api/team-backgrounds/${encodeURIComponent(teamA.id)}`, {
    headers: { authorization: `Bearer ${token}` },
  })).arrayBuffer());
  assert.ok(bytesA.length > 0, "源团队字节回读不得为空");
  assert.deepEqual(bytesA, minimalJpeg(), "源团队字节必须与上传内容一致");

  // 按客户端同路径同步到目标：先 POST 字节，再 PUT appearance 补丁（image:"custom"）。
  const postB = await fetch(`${origin}/api/team-backgrounds/${encodeURIComponent(teamB.id)}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ dataUrl: jpegDataUrl() }),
  });
  assert.equal(postB.status, 200, "目标团队字节复制失败");
  const customPatch = {
    background: { preset: "none", image: "custom" },
    motion: "off",
    filter: { blur: 0, brightness: 1, contrast: 1, saturation: 1, dim: 0 },
    playback: { rate: 1, flipped: false, paused: false },
  };
  const putB = await fetch(`${origin}/api/teams/${encodeURIComponent(teamB.id)}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ appearance: customPatch }),
  });
  assert.equal(putB.status, 200, "目标团队配置同步失败");
  const savedB = await putB.json();
  assert.equal(savedB.appearance?.background?.image, "custom", "同步后目标标记必须归 image:custom");

  // 回读字节一致：目标端 GET 回的字节与源团队逐字节相同。
  const readB = await fetch(`${origin}/api/team-backgrounds/${encodeURIComponent(teamB.id)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(readB.status, 200, "目标团队字节回读失败");
  const bytesB = Buffer.from(await readB.arrayBuffer());
  assert.deepEqual(bytesB, bytesA, "同步后目标字节必须与源团队一致");

  // ② 目标已持自定义媒体，源改走预设：按修复后顺序（先 PUT 清标记，再 DELETE 字节）同步。
  const presetPatch = {
    background: { preset: "aurora", image: "" },
    motion: "off",
    filter: { blur: 0, brightness: 1, contrast: 1, saturation: 1, dim: 0 },
    playback: { rate: 1, flipped: false, paused: false },
  };
  const putBPreset = await fetch(`${origin}/api/teams/${encodeURIComponent(teamB.id)}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ appearance: presetPatch }),
  });
  assert.equal(putBPreset.status, 200, "预设同步的 PUT 失败");
  const afterPut = await putBPreset.json();
  assert.equal(afterPut.appearance?.background?.image, "", "PUT 成功后标记必须先归空（不留悬空 custom）");
  const deleteB = await fetch(`${origin}/api/team-backgrounds/${encodeURIComponent(teamB.id)}`, {
    method: "DELETE",
    headers,
  });
  assert.equal(deleteB.status, 200, "清理目标残留字节失败");
  await deleteB.json();

  // 孤儿字节已清：目标字节 404（BACKGROUND_NOT_FOUND），标记归空。
  const goneB = await fetch(`${origin}/api/team-backgrounds/${encodeURIComponent(teamB.id)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(goneB.status, 404, "预设同步后目标字节必须不可读");
  const goneBody = await goneB.json();
  assert.equal(goneBody?.error?.code, "BACKGROUND_NOT_FOUND", "字节缺失必须报 BACKGROUND_NOT_FOUND");
  const listAfter = await (await fetch(`${origin}/api/teams`, { headers: { authorization: `Bearer ${token}` } })).json();
  const finalB = listAfter.teams.find((team) => team.id === teamB.id);
  assert.equal(finalB.appearance?.background?.image, "", "预设同步后目标标记必须归空");
  assert.equal(finalB.appearance?.background?.preset, "aurora", "预设同步后目标必须持有源预设");
  // 幂等性：再 DELETE 一次不得报错（文件不存在即 no-op）。
  const deleteAgain = await fetch(`${origin}/api/team-backgrounds/${encodeURIComponent(teamB.id)}`, {
    method: "DELETE",
    headers,
  });
  assert.equal(deleteAgain.status, 200, "clearTeamBackground 必须幂等（重复 DELETE 无副作用）");
  await deleteAgain.json();

  await stopTestServer(child, { token });
});
