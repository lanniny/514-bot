/**
 * 环境外观契约（任务 #6）：四个功能阶段完成后留下的防漂移栅栏。
 *
 * 覆盖：
 *   1. 滤镜五轴滑杆：schema（app.js TEAM_BG_FILTER_RANGES）是范围/档位的单一事实源，
 *      index.html 的 #team-bg-sliders 只是空挂载点，不得硬编码 min/max/range 输入。
 *   2. /api/preferences 服务端往返：空库读取、白名单过滤、非法输入防呆、
 *      损坏文件回退默认且绝不覆盖/删除用户文件（隔离服务端实例真实往返）。
 *   3. theme.js 首帧引导：同步脚本、零网络、写 dataset 前一律过白名单。
 *   4. 播放控制契约：播放行默认 hidden；teams.mjs rate 白名单有且仅有 0.5/1/1.5/2。
 *   5. 玻璃契约：514cc-glass-* 三键在前后端白名单双侧注册，
 *      primitives.css / shell.css 均有 @supports not backdrop-filter 实色兜底，
 *      主视觉层 art-direction.css 真实消费玻璃令牌（滑杆/色板对顶栏侧栏生效），
 *      顶栏/侧栏模糊走整串滤镜令牌且默认档严格回退 none（默认零回归）。
 *   6. 失焦暂停守护：514cc-bg-pause-blur 双侧白名单注册、开关静态默认关、
 *      blur/focus 监听体内含偏好门控。
 *   7. 字体按钮组 CSP 安全：全部 ui/code face 按钮不得内联 style（CSP style-src 'self'
 *      拦截），预览字体由 experience-polish.css 的 data 属性规则逐值承担。
 *
 * 全部为读源码断言 + 隔离服务端往返，不起浏览器。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
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

/** 带参数解构的顶层函数（如 f({ alpha } = {})）会骗过 extractBlock——首个 { 是参数
    括号。改按「行首 } 收尾」截取（app.js 顶层函数体都以零缩进 } 结束）。 */
function extractTopLevelFn(sourceText, startMarker) {
  const start = sourceText.indexOf(startMarker);
  assert.ok(start >= 0, `找不到契约锚点：${startMarker}`);
  const end = sourceText.indexOf("\n}\n", start);
  assert.ok(end > start, `顶层函数截尾失败：${startMarker}`);
  return sourceText.slice(start, end + 3);
}

const FILTER_AXES = ["blur", "brightness", "contrast", "saturation", "dim"];

