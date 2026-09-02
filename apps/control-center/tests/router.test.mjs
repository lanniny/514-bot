import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRouter, classifyTask } from "../src/router.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(appRoot, "..", "..");
const models = JSON.parse(await readFile(resolve(repoRoot, "config/control-center/models.json"), "utf8"));
const policy = JSON.parse(await readFile(resolve(repoRoot, "config/control-center/routing.json"), "utf8"));

function health(overrides = {}) {
  const items = models.profiles.map((profile) => ({
    id: profile.id,
    status: profile.enabled ? "online" : "disabled",
    available: profile.enabled,
    reason: "test probe",
    ...overrides[profile.id],
  }));
  return { map: async () => new Map(items.map((item) => [item.id, item])) };
}

test("classifies current and technical tasks", () => {
  assert.equal(classifyTask("搜索今天最新模型变化"), "current-research");
  assert.equal(classifyTask("修复这个异常并补测试"), "debugging");
});

test("routes coding to Codex when healthy", async () => {
  const router = new ModelRouter({ profiles: models.profiles, policy, healthService: health() });
  const route = await router.preview({ taskType: "coding", prompt: "实现配置事务" });
  assert.equal(route.selected.id, "codex-technical");
  assert.match(route.reason, /Codex/);
});

test("high-risk routing requires a healthy cross-provider verifier", async () => {
  const router = new ModelRouter({ profiles: models.profiles, policy, healthService: health() });
  const route = await router.preview({ taskType: "coding", prompt: "实现配置事务", risk: "high" });
  assert.equal(route.selected.id, "codex-technical");
  assert.equal(route.independentRequired, true);
  // 复核席位随席位表与路由权重浮动（当前为 swift-responder）——
  // 不变量：必须存在、非主路、且供应商与主路不同（mustDifferFromPrimary）。
  assert.ok(route.independent, "高风险路由必须带独立复核席位");
  assert.notEqual(route.independent.id, route.selected.id);
  const byId = new Map(models.profiles.map((profile) => [profile.id, profile]));
  assert.notEqual(byId.get(route.independent.id)?.provider, byId.get(route.selected.id)?.provider);
});

test("high-risk routing fails closed when no independent provider is healthy", async () => {
  // 除主路外全员离线（随席位表自适应）——独立复核无处可选时必须 fail-closed
  const allOthersOffline = Object.fromEntries(
    models.profiles
      .filter((profile) => profile.id !== "codex-technical")
      .map((profile) => [profile.id, { status: "offline", available: false, reason: "offline" }]),
  );
  const router = new ModelRouter({
    profiles: models.profiles,
    policy,
    healthService: health(allOthersOffline),
  });
  // 排除原因必须直接出现在错误文案里——事后看日志/toast 就能定位谁把路卡死
  await assert.rejects(
    () => router.preview({ taskType: "coding", prompt: "实现配置事务", risk: "high" }),
    (error) => error.code === "NO_INDEPENDENT_ROUTE" && /independent provider \([^\)]*: offline\)/.test(error.message),
  );
});

test("current-source requirement overrides generic task classification", async () => {
  // v3.5-P2（烛 R-P2 致命2 修正）：改 mock 为 grok 可用——本测试验证的是 taskType 覆盖逻辑本身
  const router = new ModelRouter({
    profiles: models.profiles,
    policy,
    healthService: health({ "grok-search": { status: "online", available: true, reason: "probe ok" } }),
  });
  const route = await router.preview({ taskType: "planning", prompt: "模型方案", needsCurrentSource: true });
  assert.equal(route.taskType, "current-research");
  assert.equal(route.selected.id, "grok-search");
  assert.deepEqual(route.specialRoute?.allowedProviders, ["grok-search"]);
  assert.match(route.specialRoute?.reason || "", /实时来源/);
});

