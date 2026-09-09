import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_TONES, ILLUSTRATIONS, emptyState, inlineEmpty, loadingBlock, skeleton } from "../public/modules/placeholders.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const source = (relative) => readFile(join(appRoot, relative), "utf8");

// ─── 1. 设计令牌：密度乘数与可读性底线 ─────────────────────────────────────────

test("design tokens expose density multipliers with a no-op default", async () => {
  const tokens = await source("public/forge/tokens.css");
  // 默认档必须是 1：不切换密度时与改前逐像素一致
  assert.match(tokens, /--density-space:\s*1\s*;/);
  assert.match(tokens, /--density-leading:\s*1\s*;/);
  assert.match(tokens, /:root\[data-density="compact"\]\s*\{[\s\S]{0,200}--density-space:\s*0\.78/);
  assert.match(tokens, /:root\[data-density="comfortable"\]\s*\{[\s\S]{0,200}--density-space:\s*1\.28/);
  // 间距 scale 必须挂到密度乘数上，否则密度开关只是个摆设
  assert.match(tokens, /--space-4:\s*calc\(16px \* var\(--density-space\)\)/);
});

test("density rules never leak into the default档", async () => {
  const css = await source("public/forge/density.css");
  const rules = [...css.matchAll(/([^{}]+)\{/g)].map((match) => match[1].trim());
  const meaningful = rules.filter((selector) => selector && !selector.startsWith("/*") && !selector.startsWith("@"));
  assert.ok(meaningful.length > 0, "密度表必须有规则");
  for (const selector of meaningful) {
    assert.match(selector, /\[data-density="(compact|comfortable)"\]/, `未加档位限定的规则会污染默认档：${selector}`);
  }
});

test("index.html loads the new design-system layers", async () => {
  const html = await source("public/index.html");
  for (const file of ["./forge/placeholders.css", "./forge/density.css", "./forge/editorial.css"]) {
    assert.ok(html.includes(file), `index.html 未加载 ${file}`);
  }
  // 密度三档必须可达（否则 CSS 规则永远命中不了）
  for (const value of ["compact", "default", "comfortable"]) {
    assert.match(html, new RegExp(`data-appearance-density="${value}"`), `外观面板缺「${value}」档`);
  }
});

// ─── 2. 占位组件：空状态三分类 ────────────────────────────────────────────────

test("empty state covers the three documented tones", () => {
  assert.deepEqual([...EMPTY_TONES].sort(), ["error", "first-run", "no-result"]);
  for (const tone of EMPTY_TONES) {
    const html = emptyState({ tone, title: "标题" });
    assert.ok(html.includes(`empty-state--${tone}`), `${tone} 缺分类类目`);
    assert.match(html, /role="status"/, "空态必须对辅助技术可感知");
  }
});

test("empty state escapes user text and renders an icon + description", () => {
  const html = emptyState({
    tone: "first-run",
    title: "<img src=x onerror=alert(1)>",
    desc: "说明 & 更多",
    icon: "archive",
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.ok(html.includes("&lt;img src=x"));
  assert.ok(html.includes("&amp;"));
  assert.ok(html.includes('#lucide-archive'));
  assert.ok(html.includes("empty-state-desc"));
});

test("empty state actions wire to a real handler instead of a dead button", () => {
  // view → 复用 app.js 全局点击委托切视图
  assert.match(emptyState({ title: "t", action: { label: "去主机", view: "hosts" } }), /data-view="hosts"/);
  // attrs → 复用调用方现成的委托属性
  assert.match(emptyState({ title: "t", action: { label: "重试", attrs: { "data-config-host-probe": "h1" } } }), /data-config-host-probe="h1"/);
  // 退化路径：至少给出 data-empty-action，不做无属性按钮
  assert.match(emptyState({ title: "t", action: { label: "重试" } }), /data-empty-action="retry"/);
  assert.equal(emptyState({ title: "t" }).includes("<button"), false, "无动作时不渲染按钮");
});

test("inline empty is the single escape hatch for cramped spots", () => {
  const html = inlineEmpty("尚未添加", { className: "provider-opencode-empty" });
  assert.ok(html.startsWith("<p"));
  assert.ok(html.includes("inline-empty provider-opencode-empty"));
  assert.ok(html.includes("尚未添加"));
  assert.ok(inlineEmpty("<b>").includes("&lt;b&gt;"), "行内空提示同样必须转义");
});

// ─── 3. 骨架屏 ───────────────────────────────────────────────────────────────

test("skeleton exposes loading semantics and the requested row count", () => {
  const html = skeleton({ variant: "table", rows: 4, columns: 3, label: "正在读取供应商档案" });
  assert.match(html, /role="status"/);
  assert.match(html, /aria-busy="true"/);
  assert.equal((html.match(/skeleton-row/g) ?? []).length, 4);
  assert.ok(html.includes("skeleton--table"));
  assert.ok(html.includes("sr-only"), "骨架屏必须给屏幕阅读器一句可朗读的文案");
  assert.ok(html.includes("正在读取供应商档案"));
});

test("loadingBlock defaults to a list skeleton", () => {
  assert.ok(loadingBlock({ rows: 2 }).includes("skeleton--list"));
});

test("skeleton respects the reduced-motion contract", async () => {
  const css = await source("public/forge/placeholders.css");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:root\[data-motion="reduce"\]/, "用户级动效开关必须 honored");
});

test("empty state supports vector abstract illustrations", () => {
  assert.deepEqual(Object.keys(ILLUSTRATIONS).sort(), ["astrolabe", "lock", "orbit", "prism", "seal"]);
  const html = emptyState({
    tone: "first-run",
    title: "欢迎开启协作",
    desc: "选择或创建任务",
    illustration: "astrolabe",
  });
  assert.ok(html.includes("empty-state-illustration"));
  assert.ok(html.includes("<svg"));
});

// ─── 4. 展示轨与先锋排版（UI-ELEVATION W1）──────────────────────────────────────

test("tokens.css exposes fluid clamp display scale and editorial typography tokens", async () => {
  const tokens = await source("public/forge/tokens.css");
  for (const tier of ["xs", "sm", "md", "lg", "xl", "2xl"]) {
    assert.match(tokens, new RegExp(`--display-${tier}:\\s*clamp\\(`), `tokens.css 缺流体标量 --display-${tier}`);
  }
  assert.match(tokens, /--leading-display:/, "缺展示轨行高 --leading-display");
  assert.match(tokens, /--tracking-display:/, "缺展示轨负字距 --tracking-display");
  assert.match(tokens, /--font-editorial:/, "缺衬线展示栈 --font-editorial");
});

test("legacy views retain editorial headings while Bot and configuration use compact headings", async () => {
  const html = await source("public/index.html");
  assert.match(html, /<h1 id="bot-title">工作对话<\/h1>/);
  assert.match(html, /<h1 id="config-title" tabindex="-1">运行席位<\/h1>/);
  const expectedViewTitles = [
    "overview-title",
    "workbench-title",
    "team-title",
    "appearance-title",
    "browser-title",
    "security-title",
    "observability-title",
    "sessions-title",
    "bootstrapper-title",
    "channels-title",
    "office-title",
    "terminal-title",
    "market-title",
    "hosts-title",
  ];
  for (const id of expectedViewTitles) {
    const pattern = new RegExp(`<h1[^>]*id="${id}"[^>]*class="[^"]*editorial-headline[^"]*"|<h1[^>]*class="[^"]*editorial-headline[^"]*"[^>]*id="${id}"`);
    assert.match(html, pattern, `视图标题 #${id} 必须挂载 editorial-headline`);
  }
});

test("empty state typography elevates to display track in placeholders.css", async () => {
  const css = await source("public/forge/placeholders.css");
  assert.match(css, /--display-xs/, "非紧凑型空态必须消费展示轨 --display-xs");
  assert.match(css, /--font-editorial/, "非紧凑型空态必须使用 --font-editorial");
  assert.match(css, /\.empty-state--compact/, "必须守住 --compact 紧凑态密度");
});

// ─── 5. 动效编排与视图切换（UI-ELEVATION W2）──────────────────────────────────

test("motion.css defines View Transitions API rules with duration tokens and reduced-motion kill-switch", async () => {
  const css = await source("public/forge/motion.css");
  assert.match(css, /::view-transition-old\(root\)/, "必须定义 ::view-transition-old(root)");
  assert.match(css, /::view-transition-new\(root\)/, "必须定义 ::view-transition-new(root)");
  assert.match(css, /var\(--dur-fast\)/, "退出动画必须消费 --dur-fast 令牌");
  assert.match(css, /var\(--dur-med\)/, "入场动画必须消费 --dur-med 令牌");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?::view-transition-group\(\*\)/, "reduced-motion 必须清空视图过渡");
  assert.match(css, /:root\[data-motion="reduce"\][\s\S]*?::view-transition-group\(\*\)/, "data-motion=reduce 必须清空视图过渡");
});

test("motion.css defines choreography primitives (.forge-stagger-item, .forge-reveal-scroll)", async () => {
  const css = await source("public/forge/motion.css");
  assert.match(css, /\.forge-stagger-item/, "必须提供阶梯编排类名 .forge-stagger-item");
  assert.match(css, /@supports \(animation-timeline: scroll\(\)\)[\s\S]*?\.forge-reveal-scroll/, "必须提供滚动驱动揭示 .forge-reveal-scroll");
});

test("app.js setView guards document.startViewTransition behind motion accessibility checks", async () => {
  const js = await source("public/app.js");
  assert.match(js, /document\.startViewTransition\(updateActivePanel\)/, "setView 必须在支持时使用 startViewTransition");
  assert.match(js, /prefers-reduced-motion: reduce/, "setView 必须检测 prefers-reduced-motion");
  assert.match(js, /dataset\.motion !== "reduce"/, "setView 必须检测 data-motion=reduce");
});

// ─── 6. 材质与光场（UI-ELEVATION W3）──────────────────────────────────────────

test("art-direction.css establishes living material layers with subtle grain and disabled orb", async () => {
  const css = await source("public/forge/art-direction.css");
  assert.match(css, /\.atelier-grain\s*\{[^}]*display:\s*block;/, "atelier-grain 必须激活单一真源");
  assert.match(css, /\.atelier-orb\s*\{[^}]*display:\s*none;/, "atelier-orb 必须保持禁用");
  assert.match(css, /#atelier-canvas\s*\{[^}]*display:\s*block;/, "atelier-canvas 拓扑语义层必须保持启用");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.atelier-grain/, "reduced-motion 下必须隐藏 grain");
  assert.match(css, /:root\[data-motion="reduce"\][\s\S]*?\.atelier-grain/, "data-motion=reduce 下必须隐藏 grain");
});

test("primitives.css provides forge-glass surface and specular reflection tokens", async () => {
  const css = await source("public/forge/primitives.css");
  assert.match(css, /\.forge-glass\s*\{/, "primitives.css 必须提供 .forge-glass 原语");
  assert.match(css, /--glass-specular/, "primitives.css 必须消费 --glass-specular 高光入射令牌");
  assert.match(css, /\.forge-glass-card\s*\{/, "primitives.css 必须提供 .forge-glass-card 晶体折射卡片");
});

// ─── 7. 先锋交互装置（UI-ELEVATION W4）──────────────────────────────────────────

test("motion.css defines forge-magnetic with spring transition and reduced-motion safeguard", async () => {
  const css = await source("public/forge/motion.css");
  assert.match(css, /\.forge-magnetic\s*\{[^}]*var\(--ease-spring\)/, "forge-magnetic 必须消费 --ease-spring");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.forge-magnetic/, "reduced-motion 下必须清空 forge-magnetic");
  assert.match(css, /:root\[data-motion="reduce"\][\s\S]*?\.forge-magnetic/, "data-motion=reduce 下必须清空 forge-magnetic");
});

test("editorial.css defines editorial-reveal masked entrance for hero headlines", async () => {
  const css = await source("public/forge/editorial.css");
  assert.match(css, /\.editorial-reveal/, "editorial.css 必须提供 .editorial-reveal 遮罩揭示原语");
  assert.match(css, /clip-path:\s*inset/, "editorial-reveal 必须使用 clip-path 遮罩切光");
});

test("overview.css elevates metric-card with glass specular and hover lift", async () => {
  const css = await source("public/forge/overview.css");
  assert.match(css, /#view-overview \.metric-card\s*\{[^}]*--glass-specular/, "Overview metric-card 必须消费 --glass-specular");
  assert.match(css, /#view-overview \.metric-card:hover\s*\{[^}]*translateY\(-2px\)/, "Overview metric-card hover 必须拥有微悬浮手感");
});

test("app.js implements initMagneticInteractions with fine pointer check and reduced-motion guard", async () => {
  const js = await source("public/app.js");
  assert.match(js, /function initMagneticInteractions\(\)/, "app.js 必须定义 initMagneticInteractions");
  assert.match(js, /pointer:\s*fine/, "磁吸手感必须严格限定精确指针 (pointer: fine)");
  assert.match(js, /initMagneticInteractions\(\);/, "start() 必须调用 initMagneticInteractions");
});

// ─── 8. 逐面精修与终局收官（UI-ELEVATION W5）──────────────────────────────────

test("workbench.css and data.css elevate interactive shells with glass specular", async () => {
  const workbenchCss = await source("public/forge/workbench.css");
  assert.match(workbenchCss, /\.task-composer \.composer-shell\s*\{[^}]*--glass-specular/, "workbench.css composer-shell 必须消费 --glass-specular");
  const dataCss = await source("public/forge/data.css");
  assert.match(dataCss, /\.view \.table-scroll,\s*\.view \.event-table-wrap\s*\{[^}]*--glass-specular/, "data.css 数据表格外壳必须消费 --glass-specular");
});

test("legacy views retain editorial reveal without entrance animation on task surfaces", async () => {
  const html = await source("public/index.html");
  assert.doesNotMatch(html, /<h1[^>]*id="bot-title"[^>]*editorial-reveal/);
  assert.doesNotMatch(html, /<h1[^>]*id="config-title"[^>]*editorial-reveal/);
  const expectedViewTitles = [
    "overview-title",
    "workbench-title",
    "team-title",
    "appearance-title",
    "browser-title",
    "security-title",
    "observability-title",
    "sessions-title",
    "bootstrapper-title",
    "channels-title",
    "office-title",
    "terminal-title",
    "market-title",
    "hosts-title",
  ];
  for (const id of expectedViewTitles) {
    const pattern = new RegExp(`<h1[^>]*id="${id}"[^>]*class="[^"]*editorial-reveal[^"]*"|<h1[^>]*class="[^"]*editorial-reveal[^"]*"[^>]*id="${id}"`);
    assert.match(html, pattern, `视图标题 #${id} 必须挂载 editorial-reveal`);
  }
});