test("滤镜五轴滑杆以 TEAM_BG_FILTER_RANGES 为单一事实源", async () => {
  const html = await source("public/index.html");
  const app = await source("public/app.js");

  // index.html：#team-bg-sliders 是空挂载点，滑杆由 JS 按 schema 动态渲染。
  const mountStart = html.indexOf('id="team-bg-sliders"');
  assert.ok(mountStart >= 0, "index.html 缺少 #team-bg-sliders 挂载点");
  const mount = html.slice(mountStart, html.indexOf("</div>", mountStart));
  assert.doesNotMatch(mount, /<input|type="range"|min=|max=/, "滑杆容器不得硬编码 range 输入或范围，滑杆必须由 schema 动态渲染");

  // app.js：schema 恰好定义一次，且含全部五轴与完整的 label/min/max/step/scale 档位。
  const definitions = app.match(/const TEAM_BG_FILTER_RANGES = Object\.freeze\(\{/g) ?? [];
  assert.equal(definitions.length, 1, "TEAM_BG_FILTER_RANGES 必须只定义一次（单一事实源）");
  const schema = extractBlock(app, "const TEAM_BG_FILTER_RANGES = Object.freeze(");
  for (const axis of FILTER_AXES) {
    assert.match(schema, new RegExp(`${axis}:\\s*\\{[^}]*label:`), `schema 缺轴或缺档位：${axis}`);
    for (const field of ["min:", "max:", "step:", "scale:"]) {
      assert.match(schema, new RegExp(`${axis}:\\s*\\{[^}]*${field.replace(":", ":\\s")}`), `schema 轴 ${axis} 缺 ${field}`);
    }
  }
  assert.match(schema, /contrast:[\s\S]*?css:\s*\(v\)\s*=>\s*`contrast/, "对比度轴必须入滤镜链");

  // 归一化 / CSS 链 / 渲染全部从 schema 读取，没有第二份范围字面量。
  const normalize = extractBlock(app, "function normalizeAppearanceFilter(");
  assert.match(normalize, /range\.min\s*\/\s*range\.scale/, "归一化边界必须由 schema 的 min/scale 推导");
  assert.match(normalize, /Object\.entries\(TEAM_BG_FILTER_RANGES\)/, "归一化必须遍历 schema 而不是硬编码轴清单");
  const cssChainStart = app.indexOf("function appearanceFilterCss(");
  assert.ok(cssChainStart >= 0, "缺少 appearanceFilterCss");
  const cssChain = app.slice(cssChainStart, cssChainStart + 400);
  assert.match(cssChain, /Object\.entries\(TEAM_BG_FILTER_RANGES\)/, "CSS 滤镜链必须遍历 schema 而不是硬编码轴清单");
  const render = extractBlock(app, "function renderTeamTuneControls(");
  assert.match(render, /min="\$\{range\.min\}" max="\$\{range\.max\}" step="\$\{range\.step\}"/, "滑杆 min/max/step 必须来自 schema 模板变量");

  // 反漂移计数：schema 块之外不得再出现五轴的范围字面量定义（`轴名: { min:` 形态）。
  const remainder = app.slice(schema.length + app.indexOf(schema));
  for (const axis of FILTER_AXES) {
    assert.doesNotMatch(remainder, new RegExp(`${axis}:\\s*\\{[^}]*min:`), `发现第二份 ${axis} 范围字面量，范围必须收敛进 schema`);
  }
});

test("全局壁纸 3 轴滤镜以 schema 派生，HTML 只留挂载点，CSS 走独立区段", async () => {
  const html = await source("public/index.html");
  const app = await source("public/app.js");
  const css = await source("public/forge/team.css");

  // 契约 1：GLOBAL_WALLPAPER_FILTER_KEYS 必须是 dim/blur/saturate 三轴且只定义一次
  const keyDefs = app.match(/const GLOBAL_WALLPAPER_FILTER_KEYS = Object\.freeze\(\[([^\]]+)\]\)/);
  assert.ok(keyDefs, "缺少 GLOBAL_WALLPAPER_FILTER_KEYS 单一事实源");
  const keys = keyDefs[1].split(",").map((s) => s.trim().replace(/['"]/g, "")).filter(Boolean);
  assert.deepEqual(keys, ["dim", "blur", "saturation"], "三轴必须严格按 dim/blur/saturation 声明");

  // 契约 2：HTML 挂载点 #appearance-wallpaper-sliders 是空容器，不得硬编码 range 输入或范围
  const mountStart = html.indexOf('id="appearance-wallpaper-sliders"');
  assert.ok(mountStart >= 0, "index.html 缺少 #appearance-wallpaper-sliders 挂载点");
  const mountEnd = html.indexOf("</div>", mountStart);
  const mount = html.slice(mountStart, mountEnd);
  assert.doesNotMatch(mount, /<input|type="range"|min=|max=/, "全局壁纸滑杆容器不得硬编码 range 输入或范围");

  // 契约 3：归一化函数必须按三轴遍历 + 走 schema 的 min/scale
  const normalize = extractBlock(app, "function normalizeGlobalWallpaperFilter(");
  assert.match(normalize, /for\s*\(\s*const key of GLOBAL_WALLPAPER_FILTER_KEYS\)/, "归一化必须遍历 GLOBAL_WALLPAPER_FILTER_KEYS");
  assert.match(normalize, /range\.min\s*\/\s*range\.scale/, "归一化边界必须由 schema 的 min/scale 推导");

  // 契约 4：applyGlobalWallpaperInto 必须挂 --team-bg-filter / --team-bg-dim；
  // none 路径必须主动摘除 CSS 变量（防跨团队串色），custom 字节挂掉时也必须摘
  const applyFn = extractBlock(app, "function applyGlobalWallpaperInto(");
  assert.match(applyFn, /body\.style\.setProperty\("--team-bg-filter"/, "全局壁纸未挂 CSS 滤镜变量");
  assert.match(applyFn, /body\.style\.setProperty\("--team-bg-dim"/, "全局壁纸未挂 dim 变量");
  assert.match(applyFn, /removeProperty\("--team-bg-filter"\)/, "none 路径必须摘除 --team-bg-filter");
  assert.match(applyFn, /removeProperty\("--team-bg-dim"\)/, "none 路径必须摘除 --team-bg-dim");
  // custom 路径 catch 必须也摘（防玻璃态悬空在无媒体却有滤镜的实底上）。
  // v8.4 后 applyGlobalWallpaperInto 里有多个 catch（fetchMediaRef 的透传 catch 在前），
  // 锚定 404 摘除路径的注释定位真正的失败处理块。
  assert.match(applyFn, /自愈只认 404[\s\S]{0,1400}removeProperty\("--team-bg-filter"\)/, "custom 字节挂掉时必须摘 filter（404 摘除路径）");
  assert.match(applyFn, /自愈只认 404[\s\S]{0,1400}removeProperty\("--team-bg-dim"\)/, "custom 字节挂掉时必须摘 dim");

  // 契约 5：CSS 走独立区段，不污染团队 .team-bg-sliders
  assert.match(css, /\.appearance-wallpaper-sliders\s*\{/, "缺少 .appearance-wallpaper-sliders 容器样式");
  assert.match(css, /\.appearance-wallpaper-slider\s+input\[type="range"\]/, "缺少 .appearance-wallpaper-slider 内 range 样式");
  assert.match(css, /\.team-bg-upload\.is-dragover\s*\{/, "缺少拖拽高亮态样式");

  // 契约 6：拖拽上传：必须挂 dragover 高亮 + drop 直传，且守 hasFiles 防文字/URL 误吞
  const wiring = extractBlock(app, 'wallpaperLabel.addEventListener("dragover"');
  assert.ok(wiring || app.includes('wallpaperLabel.addEventListener("dragover"'), "拖拽 wiring 缺失");
  assert.match(app, /function hasFiles\(/, "缺少 hasFiles 拖拽事件守卫");
  assert.match(app, /hasFiles\(event\)/g, "hasFiles 未被 dragenter/dragleave/dragover/drop 全部使用");
});

test("顶/底/侧/移动 nav 全壳玻璃态：基底轻玻璃 + .team-bg-active 透出 + 老引擎兜底", async () => {
  const styles = await source("public/styles.css");
  const teamCss = await source("public/forge/team.css");

  // 契约 1：styles.css 三处壳层段（顶栏/底栏/移动 nav）必须撤掉
  // `backdrop-filter: none`。否则后续 team.css 的 .team-bg-active 玻璃公式挂到
  // 这些壳上时，原基底 none 会局部擦掉 backdrop-filter——颜色混合能跑、滤镜不工
  // 作，视觉仍是实底。校验所有 `.xxx { ... }` 段不再有"none 硬编码"残留。
  assert.doesNotMatch(styles, /\.topbar\s*\{[\s\S]{0,400}backdrop-filter:\s*none/, "styles.css 仍有 .topbar 强制 backdrop-filter: none");
  assert.doesNotMatch(styles, /\.global-statusbar\s*\{[\s\S]{0,400}backdrop-filter:\s*none/, "styles.css 仍有 .global-statusbar 强制 backdrop-filter: none");
  assert.doesNotMatch(styles, /\.mobile-nav\s*\{[\s\S]{0,800}backdrop-filter:\s*none/, "styles.css 仍有 .mobile-nav 强制 backdrop-filter: none");

  // 契约 2：三段壳层基底都必须 surface-glass + 走 var(--forge-glass-filter, ...) 轻玻璃。
  // 无壁纸态也是轻玻璃，不在 wallpaper 启用时突然变实底。
  // styles.css 里 .topbar / .global-statusbar / .mobile-nav 有重复声明（精致化波
  // 次 + Forge shell 段 + 移动段），最末一次才是当前生效的；用整文件做 match
  // 检查"至少有一处 shell 基底走 forge-glass-filter"，无壁纸态也保轻玻璃。
  for (const sel of [".topbar", ".global-statusbar", ".mobile-nav"]) {
    // 三段里至少各有一段走 surface-glass（默认基底轻玻璃）
    const surfaceRe = new RegExp(`${sel.replace(/\\./g, "\\\\.")}\\s*\\{[\\s\\S]{0,500}background:\\s*var\\(--surface-glass`);
    assert.match(styles, surfaceRe, `${sel} 基底至少有一段走 surface-glass`);
    // 三段里至少各有一段挂 --forge-glass-filter
    const filterRe = new RegExp(`${sel.replace(/\\./g, "\\\\.")}\\s*\\{[\\s\\S]{0,500}backdrop-filter:\\s*var\\(--forge-glass-filter`);
    assert.match(styles, filterRe, `${sel} 必须挂 --forge-glass-filter`);
  }

  // 契约 3：team.css 必须有 body.team-bg-active 下覆盖 .topbar / .global-statusbar /
  // .mobile-nav / .sidebar 的玻璃公式块，与工作台段同源
  //（color-mix + var(--forge-glass-alpha) + var(--forge-glass-filter)）。
  assert.match(teamCss, /body\.team-bg-active\s+\.topbar,/, "缺 .topbar 全局玻璃块声明");
  const shellGlass = extractBlock(teamCss, "body.team-bg-active .topbar,");
  assert.match(shellGlass, /color-mix\(in oklab, var\(--glass-tint, var\(--wall-tint, var\(--surface\)\)\) var\(--forge-glass-alpha, 86%\), transparent\)/, "全壳玻璃背色未走 color-mix 公式（含壁纸调和色回退链）");
  assert.match(shellGlass, /backdrop-filter:\s*var\(--forge-glass-filter/, "全壳玻璃未挂 --forge-glass-filter");

  // 契约 4：顶栏/底栏玻璃底下，原本各铺 surface 实底的 chrome 菜单按钮 +
  // statusbar-segment 必须透出（避免玻璃壳底下再铺一坨实底破坏观感）。
  assert.match(teamCss, /body\.team-bg-active\s+\.topbar\s+\.chrome-menu-label/, "缺顶栏 chrome 菜单透出规则");
  assert.match(teamCss, /body\.team-bg-active\s+\.global-statusbar\s+\.statusbar-segment/, "缺底栏 segment 透出规则");

  // 契约 5：老引擎兜底必须存在；否则 WebView 旧版本不支持 backdrop-filter 时会
  // 从玻璃切回纯透明，文字炸底。
  assert.match(teamCss, /@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/, "缺老引擎实底兜底");

  // 契约 6：baseMedia 头几条壳层规则之前，已不在基底上强制 backdrop-filter: none。
  const baseTopbar = styles.indexOf(".topbar {");
  assert.ok(baseTopbar >= 0, "缺 .topbar 基底规则");
});

test("atelier 形态下壁纸激活态玻璃补强：特异度抬升 + atelier.css 底栏 !important 让位", async () => {
  const teamCss = await source("public/forge/team.css");
  const atelierCss = await source("public/atelier.css");
  const artDirection = await source("public/forge/art-direction.css");

  // 契约 1：atelier 基线（art-direction.css / atelier.css）后于 team.css 加载，
  // body.atelier .topbar / body.atelier .sidebar（0,2,1）与 team.css 的
  // body.team-bg-active .topbar（0,2,1）同特异度→源序压回 none / 100% 实色。team.css
  // 必须叠 .atelier 抬到 (0,3,1) 稳压；否则壁纸激活态下顶栏/侧栏/移动 nav 仍是
  // 无滤镜 + 实色底（视觉上仍是工作室原观感），三块大卡片独亮，整体割裂。
  const atelierBump = extractBlock(teamCss, "body.team-bg-active.atelier .topbar,");
  assert.ok(atelierBump, "缺 atelier 特异度补强块（body.team-bg-active.atelier .topbar, ...）");
  assert.match(atelierBump, /\.sidebar,/, "atelier 补强未覆盖 .sidebar");
  assert.match(atelierBump, /\.mobile-nav\b/, "atelier 补强未覆盖 .mobile-nav");
  assert.match(
    atelierBump,
    /backdrop-filter:\s*var\(--forge-glass-filter/,
    "atelier 补强未挂 --forge-glass-filter（顶/侧/移动 nav 在壁纸态仍会无磨砂）",
  );
  assert.match(
    atelierBump,
    /color-mix\(in oklab, var\(--glass-tint, var\(--wall-tint, var\(--forge-paper\)\)\)/,
    "atelier 补强未走 color-mix 玻璃公式（含壁纸调和色回退链）",
  );

  // 契约 2：atelier.css 的 .global-statusbar 状态栏 !important 实色必须收窄为
  // :not(.team-bg-active)；否则会无条件压过 team.css 的任何 (0,3,1) 玻璃规则，
  // 底栏永远是深玫红实色（即便磨砂挂上了），与三卡玻璃不同步。
  assert.match(
    atelierCss,
    /\.atelier:not\(\.team-bg-active\)\s+\.global-statusbar[\s\S]{0,200}background:\s*var\(--statusbar\)\s*!important/,
    "atelier.css 状态栏 !important 实色未收窄到 :not(.team-bg-active)，壁纸激活态下底栏将仍是实色",
  );

  // 契约 3：art-direction.css 侧栏背景默认 alpha 100%（即未上壁纸前的实色基线）
  // 必须存在——这是 atelier 形态在无壁纸态下「与原观感一致」的保障，但被 team.css
  // (0,3,1) 的 atelier 补强在壁纸态下盖掉。本测试既锁基线、也确认 team.css 真的
  // 用更高特异度来接管。
  const sidebarArt = extractBlock(artDirection, "body.atelier .sidebar {");
  assert.match(sidebarArt, /var\(--forge-glass-alpha, 100%\)/, "atelier 基线侧栏 100% 实色被改写，无壁纸态观感会变");
});

test("整壳底层幕布透出：atelier-stage paper + .app-shell + body 在壁纸态下让位", async () => {
  // 根因（LO 2026-08-28 实测「壳层全玻璃后中间还糊」）：art-direction.css:49 把
  // .atelier-stage 设 var(--forge-paper) 实色 + 网格 + radial-copper 设计语言，整片
  // 1440×900；styles.css:7050 把 .app-shell 设 var(--bg) 实色；art-direction.css:34
  // 把 body.atelier 设 var(--forge-paper) 实色——三层堆在 wallpaper 之上、不可见。
  // 修法（team.css「整壳底层幕布透出」段）：壁纸激活态下 atelier-stage paper 实色
  // 替换为 oklab 半透（保留 72px 网格 + radial-copper 的设计语言）、.app-shell 与
  // body 直接透出。无壁纸态本段不匹配，atelier 纯净纸面原样保留。
  const teamCss = await source("public/forge/team.css");
  const artDirection = await source("public/forge/art-direction.css");

  // 契约 1：atelier-stage paper 实色必须存在但透出规则也要有。
  const stageArt = extractBlock(artDirection, ".atelier-stage {");
  assert.match(stageArt, /var\(--forge-paper\)/, "atelier-stage 必须保留 paper 基线（无壁纸态观感）");

  // 契约 2：team.css 必须在壁纸态下用 oklab 半透 + 仍保留 72px 网格 + radial-copper，
  // 同时把 .app-shell 与 body 透出。三段一起退场后 wallapaer 才能在所有视图全程可见。
  const stageBump = extractBlock(teamCss, "body.team-bg-active.atelier .atelier-stage {");
  assert.ok(stageBump, "缺 .atelier-stage 透出补丁块（第三轮补强）");
  assert.match(stageBump, /color-mix\(in oklab,\s*var\(--wall-tint, var\(--forge-paper\)\)\s*18%/,
    "atelier-stage 纸色幕布未接壁纸调和色回退链（壁纸态下暖纸幕布会染脏冷色壁纸）");
  assert.match(stageBump, /72px 72px/, "atelier-stage 透出时必须保留 72px 网格（设计语言）");
  assert.match(stageBump, /radial-gradient/, "atelier-stage 透出时必须保留 radial-copper 氛围光");

  const shellTransparent = /body\.team-bg-active\s+\.app-shell\s*\{[\s\S]{0,80}background:\s*transparent\b/;
  assert.match(teamCss, shellTransparent, ".app-shell 在壁纸态下未设 background: transparent 让位");

  const bodyTransparent = /body\.team-bg-active\.atelier\s*\{[\s\S]{0,80}background:\s*transparent\b/;
  assert.match(teamCss, bodyTransparent, "body.atelier 在壁纸态下未让位 transparent（art-direction.css:34 paper 实色未退场）");
});

test("壁纸调和玻璃 v2：--wall-tint 采样链 + 壁纸态有效令牌 + 边缘光学 + 内层卡调和", async () => {
  const app = await source("public/app.js");
  const teamCss = await source("public/forge/team.css");
  const html = await source("public/index.html");
  const server = await source("server.mjs");

  // 契约 1（app.js 采样器）：WALLPAPER_GLASS 常量只定义一次，sRGB→OKLCH 采样与
  // 媒体观察器存在；视频走 loadeddata 首帧采样，图片走 load/complete。
  const cfgDefs = app.match(/const WALLPAPER_GLASS = Object\.freeze\(\{/g) ?? [];
  assert.equal(cfgDefs.length, 1, "WALLPAPER_GLASS 必须只定义一次");
  assert.match(app, /function srgbToOklch\(/, "缺 OKLCH 采样数学");
  assert.match(app, /function presetWallpaperSample\(/, "缺预设锚点采样（预设渐变无可采样像素）");
  const observer = extractBlock(app, "function observeWallpaperMedia(");
  assert.match(observer, /loadeddata/, "视频壁纸必须在 loadeddata（首帧）采样");
  assert.match(observer, /node\.decode/, "图片必须挂 decode() 兜底采样（缓存图偶发丢 load 事件）");
  assert.match(observer, /syncWallpaperGlassEnvironment\(\)/, "采样完成后必须触发环境同步");

  // 契约 2（环境同步）：--wall-tint/--wall-lum 只在 team-bg-active 激活态写入；
  // 透出档位（bold/soft/solid）按「壁纸×墨色」亮度距离分级挂 body[data-wall-glass]；
  // 壁纸态有效令牌走档位 alphaDelta + blur 增强 + saturate 165%。
  const sync = extractTopLevelFn(app, "function syncWallpaperGlassEnvironment(");
  assert.match(sync, /--wall-tint/, "环境同步必须写 --wall-tint");
  assert.match(sync, /--wall-lum/, "环境同步必须写 --wall-lum（透出档位分级依据）");
  assert.match(sync, /team-bg-active/, "环境同步必须以 team-bg-active 为唯一门控");
  assert.match(sync, /dataset\.wallGlass/, "环境同步必须把透出档位挂到 body[data-wall-glass]（CSS 三档消费）");
  const tier = extractTopLevelFn(app, "function wallpaperGlassTier(");
  assert.match(tier, /WALLPAPER_GLASS\.inkLum/, "透出档位必须按壁纸×墨色亮度距离分级");
  assert.match(tier, /WALLPAPER_GLASS\.tiers/, "透出档位表必须由 WALLPAPER_GLASS.tiers 单源驱动");
  assert.match(tier, /tiers\[0\]/, "采样未到/失败时必须按 bold 放行（看不到壁纸比对比略降更伤，磨砂兜底可读性）");
  const tokens = extractTopLevelFn(app, "function syncGlassEnvironmentTokens(");
  assert.match(tokens, /wallpaperGlassTier\(\)/, "壁纸态 alpha 有效值必须经透出档位计算");
  assert.match(tokens, /WALLPAPER_GLASS\.blurBoost/, "壁纸态 blur 有效值必须走 WALLPAPER_GLASS 增强");
  assert.match(tokens, /saturate\(\$\{WALLPAPER_GLASS\.saturate\}%\)/, "壁纸态滤镜必须写 saturate 有效档");

  // 契约 3（接线）：壁纸路径收尾必须挂采样/同步；偏好应用函数统一走环境同步；
  // 用户滑杆滤镜串与 CSS 基线同族（saturate 150%，不再出现 118% 旧值）。
  assert.match(app, /observeWallpaperMedia\(node\)/, "自定义媒体挂载后必须观察采样");
  assert.match(app, /wallpaperSample = presetWallpaperSample\(/, "预设路径必须挂锚点采样");
  const applyAlpha = extractTopLevelFn(app, "function applyGlassAlpha(");
  assert.match(applyAlpha, /syncGlassEnvironmentTokens\(/, "alpha 滑杆必须经环境同步写令牌");
  const applyBlur = extractTopLevelFn(app, "function applyGlassBlur(");
  assert.match(applyBlur, /syncGlassEnvironmentTokens\(/, "blur 滑杆必须经环境同步写令牌");
  assert.doesNotMatch(app, /saturate\(118%\)/, "滑杆滤镜串残留 saturate(118%) 旧值，与 CSS 基线 150% 不同族");
  const applyThemeFn = extractTopLevelFn(app, "function applyTheme(");
  assert.match(applyThemeFn, /syncWallpaperGlassEnvironment\(\)/, "主题切换必须重算壁纸调和色（明度随主题）");

  // 契约 4（team.css 回退链）：玻璃公式的 --glass-tint 回退必须穿过 --wall-tint，
  // 壁纸激活时玻璃底色与壁纸同族而非暖纸基线。
  assert.match(teamCss, /var\(--glass-tint, var\(--wall-tint, var\(--surface\)\)\)/, "壳层玻璃回退链未接入 --wall-tint");
  assert.match(teamCss, /var\(--glass-tint, var\(--wall-tint, var\(--forge-paper\)\)\)/, "atelier 玻璃回退链未接入 --wall-tint");
  assert.match(teamCss, /var\(--glass-tint, var\(--wall-tint, var\(--statusbar\)\)\)/, "底栏玻璃回退链未接入 --wall-tint");

  // 契约 5（边缘光学）：壁纸态玻璃必须有顶缘高光/侧缘微光/环境浮起影三重线索，
  // 且暗主题有降光版本；无 backdrop-filter 的老引擎必须退回平面（高光贴实底会显脏）。
  const edgeTokens = extractBlock(teamCss, "body.team-bg-active {");
  assert.match(edgeTokens, /--glass-edge-hi/, "缺顶缘高光令牌");
  assert.match(edgeTokens, /--glass-plate-shadow/, "缺环境浮起影令牌");
  const darkEdge = extractBlock(teamCss, '[data-theme="dark"] body.team-bg-active {');
  assert.match(darkEdge, /--glass-edge-hi/, "暗主题缺边缘令牌降光版本");
  assert.match(teamCss, /inset 0 1px 0 var\(--glass-edge-hi\)/, "壳层缺顶缘高光消费");
  assert.match(
    teamCss,
    /body\.team-bg-active #view-workbench \.conversation-pane,[\s\S]{0,400}var\(--glass-plate-shadow\)/,
    "工作台三大玻璃板缺环境浮起影",
  );
  const supportsIndex = teamCss.indexOf("玻璃质感 v2");
  const supportsBlock = teamCss.indexOf("@supports not", supportsIndex);
  assert.ok(supportsBlock > supportsIndex, "玻璃质感 v2 段缺老引擎 box-shadow 退场兜底");

  // 契约 6（内层卡调和）：恢复条/用户便签/输入台/模板卡/成员卡在壁纸态必须吃
  // 「壁纸调和色 × 内容卡玻璃度令牌」的玻璃片——实体感统一由 --forge-card-alpha
  // 驱动（v7），不再各写死百分比双轨。
  const recovery = extractBlock(teamCss, "body.team-bg-active .recovery-bar {");
  assert.match(recovery, /var\(--forge-card-alpha, 72%\)/, "恢复条壁纸态底色未吃内容卡玻璃度令牌");
  assert.match(recovery, /backdrop-filter:\s*blur\(20px\)/, "恢复条壁纸态缺自带磨砂");
  const userBubble = extractBlock(teamCss, "body.team-bg-active .conversation-stream .message-row.is-user .message-body {");
  assert.match(userBubble, /var\(--rose\) 12%/, "用户便签壁纸态必须保留 rose 识别色混入");
  assert.match(userBubble, /var\(--forge-card-alpha-hi, 84%\)/, "用户便签实体感应随内容卡玻璃度高档令牌（+12% 高一档）");
  const composerShell = extractBlock(teamCss, "body.team-bg-active .task-composer .composer-shell {");
  assert.match(composerShell, /backdrop-filter:\s*blur\(20px\)/, "输入台壳壁纸态缺自带磨砂（surface 暖实底会发脏）");
  const templateCard = extractBlock(teamCss, "body.team-bg-active .template-card {");
  assert.match(templateCard, /var\(--forge-card-alpha, 72%\)/, "快捷模板卡壁纸态未吃内容卡玻璃度令牌");
  const pickCard = extractBlock(teamCss, "body.team-bg-active .agent-pick-card {");
  assert.match(pickCard, /var\(--forge-card-alpha, 72%\)/, "成员选择卡壁纸态未吃调和玻璃片（surface 暖实底）");

  // 契约 7（透出档位）：LO 反馈「看不到自定义壁纸」——基础档三层叠乘只剩 ~8% 透出。
  // bold 档必须把大面积背景放出来（流无叠加、幕布减薄），solid 档反压实底。
  const boldStream = extractBlock(teamCss, 'body.team-bg-active[data-wall-glass="bold"] #view-workbench .conversation-stream {');
  assert.match(boldStream, /background:\s*transparent/, "bold 档会话流必须撤掉额外叠加（壁纸从中央大面积透出）");
  const solidStream = extractBlock(teamCss, 'body.team-bg-active[data-wall-glass="solid"] #view-workbench .conversation-stream {');
  assert.match(solidStream, /var\(--forge-glass-alpha-hi, 96%\)/, "solid 档会话流必须走高档派生令牌（+14% 封顶由 JS 预计算）");
  const boldStage = extractBlock(teamCss, 'body[data-wall-glass="bold"].team-bg-active.atelier .atelier-stage {');
  assert.match(boldStage, /background:\s*transparent/, "bold 档 stage 幕布必须整体让位（网格/铜晕/纸幕不得盖在照片壁纸上，v4 减雾）");
  const boldCanvas = extractBlock(teamCss, 'body[data-wall-glass="bold"].team-bg-active.atelier #atelier-canvas {');
  assert.match(boldCanvas, /display:\s*none/, "bold 档铜色画布必须让位（multiply 在照片壁纸上显脏斑）");
  // v7：内容卡实体感不再按档位写 CSS 双轨——bold 档不得残留卡片百分比覆盖
  assert.doesNotMatch(teamCss, /body\.team-bg-active\[data-wall-glass="bold"\] \.(recovery-bar|template-card|agent-pick-card|task-composer)/, "bold 档卡片覆盖残留（卡片实体感已统一由 --forge-card-alpha 驱动）");

  // 契约 8（窄桌面 ≤820 逻辑宽）：工作台玻璃原被 min-width: 821px 整体挡住，高 DPR
  // 缩放屏（2000 物理 ÷ 250% = 800 逻辑）中央仍是暖纸实底。窄幅段必须存在且把磨砂
  // 下沉到内层（pane 不挂 filter，避免层叠上下文囚禁终端抽屉 z-86）。
  const narrowBlock = extractBlock(teamCss, "@media (max-width: 820px) {");
  assert.match(narrowBlock, /body\.team-bg-active #view-workbench \.workbench-shell \{\s*background: transparent/, "窄幅段必须让 workbench-shell 透出");
  const narrowStream = extractBlock(narrowBlock, "body.team-bg-active #view-workbench .conversation-stream {");
  assert.match(narrowStream, /backdrop-filter:\s*var\(--forge-glass-filter/, "窄幅段消息流必须自带磨砂（pane 在窄幅不挂 filter）");
  assert.match(narrowBlock, /body\.team-bg-active #view-workbench \.conversation-pane \{\s*background: transparent/, "窄幅段 pane 必须只让位不建层叠上下文");

  // 契约 9（html 让位）：让位链之下是 html 的暖纸实底（--bg），壁纸媒体挂载的几秒
  // 窗口期里整个界面透出的就是它（暖米 + 网格，LO 截图中央的「暖纸大板」）。
  // html 必须挂同类并吃调和色；app.js 侧负责类的同步加摘。
  assert.match(teamCss, /html\.team-bg-active \{\s*background:\s*var\(--wall-tint, var\(--bg\)\);/, "html 底色必须在壁纸态换成调和色（加载窗口期不再透暖纸）");
  assert.match(sync, /documentElement\.classList\.toggle\("team-bg-active"/, "环境同步必须同步加摘 html 的 team-bg-active 类");

  // 契约 10（手动接管）：LO「需要更高的自定义程度」——壁纸态玻璃不透明度滑杆
  // （514cc-wallpaper-glass-alpha，auto 或 20–95）前后端白名单双侧注册；手动值直接
  // 接管 --forge-glass-alpha 不套档位；外观面板有自动按钮 + 滑杆挂载点。
  assert.match(server, /"514cc-wallpaper-glass-alpha"/, "服务端偏好白名单缺壁纸玻璃不透明度键");
  assert.match(server, /"514cc-wallpaper-glass-blur"/, "服务端偏好白名单缺壁纸磨砂强度键");
  const prefKeys = extractBlock(app, "const APPEARANCE_PREF_KEYS = [");
  assert.match(prefKeys, /WALLPAPER_GLASS_ALPHA_KEY,/, "app.js APPEARANCE_PREF_KEYS 未注册壁纸玻璃键");
  assert.match(prefKeys, /WALLPAPER_GLASS_BLUR_KEY,/, "app.js APPEARANCE_PREF_KEYS 未注册壁纸磨砂键");
  const applyWall = extractTopLevelFn(app, "function applyWallpaperGlassAlpha(");
  assert.match(applyWall, /wallAlphaPref:\s*next/, "手动值必须经 syncWallpaperGlassEnvironment 传入令牌同步");
  assert.match(applyWall, /value >= 20 && value <= 95/, "手动值必须收敛到 20–95");
  assert.match(tokens, /wallAlphaPref/, "令牌同步必须接受手动档参数");
  assert.match(tokens, /manualAlpha/, "令牌同步必须区分手动/档位两条 alpha 路径");
  assert.match(html, /id="appearance-wallpaper-glass-auto"/, "外观面板缺「自动」按钮");
  assert.match(html, /id="appearance-wallpaper-glass-alpha" type="range" min="20" max="95"/, "外观面板缺手动滑杆挂载点（20–95）");
  assert.doesNotMatch(html, /id="appearance-wallpaper-glass-alpha"[^>]*disabled/, "滑杆不得 disabled——禁用即永远进不了手动模式（交互死锁回归锁）");
  assert.match(applyWall, /syncAppearanceControls\(\)/, "应用后必须回填控件（auto 档滑杆显示档位计算值）");

  // 契约 11（壁纸磨砂强度 v6）：清晰度的主导维度独立可调——514cc-wallpaper-glass-blur
  // （auto 或 0–30）双侧注册；手动值直接写进 --forge-glass-filter；0 = 壁纸完全清晰。
  assert.match(server, /"514cc-wallpaper-glass-blur"/, "服务端偏好白名单缺壁纸磨砂强度键");
  assert.match(prefKeys, /WALLPAPER_GLASS_BLUR_KEY,/, "app.js APPEARANCE_PREF_KEYS 未注册壁纸磨砂键");
  const applyBlurWall = extractTopLevelFn(app, "function applyWallpaperGlassBlur(");
  assert.match(applyBlurWall, /wallBlurPref:\s*next/, "手动磨砂必须经 syncWallpaperGlassEnvironment 传入令牌同步");
  assert.match(applyBlurWall, /value >= 0 && value <= 30/, "手动磨砂必须收敛到 0–30px");
  assert.match(tokens, /wallBlurPref/, "令牌同步必须接受手动磨砂参数");
  assert.match(tokens, /blur\(\$\{manualBlur\}px\) saturate/, "手动磨砂必须直接写进滤镜串（0 = 壁纸完全清晰）");
  assert.match(html, /id="appearance-wallpaper-glass-blur" type="range" min="0" max="30"/, "外观面板缺磨砂滑杆挂载点（0–30）");
  assert.doesNotMatch(html, /id="appearance-wallpaper-glass-blur"[^>]*disabled/, "磨砂滑杆不得 disabled（交互死锁回归锁）");

  // 契约 12（滚动缺陷波）：①会话流顶部渐隐——渐变长度必须 = 流顶部 padding 24px
  // （滚到顶时第一条消息完整，滚离后从标题栏下缘淡入，替代生硬的视口边线裁切）；
  // ②壁纸态滚动条改半透墨色（暖灰实心 thumb 在蓝壁纸上是一条白杠）。
  const codexCss = await source("public/forge/codex-desktop.css");
  const streamBlock = extractBlock(codexCss, ".conversation-stream {");
  assert.match(streamBlock, /mask-image:\s*linear-gradient\(to bottom,\s*transparent 0,\s*#000 24px\)/, "会话流缺顶部渐隐 mask（滚动裁切生硬）");
  assert.match(teamCss, /body\.team-bg-active \.conversation-stream,[\s\S]{0,300}scrollbar-color:\s*color-mix\(in srgb, var\(--forge-ink\) 34%, transparent\)/, "壁纸态滚动条未调和（实心暖灰 thumb 在壁纸上是一条白杠）");

  // 契约 13（顶边对齐 + 无缝化）：workbench 的 main-content 四周 10px 呼吸 + shell
  // hairline 边框/圆角/浮起影，在壁纸态（面板透明）下形成可见线缝且顶边像错位
  // （LO「不要有明显的线缝/右边还是没对齐」）。壁纸态必须：呼吸全收 0、shell 与
  // 三块板的边框/圆角/阴影全撤、sidebar 右缘 hairline 透明。非壁纸浮岛观感不变。
  assert.match(teamCss, /body\.team-bg-active \.main-content:has\(#view-workbench\.is-active\) \{\s*padding: 0;/, "壁纸态工作台 main-content 呼吸未收 0（面板四周仍有缝）");
  const seamlessStart = teamCss.indexOf("顶边对齐 + 无缝化");
  assert.ok(seamlessStart > 0, "缺无缝化段（顶边对齐 + 无缝化注释锚点）");
  const seamlessScope = teamCss.slice(seamlessStart);
  const seamlessShell = extractBlock(seamlessScope, "body.team-bg-active #view-workbench .workbench-shell {");
  assert.match(seamlessShell, /border: none;/, "壁纸态 shell 边框未撤（hairline 描出线缝）");
  assert.match(seamlessShell, /border-radius: 0;/, "壁纸态 shell 圆角未撤（tint 沿圆角描缝）");
  assert.match(seamlessShell, /box-shadow: none;/, "壁纸态 shell 浮起影未撤（接缝处投出暗带）");
  assert.match(seamlessScope, /body\.team-bg-active #view-workbench \.conversation-pane,[\s\S]{0,260}border: none;[\s\S]{0,300}margin: 0;/, "壁纸态工作台三板的边框/圆角/阴影/margin 未撤（pane 的 margin 8px 是 topbar 顶缝直因）");
  assert.match(seamlessScope, /body\.team-bg-active\.atelier \.sidebar \{\s*border-right-color: transparent;/, "壁纸态 sidebar 右缘 hairline 未透明（最后一条竖缝）");

  // 契约 14（内容卡玻璃度 v7）：恢复条/气泡/输入台/成员卡的实体感独立可调——
  // 514cc-card-glass-alpha（auto 或 40–95）双侧注册；手动值经 applyCardGlassAlpha →
  // syncWallpaperGlassEnvironment → syncGlassEnvironmentTokens 写 --forge-card-alpha；
  // auto 随档位（tiers 单源 cardAlpha）。
  assert.match(server, /"514cc-card-glass-alpha"/, "服务端偏好白名单缺内容卡玻璃度键");
  assert.match(prefKeys, /CARD_GLASS_ALPHA_KEY,/, "app.js APPEARANCE_PREF_KEYS 未注册内容卡玻璃度键");
  const applyCard = extractTopLevelFn(app, "function applyCardGlassAlpha(");
  assert.match(applyCard, /cardAlphaPref:\s*next/, "手动值必须经 syncWallpaperGlassEnvironment 传入令牌同步");
  assert.match(applyCard, /value >= 40 && value <= 95/, "手动值必须收敛到 40–95");
  assert.match(tokens, /cardAlphaPref/, "令牌同步必须接受内容卡玻璃度参数");
  assert.match(tokens, /--forge-card-alpha/, "令牌同步必须写 --forge-card-alpha");
  assert.match(tokens, /tier\.cardAlpha/, "auto 档内容卡玻璃度必须由 tiers 单源驱动");
  assert.match(html, /id="appearance-card-glass-alpha" type="range" min="40" max="95"/, "外观面板缺内容卡玻璃度滑杆挂载点（40–95）");
  assert.doesNotMatch(html, /id="appearance-card-glass-alpha"[^>]*disabled/, "内容卡滑杆不得 disabled（交互死锁回归锁）");

  // v8.1：color-mix 百分位嵌 calc 在部分渲染引擎整条声明被弃（真机探针实锤 conv-tabs
  // 回落实底）——派生档（hi/lo/mid）必须由 JS 预计算成独立令牌，CSS 只消费纯 var()。
  assert.match(tokens, /--forge-card-alpha-hi/, "缺内容卡高档派生令牌（用户便签 +12%）");
  assert.match(tokens, /--forge-card-alpha-lo/, "缺内容卡低档派生令牌（页签条 −30%）");
  assert.match(tokens, /--forge-glass-alpha-hi/, "缺背景高档派生令牌（solid 流 +14%）");
  assert.match(tokens, /--forge-glass-alpha-mid/, "缺背景中档派生令牌（soft 流 +6%）");
  assert.doesNotMatch(teamCss, /color-mix\([^;]*calc\(\s*var\(--forge-(card|glass)-alpha/, "壁纸段 color-mix 内残留 calc 百分位（兼容性地雷）");

  // 契约 16（壁纸韧性 v8.3）：LO「有时候会回退到无壁纸状态」——三个静默摘除/竞态路径
  // 全部加韧性：①水合补齐壁纸键后显式重挂（replay 不含壁纸）；②字节加载非 404 保持
  // 门控指数退避重试（404 才走偏好自愈+摘除）、成功挂载清零计数；③可见性/聚焦自愈
  // （已挂壁纸、reduced-motion、30s 节流都不触发）。
  const hydrateFn = extractTopLevelFn(app, "async function hydratePreferencesFromServer(");
  assert.match(hydrateFn, /missing\[GLOBAL_WALLPAPER_KEY\][\s\S]{0,80}applyActiveTeamBackground\(\)/, "水合补齐壁纸键后必须显式重挂（否则换壳竞态下壁纸永不恢复）");
  const globalCatch = app.slice(app.indexOf("自愈只认 404"), app.indexOf("自愈只认 404") + 900);
  assert.match(globalCatch, /wallpaperLoadRetryCount < 2/, "全局壁纸字节失败必须退避重试而非一次抖动就摘壁纸");
  assert.match(globalCatch, /error\?\.status !== 404/, "只有 404 才允许走摘除路径（非 404 保持门控）");
  assert.match(app, /wallpaperLoadRetryCount = 0; \/\/ 挂载成功：重试计数归零/, "挂载成功必须清零重试计数");
  const heal = extractTopLevelFn(app, "function installWallpaperSelfHealOnce(");
  assert.match(heal, /visibilitychange/, "自愈必须挂 visibilitychange");
  assert.match(heal, /team-bg-active/, "自愈必须以已挂壁纸为跳过条件（用户主动关闭不触发）");
  assert.match(heal, /30_000/, "自愈必须 30s 节流（防失焦风暴反复重挂）");

  // 契约 15（流内残留实底清扫 v8）：成员直发气泡（bot-bubble --bot-panel 暖米实底）、
  // 会话页签条、governance/终态注记（amber-soft）、轮次胶囊——壁纸态统一玻璃化，
  // 注记保留识别色退薄纱；成员用户气泡与工作台用户便签同款高一档。
  const botBubble = extractBlock(teamCss, "body.team-bg-active #view-workbench .bot-bubble {");
  assert.match(botBubble, /var\(--forge-card-alpha, 72%\)/, "成员直发气泡壁纸态仍是 --bot-panel 暖米实底");
  assert.match(botBubble, /backdrop-filter:\s*blur\(18px\)/, "成员直发气泡缺自带磨砂");
  const botUser = extractBlock(teamCss, "body.team-bg-active #view-workbench .bot-message-user .bot-bubble {");
  assert.match(botUser, /var\(--forge-card-alpha-hi, 84%\)/, "成员用户气泡应随内容卡玻璃度高档令牌（+12% 高一档）");
  assert.match(teamCss, /body\.team-bg-active #view-workbench \.conv-tabs \{[\s\S]{0,200}var\(--forge-card-alpha-lo, 42%\)/, "会话页签条壁纸态未玻璃化（--surface-muted 实底；art-direction 有 #view-workbench .conv-tabs 的 97% 暖纸对手，class 级必输）");
  assert.match(teamCss, /body\.team-bg-active #view-workbench \.gov-note,[\s\S]{0,200}color-mix\(in srgb, var\(--amber\) 9%/, "治理注记壁纸态未退薄纱（amber-soft 实底）");
  assert.match(teamCss, /body\.team-bg-active #view-workbench \.run-end-note\.is-failed \{[\s\S]{0,120}var\(--red\) 9%/, "失败终态注记必须保留红色识别退薄纱");
  assert.match(teamCss, /body\.team-bg-active #view-workbench \.conversation-stream \.turn-divider span \{[\s\S]{0,200}var\(--forge-card-alpha, 72%\)/, "轮次胶囊壁纸态未玻璃化（--surface 实底）");
});

test("theme.js 首帧引导保持同步、白名单、零网络", async () => {
  const html = await source("public/index.html");
  const themeSource = await source("public/theme.js");

  // 挂载契约：独立同步脚本，先于所有样式表执行（无 module/async/defer）。
  const scriptIndex = html.indexOf('<script src="./theme.js"></script>');
  assert.ok(scriptIndex >= 0, "theme.js 必须以裸同步 <script> 挂载（无 async/defer/module）");
  const firstStylesheet = html.indexOf('<link rel="stylesheet"');
  assert.ok(scriptIndex < firstStylesheet, "theme.js 必须早于第一份样式表，才能阻止暗色首帧白闪");

  // 静态契约：不出现任何网络/异步/模块语义，首帧路径保持纯同步。
  for (const forbidden of [/\bfetch\s*\(/, /\bawait\b/, /\bimport\b/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /navigator\.sendBeacon/]) {
    assert.doesNotMatch(themeSource, forbidden, `theme.js 首帧脚本出现禁用语义：${forbidden}`);
  }

  // 行为契约（vm 沙箱）：喂入任意脏值，写进 dataset 的必须全部是白名单值；
  // 且全程不得发起任何网络请求。
  const runTheme = (stored) => {
    let fetchCalls = 0;
    const dataset = {};
    const context = {
      localStorage: { getItem: (key) => (Object.hasOwn(stored, key) ? stored[key] : null) },
      window: { matchMedia: () => ({ matches: false }) },
      document: {
        documentElement: {
          dataset,
          style: { setProperty() {}, removeProperty() {} },
        },
      },
      fetch: () => { fetchCalls += 1; },
    };
    vm.runInNewContext(themeSource, context);
    return { dataset, fetchCalls };
  };

  const dirty = runTheme({
    "514cc-control-theme": "evil",
    "514cc-ui-font-face": "javascript:alert(1)",
    "514cc-code-font-face": "<script>",
    "514cc-accent": "neon",
    "514cc-density": "mega",
    "514cc-code-wrap": "maybe",
    "514cc-code-lines": "maybe",
    "514cc-motion": "party",
  });
  assert.equal(dirty.fetchCalls, 0, "首帧引导不得发起网络请求");
  assert.equal(dirty.dataset.theme, "light", "脏主题值必须回落白名单默认");
  assert.equal(dirty.dataset.uiFace, "system");
  assert.equal(dirty.dataset.codeFace, "system");
  assert.equal(dirty.dataset.accent, "copper");
  assert.equal(dirty.dataset.density, "default");
  assert.equal(dirty.dataset.codeWrap, "off");
  assert.equal(dirty.dataset.codeLines, "off");
  assert.equal(dirty.dataset.motion, "system");

  const clean = runTheme({
    "514cc-control-theme": "dark",
    "514cc-ui-font-face": "yahei",
    "514cc-code-font-face": "jetbrains",
    "514cc-accent": "teal",
    "514cc-density": "compact",
    "514cc-code-wrap": "on",
    "514cc-code-lines": "on",
    "514cc-motion": "reduce",
  });
  assert.equal(clean.dataset.theme, "dark", "合法白名单值必须原样生效");
  assert.equal(clean.dataset.uiFace, "yahei");
  assert.equal(clean.dataset.codeFace, "jetbrains");
  assert.equal(clean.dataset.accent, "teal");
  assert.equal(clean.dataset.density, "compact");
  assert.equal(clean.dataset.codeWrap, "on");
  assert.equal(clean.dataset.codeLines, "on");
  assert.equal(clean.dataset.motion, "reduce");
});

test("字体按钮组全员走 CSP 安全的属性规则且无内联 style / select 残留", async () => {
  const html = await source("public/index.html");
  const polish = await source("public/forge/experience-polish.css");
  const faces = {
    "#appearance-ui-face": ["data-appearance-ui-face", ["system", "yahei", "song"]],
    "#appearance-code-face": ["data-appearance-code-face", ["system", "cascadia", "jetbrains"]],
  };
  for (const [group, [attribute, values]] of Object.entries(faces)) {
    const groupStart = html.indexOf(`id="${group.slice(1)}"`);
    assert.ok(groupStart >= 0, `缺少 ${group} radiogroup`);
    const buttons = [...html.matchAll(new RegExp(`<button[^>]*${attribute}="[^"]+"[^>]*>`, "g"))].map((match) => match[0]);
    assert.ok(buttons.length >= 2, `${group} 字体按钮数量异常：${buttons.length}`);
    for (const button of buttons) {
      assert.doesNotMatch(button, /style=/, `${group} 的按钮不得内联 style（CSP style-src 'self' 会拦截，预览失效）：${button}`);
    }
    // 每个 face 值都必须在 experience-polish.css 有对应的 font-family 属性规则（WYSIWYG 预览真源）。
    for (const value of values) {
      assert.match(
        polish,
        new RegExp(`\\[${attribute}="${value}"\\][\\s\\S]*?font-family:`),
        `experience-polish.css 缺 ${attribute}="${value}" 的预览字体规则`,
      );
    }
  }
  assert.doesNotMatch(html, /<select[^>]*(appearance-ui-face|appearance-code-face|ui-font-face|code-font-face)/, "字体选择不得残留 select 形态");
});

test("播放控制行默认隐藏，rate 白名单有且仅有 0.5/1/1.5/2", async () => {
  const html = await source("public/index.html");
  const teamsSource = await source("src/teams.mjs");
  const { TEAM_BG_PLAYBACK_RATES } = await import("../src/teams.mjs");

  // index.html：播放行静态即 hidden，仅视频壁纸由 app.js 运行时解除。
  const row = html.match(/<div[^>]*id="team-bg-playback-row"[^>]*>/);
  assert.ok(row, "index.html 缺少 #team-bg-playback-row");
  assert.match(row[0], /\shidden\b/, "播放控制行必须默认带 hidden，仅视频壁纸时解除");

  // teams.mjs：白名单常量值域封闭，且 cleanBackground 真的拿它做校验（非法回落而非拒绝）。
  assert.deepEqual([...TEAM_BG_PLAYBACK_RATES], [0.5, 1, 1.5, 2], "rate 白名单必须有且仅有 0.5/1/1.5/2");
  assert.match(teamsSource, /TEAM_BG_PLAYBACK_RATES\.includes\(Number\(playbackRaw\.rate\)\)/, "cleanBackground 必须用白名单常量收敛 rate");
});

test("玻璃三键在前后端白名单双侧注册，CSS 有 @supports not 兜底且主视觉层消费令牌", async () => {
  const server = await source("server.mjs");
  const app = await source("public/app.js");
  const glassKeys = ["514cc-glass-alpha", "514cc-glass-blur", "514cc-glass-tint"];

  // 服务端 PREFERENCE_KEYS：三键必须逐字在册（否则 PUT 会被白名单静默丢弃）。
  const serverWhitelist = extractBlock(server, "const PREFERENCE_KEYS = new Set(");
  for (const key of glassKeys) {
    assert.ok(serverWhitelist.includes(`"${key}"`), `服务端 PREFERENCE_KEYS 缺 ${key}`);
  }

  // 前端 APPEARANCE_PREF_KEYS：三键常量必须入清单，且常量字面值与服务端一致。
  const clientWhitelist = extractBlock(app, "const APPEARANCE_PREF_KEYS = ", "[", "]");
  for (const constant of ["GLASS_ALPHA_KEY", "GLASS_BLUR_KEY", "GLASS_TINT_KEY"]) {
    assert.match(clientWhitelist, new RegExp(constant), `前端 APPEARANCE_PREF_KEYS 缺 ${constant}`);
  }
  for (const key of glassKeys) {
    const constant = `514cc-glass-${key.split("-").at(-1)}`.toUpperCase().replace("514CC-GLASS-", "GLASS_") + "_KEY";
    assert.match(app, new RegExp(`const ${constant} = "${key}";`), `前端键常量 ${constant} 与服务端键 ${key} 失联`);
  }

  // 老引擎兜底：玻璃族失去 backdrop-filter 时必须实色保底，两个面各有一份。
  const fallback = /@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/;
  assert.match(await source("public/forge/primitives.css"), fallback, "primitives.css 缺 @supports not backdrop-filter 实色兜底");
  assert.match(await source("public/forge/shell.css"), fallback, "shell.css 缺 @supports not backdrop-filter 实色兜底");
  assert.match(await source("public/forge/art-direction.css"), fallback, "art-direction.css 缺 @supports not backdrop-filter 实色兜底");

  // 主可见玻璃面真正消费令牌：art-direction.css 是级联最后一层，顶栏/侧栏的背景与
  // backdrop-filter 必须由玻璃令牌驱动（带本地基线回退），否则滑杆/色板调不动任何可见面。
  const art = await source("public/forge/art-direction.css");
  for (const token of ["--forge-glass-alpha", "--forge-glass-filter", "--glass-tint"]) {
    assert.match(art, new RegExp(`var\\(${token},`), `art-direction.css 未消费玻璃令牌 ${token}（滑杆/色板将对顶栏侧栏无效）`);
  }
  assert.match(art, /body\.atelier \.sidebar \{[\s\S]*?var\(--forge-glass-alpha, 100%\)/, "侧栏背景必须消费令牌且本地基线为 var(--sidebar) 实色（默认零回归）");
  assert.match(art, /\.atelier \.sidebar \{[\s\S]*?backdrop-filter: var\(--forge-glass-filter, none\)/, "侧栏模糊必须消费整串滤镜令牌且回退 none（默认档不产生层叠上下文）");
  assert.match(art, /\.atelier \.topbar \{[\s\S]*?var\(--forge-glass-alpha, 96%\)/, "顶栏透明度必须消费令牌且本地基线为 96%（默认零回归）");
  assert.match(art, /\.atelier \.topbar \{[\s\S]*?backdrop-filter: var\(--forge-glass-filter, none\)/, "顶栏默认档必须严格回到 backdrop-filter: none（令牌未设回退 none，不得残留非 none 滤镜）");
  assert.doesNotMatch(art, /blur\(var\(--forge-glass-blur/, "art-direction.css 不得残留旧式逐参数 --forge-glass-blur 滤镜（默认档会恒建层叠上下文/恒加饱和）");
});

test("失焦暂停档双侧白名单注册、开关静态默认关、监听带偏好门控", async () => {
  const server = await source("server.mjs");
  const app = await source("public/app.js");
  const html = await source("public/index.html");

  // 对称断言：服务端 PREFERENCE_KEYS 与前端 APPEARANCE_PREF_KEYS 双侧含键，
  // 否则 PUT 会被服务端白名单静默丢弃，或换壳补齐时漏同步。
  const serverWhitelist = extractBlock(server, "const PREFERENCE_KEYS = new Set(");
  assert.ok(serverWhitelist.includes('"514cc-bg-pause-blur"'), "服务端 PREFERENCE_KEYS 缺 514cc-bg-pause-blur");
  const clientWhitelist = extractBlock(app, "const APPEARANCE_PREF_KEYS = ", "[", "]");
  assert.match(clientWhitelist, /BG_PAUSE_BLUR_KEY/, "前端 APPEARANCE_PREF_KEYS 缺 BG_PAUSE_BLUR_KEY");
  assert.match(app, /const BG_PAUSE_BLUR_KEY = "514cc-bg-pause-blur";/, "前端键常量字面值与服务端键失联");

  // 失焦开关静态默认关闭：首帧/无 JS 状态不得误冻背景视频。
  const toggle = html.match(/<button[^>]*id="appearance-bg-pause-blur"[^>]*>/);
  assert.ok(toggle, "index.html 缺少 #appearance-bg-pause-blur 开关");
  assert.match(toggle[0], /aria-checked="false"/, "失焦暂停开关必须静态默认关闭（aria-checked=\"false\"）");

  // blur/focus 监听体内必须调偏好门控函数（第二档可开关，不恒开）。
  const listeners = extractBlock(app, "function installTeamBgSuspensionOnce(");
  assert.match(listeners, /addEventListener\("blur",[\s\S]*?readBgPauseBlurPreference\(\)/, "blur 监听缺偏好门控调用");
  assert.match(listeners, /addEventListener\("focus",[\s\S]*?readBgPauseBlurPreference\(\)/, "focus 监听缺偏好门控调用");
});

test("/api/preferences 往返：空库、白名单、防呆与损坏回退", { timeout: 90_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-ambient-prefs-"));
  const token = "e2e-ambient-prefs-token-0123456789";
  const preferencesPath = join(dataRoot, "preferences.json");
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
  const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

  // 契约：端点受本地 token 保护。
  const denied = await fetch(`${origin}/api/preferences`);
  assert.equal(denied.status, 401, "/api/preferences 必须要求本地 token");
  await denied.arrayBuffer().catch(() => {});

  // 契约：空库（文件不存在）也返回 200 空对象，读路径不打断前端首帧。
  const empty = await fetch(`${origin}/api/preferences`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { preferences: {} }, "空库 GET 必须返回 {preferences:{}}");

  // 契约：合法键写入后回读一致；白名单外键被静默丢弃；防抖落盘真实发生。
  const put = await fetch(`${origin}/api/preferences`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ "514cc-accent": "teal", "514cc-glass-blur": "14", "evil-key": "drop-me" }),
  });
  assert.equal(put.status, 200);
  const putBody = await put.json();
  assert.equal(putBody.preferences["514cc-accent"], "teal");
  assert.equal(putBody.preferences["514cc-glass-blur"], "14");
  assert.ok(!("evil-key" in putBody.preferences), "白名单外的键不得进入存储");
  await delay(800); // 200ms 防抖落盘窗口
  const reread = await fetch(`${origin}/api/preferences`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(reread.status, 200);
  const rereadBody = await reread.json();
  assert.equal(rereadBody.preferences["514cc-accent"], "teal", "GET 回读必须与 PUT 一致");
  assert.equal(rereadBody.preferences["514cc-glass-blur"], "14");
  assert.ok(!("evil-key" in rereadBody.preferences));
  const persisted = JSON.parse(await readFile(preferencesPath, "utf8"));
  assert.equal(persisted["514cc-accent"], "teal", "防抖后偏好必须真实落盘");

  // 契约：非对象与坏 JSON 一律 400，不得半写入。
  const arrayBody = await fetch(`${origin}/api/preferences`, { method: "PUT", headers, body: JSON.stringify(["teal"]) });
  assert.equal(arrayBody.status, 400, "非对象请求体必须 400");
  await arrayBody.arrayBuffer().catch(() => {});
  const badJson = await fetch(`${origin}/api/preferences`, { method: "PUT", headers, body: "{oops" });
  assert.equal(badJson.status, 400, "坏 JSON 必须 400");
  await badJson.arrayBuffer().catch(() => {});
  const badValue = await fetch(`${origin}/api/preferences`, { method: "PUT", headers, body: JSON.stringify({ "514cc-accent": 42 }) });
  assert.equal(badValue.status, 400, "非字符串偏好值必须 400");
  await badValue.arrayBuffer().catch(() => {});
  const stillTeal = await fetch(`${origin}/api/preferences`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await stillTeal.json()).preferences["514cc-accent"], "teal", "被拒绝的 PUT 不得污染既有偏好");

  // 契约：磁盘文件损坏时回退默认（200 空对象），且绝不覆盖/删除用户文件。
  await delay(300); // 确保没有悬挂的防抖写会在校验后覆盖文件
  const corruption = "{ this is not json at all !!!";
  await writeFile(preferencesPath, corruption, "utf8");
  const corrupted = await fetch(`${origin}/api/preferences`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(corrupted.status, 200, "损坏文件不得让读路径报错");
  assert.deepEqual(await corrupted.json(), { preferences: {} }, "损坏文件必须回退空偏好（默认外观）");
  await delay(300);
  assert.equal(await readFile(preferencesPath, "utf8"), corruption, "损坏回退只降级读取路径，不得覆盖/删除用户文件");

  await stopTestServer(child, { token });
});