test("fails closed when no search-capable provider is available", async () => {
  // v3.5-P2（烛 R-P2 致命2）：gemini 已禁用、claude-cli adapter 无 MCP 不能搜索——
  // current-research 在 grok-search 不可用时必须显式 NO_ROUTE（fail-closed），
  // 而非把任务悄悄给一个不具备搜索能力的 provider（守"严禁 silent fallback"红线）
  const router = new ModelRouter({
    profiles: models.profiles,
    policy,
    healthService: health({ "grok-search": { status: "external-unverified", available: false, reason: "grok_timeout" } }),
  });
  await assert.rejects(
    () => router.preview({ taskType: "current-research", prompt: "查当前资料" }),
    (error) => error.code === "NO_ROUTE"
      && error.message.startsWith("no healthy provider can satisfy current-research")
      && error.message.includes("grok-search: grok_timeout"),
  );
});

test("special routes reject other explicit providers and expose the configured reason", async () => {
  const router = new ModelRouter({ profiles: models.profiles, policy, healthService: health() });
  await assert.rejects(
    () => router.preview({ taskType: "current-research", requestedProvider: "claude-fable" }),
    (error) => error.code === "NO_ROUTE"
      && error.candidates.find((candidate) => candidate.id === "claude-fable")?.excludedReasons
        .some((reason) => reason.includes("实时来源")),
  );
});

test("special route constraints also apply to independent-pass candidates", async () => {
  const router = new ModelRouter({ profiles: models.profiles, policy, healthService: health() });
  await assert.rejects(
    () => router.preview({ taskType: "current-research", prompt: "查当前资料并独立复核", risk: "high" }),
    (error) => error.code === "NO_INDEPENDENT_ROUTE"
      && error.candidates.length > 0
      && error.candidates.every((candidate) => candidate.excludedReasons.some((reason) => reason.includes("实时来源"))),
  );
});

test("explicit unavailable provider fails instead of silently falling back", async () => {
  const router = new ModelRouter({
    profiles: models.profiles,
    policy,
    healthService: health({ "grok-search": { status: "offline", available: false, reason: "grok_timeout" } }),
  });
  await assert.rejects(() => router.preview({ taskType: "web-search", requestedProvider: "grok-search" }), { code: "PROVIDER_UNAVAILABLE" });
});

test("team member allowlist constrains selection and empty allowlist fails closed", async () => {
  const router = new ModelRouter({ profiles: models.profiles, policy, healthService: health() });
  // 团队不含 codex 时，coding 只能在成员内选；能力标签不参与准入。
  const route = await router.preview({ taskType: "coding", prompt: "实现配置事务", allowedProviders: ["claude-fable", "grok-build"] });
  assert.equal(route.selected.id, "grok-build", "selection restricted to team members");
  const codex = route.candidates.find((item) => item.id === "codex-technical");
  assert.ok(codex.excludedReasons.includes("not a team member"));
  // 空白名单必须 NO_ROUTE，不得退化为不设限制（烛 R10 致命1）
  await assert.rejects(() => router.preview({ taskType: "coding", prompt: "实现配置事务", allowedProviders: [] }), { code: "NO_ROUTE" });
});

test("能力声明不再参与准入或评分，旧能力子集不能制造 NO_ROUTE", async () => {
  const profiles = models.profiles.map((profile) => ({ ...profile, capabilities: [] }));
  const router = new ModelRouter({ profiles, policy, healthService: health() });
  const route = await router.preview({ taskType: "coding", prompt: "实现配置事务" });
  assert.ok(route.selected.id);
  assert.equal(Object.hasOwn(route.selected, "capabilityMatch"), false);
  assert.equal(Object.hasOwn(route, "requiredCapabilities"), false);
  assert.ok(route.candidates.every((candidate) => !candidate.excludedReasons.includes("no required capability match")));
});

