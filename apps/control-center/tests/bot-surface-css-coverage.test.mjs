/**
 * bot-surface-css-coverage.test.mjs — 「渲染了但没有样式」的机械门禁。
 *
 * 为什么需要它：2026-10-09 一次四路独立审计（unstyled-markup / dead-affordances /
 * backend-no-ui / interaction-a11y）在 Bot 面照出**八组类名由 JS 真实渲染、全仓 CSS 零命中**。
 * 最刺眼的是首屏：`readinessCardMarkup` 渲染的整张「首次就绪」卡（12 个类）在欢迎英雄与
 * Bot 首页英雄上都是浏览器默认样式——裸 `<ol>` 带十进制序号、状态芯片退化成普通行内文字、
 * 每行动作按钮没有按钮形态。新用户看到的第一屏就是这样的。
 *
 * 这类缺口为什么单测抓不到：渲染器测试只断言文本与 data-* 属性，从不看样式；
 * 而样式缺失**不会让任何东西报错**——它只是安静地丑。与 2026-09-11 的「四件套就位但零调用点」
 * 同族：读起来像功能，实际没有消费者。
 *
 * 本门禁的判据刻意机械：对每个「已确认渲染」的类名，断言它在某份被 index.html 加载的
 * 样式表里存在一条真实规则（`.name` 后跟 `{`、`,`、空格或伪类/后代选择器，不是注释里的提及）。
 * 它不判断样式好不好看——只判断「有没有」。**这是覆盖下限，不是审美契约。**
 *
 * 新增渲染类名时的正确做法：要么给它加样式，要么把类名加进 NOT_A_VISUAL_CLASS 白名单
 * 并写清理由（纯行为钩子 / 纯语义容器）。加白名单就是本门禁要求的那次「想一下」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

/** index.html 实际加载的样式表，按加载顺序。顺序即层叠顺序，本门禁不判断谁赢。 */
async function loadedStylesheets() {
  const html = await readFile(`${appRoot}/public/index.html`, "utf8");
  const hrefs = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length > 20, `样式表加载数异常（${hrefs.length}）——选择器解析可能失效`);
  const sheets = [];
  for (const href of hrefs) {
    const path = `${appRoot}/public/${href.replace(/^\.\//, "")}`;
    try {
      sheets.push({ href, text: (await readFile(path, "utf8")).replace(/\r\n/g, "\n") });
    } catch {
      // 少数条目可能指向 vendor 目录之外的可选资源；缺失不构成本门禁的判据
    }
  }
  return sheets;
}

/** 剥掉 CSS 注释：文件头解释「为什么不能引用 X」的说明文字不是规则。 */
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 该类名是否存在一条真实规则。
 * 匹配 `.name` 后紧跟 `{`、`,`、空格、`:`（伪类）、`>`、`.`、`[`、`#` 等——即「确实是选择器」。
 * 用词边界避免 `.readiness-step` 被 `.readiness-step-action` 冒充。
 */
function hasRule(sheets, name) {
  const pattern = new RegExp(`\\.${name.replace(/[-]/g, "\\-")}(?![\\w-])\\s*(?=[{,:>\\s.\\[#)])`);
  return sheets.some((sheet) => pattern.test(stripCssComments(sheet.text)));
}

/**
 * 已确认由 JS 渲染进 Bot 面 / 首屏的类名 → 出处（file:line）。
 * 每一条都是本轮审计在盘上逐字复核过的，不是从模板里猜的。
 */