test("classifyTask：提到图片的编码任务不是多模态任务；真带了图才是", () => {
  // 报障原句：描述的是要实现的功能，不是要分析的对象
  assert.notEqual(classifyTask("现在协作台不能直接复制粘贴图片请你完善"), "multimodal");
  assert.notEqual(classifyTask("实现图片粘贴上传"), "multimodal");
  assert.notEqual(classifyTask("截图按钮点了没反应，修一下"), "multimodal");
  assert.equal(classifyTask("实现图片粘贴上传"), "coding");
  assert.equal(classifyTask("截图按钮报错了，修复一下"), "debugging");
  // 真带了视觉附件 → 多模态，且优先于任何关键词
  assert.equal(classifyTask("这个报错看不懂", { hasVisualAttachment: true }), "multimodal");
  assert.equal(classifyTask("实现图片粘贴上传", { hasVisualAttachment: true }), "multimodal");
  // classifyTask 本身只处理 prompt/附件；preview 层另行保证真实附件压过客户端 taskType。
  assert.equal(classifyTask("最新的 grok 定价"), "current-research");
});

test("classifyTask：打招呼和短闲聊归入 simple，不走完整 pipeline", () => {
  assert.equal(classifyTask("你好"), "simple");
  assert.equal(classifyTask("hello"), "simple");
  assert.equal(classifyTask("Hi"), "simple");
  assert.equal(classifyTask("谢谢"), "simple");
  assert.equal(classifyTask("嗯好的"), "simple");
  assert.equal(classifyTask("这个怎么用"), "simple");
  // 带任务关键词的短 prompt 不归 simple——关键词优先
  assert.equal(classifyTask("修复bug"), "debugging");
  assert.equal(classifyTask("帮我实现"), "coding");
  assert.equal(classifyTask("设计方案"), "planning");
  // 长 prompt 即使没有关键词也不归 simple（可能隐含复杂意图）
  assert.equal(classifyTask("这个系统到底是怎么运作的能不能给我详细解释一下整个架构"), "planning");
});

test("preview：附件判据由服务端传入，含'图片'字样的编码任务照常路由到在役席位", async () => {
  const router = new ModelRouter({ profiles: models.profiles, policy, healthService: health() });
  const coding = await router.preview({ prompt: "现在协作台不能直接复制粘贴图片请你完善" });
  assert.notEqual(coding.taskType, "multimodal");
  assert.ok(coding.selected.id, "报障原句仍然无法路由");
  // 真有图时落 multimodal，并且必须能选出席位（不再读取能力包络）
  const visual = await router.preview({ prompt: "看看这个", hasVisualAttachment: true });
  assert.equal(visual.taskType, "multimodal");
  assert.ok(visual.selected.id, "带图附件仍然无法路由");
});

test("显式选择 Grok Build 时，PNG 附件保持由 Grok 接收而不是 NO_ROUTE 或静默改派", async () => {
  const router = new ModelRouter({ profiles: models.profiles, policy, healthService: health() });
  const route = await router.preview({
    prompt: "请根据截图继续完善界面",
    hasVisualAttachment: true,
    visualAttachmentType: "image",
    requestedProvider: "grok-build",
    allowedProviders: ["claude-fable", "grok-build"],
  });
  assert.equal(route.taskType, "multimodal");
  assert.equal(route.selected.id, "grok-build");
  assert.equal(Object.hasOwn(route.selected, "capabilityMatch"), false);
  assert.equal(route.specialRoute, null, "图片任务是软偏好，不是特殊通道硬限制");
  assert.match(route.reason, /质量、速度、健康和成本/);
  const claude = route.candidates.find((candidate) => candidate.id === "claude-fable");
  assert.ok(claude.excludedReasons.includes("not explicitly requested"), "显式 Grok 请求不得静默改派给 Claude");
  assert.equal(route.fallbackUsed, false, "显式选中的 Grok 不是策略 fallback");
});

test("显式 Grok Build 可接收视频附件路径，能力标签不再拦截", async () => {
  const router = new ModelRouter({ profiles: models.profiles, policy, healthService: health() });
  const route = await router.preview({
    prompt: "分析这段视频",
    hasVisualAttachment: true,
    visualAttachmentType: "video",
    requestedProvider: "grok-build",
    allowedProviders: ["claude-fable", "grok-build"],
  });
  assert.equal(route.selected.id, "grok-build");
});

test("真实视频附件优先于客户端 coding taskType，但不会触发能力闸", async () => {
  const router = new ModelRouter({ profiles: models.profiles, policy, healthService: health() });
  const route = await router.preview({
    prompt: "实现视频解析",
    taskType: "coding",
    hasVisualAttachment: true,
    visualAttachmentType: "video",
    requestedProvider: "grok-build",
    allowedProviders: ["claude-fable", "grok-build"],
  });
  assert.equal(route.taskType, "multimodal");
  assert.equal(route.selected.id, "grok-build");
});

test("显式 Grok Build 可接收其他图片格式路径，失败由真实通道返回而不是路由猜测", async () => {
  const router = new ModelRouter({ profiles: models.profiles, policy, healthService: health() });
  const route = await router.preview({
    prompt: "分析这个 WebP",
    hasVisualAttachment: true,
    visualAttachmentType: "image-unverified",
    requestedProvider: "grok-build",
    allowedProviders: ["claude-fable", "grok-build"],
  });
  assert.equal(route.selected.id, "grok-build");
});

test("hasVisualSource：区分图片与视频，混合附件采用更强的视频约束", async () => {
  const { hasVisualSource, visualSourceType } = await import("../src/run-sources.mjs");
  assert.equal(hasVisualSource([{ path: "I:/shot.PNG", name: "shot.PNG" }]), true);
  assert.equal(hasVisualSource(["I:/clip.mp4"]), true);
  assert.equal(hasVisualSource([{ name: "diagram.svg" }]), true);
  assert.equal(hasVisualSource([{ name: "report.pdf" }]), false); // PDF 走 document-analysis
  assert.equal(hasVisualSource([{ name: "app.js" }, { name: "notes.md" }]), false);
  assert.equal(hasVisualSource([{ name: "png" }]), false); // 无点号的裸名不算
  assert.equal(hasVisualSource([]), false);
  assert.equal(hasVisualSource(null), false);
  assert.equal(hasVisualSource(undefined), false);
  assert.equal(visualSourceType([{ name: "shot.png" }]), "image");
  assert.equal(visualSourceType([{ name: "photo.JPEG" }]), "image");
  assert.equal(visualSourceType([{ name: "diagram.svg" }]), "image-unverified");
  assert.equal(visualSourceType([{ name: "shot.png" }, { name: "image.webp" }]), "image-unverified");
  assert.equal(visualSourceType([{ name: "clip.mp4" }]), "video");
  assert.equal(visualSourceType([{ name: "shot.png" }, { name: "clip.mp4" }]), "video");
  assert.equal(visualSourceType([{ name: "report.pdf" }]), null);
});

test("dispatch preview explains cost unknown and never creates a run", async () => {
  const router = new ModelRouter({ profiles: models.profiles, policy, healthService: health() });
  const route = await router.preview({ taskType: "coding", prompt: "实现配置事务", permissionMode: "plan" });
  assert.equal(route.createdRun, false);
  assert.equal(route.cost.status, "unknown");
  assert.equal(route.cost.usd, null);
  assert.equal(route.permissionMode, "plan");
  assert.equal(route.signals.costStatus, "unknown");
  assert.equal(typeof route.fallback.extraCalls, "number");
});

test("multimodal 判据不信客户端直提：预览端点从 sources 推导后删掉原始字段", async () => {
  const server = await readFile(resolve(appRoot, "server.mjs"), "utf8");
  const block = server.slice(server.indexOf('pathname === "/api/router/preview"'));
  const head = block.slice(0, block.indexOf("return json(response, 200"));
  assert.match(head, /const visualAttachmentType = visualSourceType\(normalizeRunSources\(input\.sources\)\)/);
  assert.match(head, /delete input\.sources/);
  assert.match(head, /input\.hasVisualAttachment = visualAttachmentType !== null/);
  assert.match(head, /input\.visualAttachmentType = visualAttachmentType/);
  // 推导必须发生在把 input 交给 router 之前
  assert.ok(head.indexOf("input.hasVisualAttachment") < block.indexOf("state.router.preview(input)"));
});