const RENDERED_CLASSES = Object.freeze({
  // 首次就绪清单（public/modules/readiness-card.js:65-91），渲染于 app.js:7316 与 :19372
  "readiness-card": "modules/readiness-card.js:86",
  "readiness-card-head": "modules/readiness-card.js:86",
  "readiness-kicker": "modules/readiness-card.js:86",
  "readiness-status": "modules/readiness-card.js:86",
  "readiness-card-copy": "modules/readiness-card.js:88",
  "readiness-steps": "modules/readiness-card.js:89",
  "readiness-step": "modules/readiness-card.js:84",
  "readiness-step-icon": "modules/readiness-card.js:84",
  "readiness-step-copy": "modules/readiness-card.js:84",
  "readiness-step-state": "modules/readiness-card.js:84",
  "readiness-step-action": "modules/readiness-card.js:82",
  "readiness-action": "modules/readiness-card.js:71",
  // 首页英雄动作行 + 就绪折叠槽（public/modules/assistant-start.js:15-16）
  "assistant-home-actions": "modules/assistant-start.js:15",
  "assistant-readiness": "modules/assistant-start.js:16",
  "bot-readiness-slot": "modules/assistant-start.js:16",
  // 连接器账户行（public/app.js:20660）
  "bot-connector-list": "app.js:20650",
  "bot-connector-row": "app.js:20660",
  "bot-connector-dot": "app.js:20660",
  // 构建真相明细（public/app.js:20764）
  "bot-release-truth": "index.html:973",
  "bot-release-truth-row": "app.js:20764",
  // 结算卡三段增强区（public/modules/bot-settlement.js:157-171）
  "bot-settlement-checkpoints": "modules/bot-settlement.js:157",
  "bot-checkpoint-steps": "modules/bot-settlement.js:157",
  "bot-checkpoint-step": "modules/bot-settlement.js:157",
  "bot-settlement-evidence-matrix": "modules/bot-settlement.js:161",
  "bot-evidence-chips": "modules/bot-settlement.js:161",
  "bot-evidence-chip": "modules/bot-settlement.js:161",
  "bot-settlement-deliverable": "modules/bot-settlement.js:165",
  "bot-deliverable-summary": "modules/bot-settlement.js:165",
  // 会话协作收件箱的 ask 行与降级提示（public/modules/bot-workspace-chrome.js:397-422）
  "bot-ops-inbox-notice": "modules/bot-workspace-chrome.js:398",
  "bot-ops-ask-list": "modules/bot-workspace-chrome.js:422",
  "bot-ops-ask": "modules/bot-workspace-chrome.js:413",
  "bot-ops-ask-state": "modules/bot-workspace-chrome.js:419",
  // 文件证据块子元素（public/app.js:19697）
  "bot-file-evidence-header": "app.js:19697",
  "evidence-icon": "app.js:19697",
  "evidence-file-name": "app.js:19697",
  "evidence-line-badge": "app.js:19696",
  "evidence-extra": "app.js:19697",
  "bot-file-evidence-content": "app.js:19697",
  // Web 引用证据列表（public/app.js:19667）
  "bot-evidence-card-header": "app.js:19669",
  "bot-evidence-source-list": "app.js:19669",
  "bot-evidence-source-item": "app.js:19667",
  "bot-evidence-source-domain": "app.js:19667",
  "bot-evidence-source-link": "app.js:19667",
});

/**
 * 白名单：刻意**没有**样式的渲染类名。加进来就是一次显式决策，必须写理由。
 */
const NOT_A_VISUAL_CLASS = Object.freeze({
  // 纯布局锚点：由父级 grid/flex 定位，自身不需要规则
  "bot-settlement-section-head": "已有规则（bot-shell.css:652）——保留在此仅为说明它不是缺口",
});

test("Bot 面渲染的每个类名都至少有一条真实 CSS 规则（零样式渲染门禁）", async () => {
  const sheets = await loadedStylesheets();
  const missing = [];
  for (const [name, origin] of Object.entries(RENDERED_CLASSES)) {
    if (Object.hasOwn(NOT_A_VISUAL_CLASS, name)) continue;
    if (!hasRule(sheets, name)) missing.push(`${name} (渲染于 ${origin})`);
  }
  assert.deepEqual(
    missing,
    [],
    `以下类名由 JS 渲染进界面，却在全部已加载样式表中零命中——\n` +
    `它们会以浏览器默认样式出现（裸列表序号 / 无形态按钮 / 无色调状态）：\n  ${missing.join("\n  ")}\n` +
    `修法：给它加样式；若确实是纯行为钩子，加进 NOT_A_VISUAL_CLASS 并写明理由。`,
  );
});

test("门禁本身有效：已知无样式的类名必须被判为缺失（元验收）", async () => {
  const sheets = await loadedStylesheets();
  // 用两个**确定不存在**的类名做负样本。若它们被判为「有规则」，
  // 说明 hasRule 的匹配式太宽（例如把 `.x` 匹配到 `.xy`），门禁就是假保护。
  assert.equal(hasRule(sheets, "readiness-card-definitely-not-a-class"), false);
  assert.equal(hasRule(sheets, "bot-ops-ask-definitely-not-a-class"), false);
  // 正样本：本轮补的规则必须能被找到（防止匹配式收紧过头变成恒假）
  assert.equal(hasRule(sheets, "readiness-card"), true);
  assert.equal(hasRule(sheets, "bot-ops-ask"), true);
  // 词边界：`.readiness-step` 不得被 `.readiness-step-action` 冒充
  assert.equal(hasRule(sheets, "readiness-ste"), false);
});

test("新增样式只消费既有令牌，不新造（防止「引用了零定义令牌」静默失效）", async () => {
  const css = stripCssComments(
    (await readFile(`${appRoot}/public/forge/bot-shell.css`, "utf8")).replace(/\r\n/g, "\n"),
  );
  // 2026-10-02 的教训：collaboration-enhanced.css 曾引用 5 个全仓零定义令牌，
  // 玻璃底与描边从未生效，而没有任何测试变红。
  const dead = ["--forge-glass-bg", "--forge-surface-1", "--forge-surface-2", "--forge-line", "--bot-secondary"];
  for (const token of dead) {
    assert.ok(!css.includes(token), `${token} 在全仓零定义，引用即静默失效`);
  }
  // 本轮补的规则必须真的落地（防止整块被误删）
  assert.match(css, /\.readiness-card \{/);
  assert.match(css, /\.bot-ops-ask \{/);
  assert.match(css, /\.bot-evidence-source-link \{/);
});
