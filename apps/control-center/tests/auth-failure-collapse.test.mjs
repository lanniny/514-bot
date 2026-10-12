/**
 * auth-failure-collapse.test.mjs — 「认证失效」必须作为一个**原因**呈现，而不是 N 个功能各自报错。
 *
 * 背景（2026-09-11 复现实证）：令牌按**内核进程**签发，内核一重启旧凭据即全废。
 * 传输层其实已经中心化地把 401 记为 `auth="error"`、徽章也显示「会话未授权」——
 * 但**没有任何消费者**：每个后台加载各自弹一条服务端原始英文诊断，
 * 用户看到的是「团队坏了 + 项目坏了 + 偏好坏了」，而不是「一个原因，怎么办」。
 * 实测：无有效凭据时 61 条 401，其中 `/api/teams`、`/api/sessions/projects`、`/api/projects/prefs`
 * 各自弹一条原始英文——与 2026-09-11 截图逐条对应。
 *
 * 守三件事：
 *  1. api.js 在唯一咽喉点归一 401 UNAUTHORIZED（request 与 requestBlob **两条**路径都要）。
 *  2. app.js 的 toast() 收敛该文案并去重——同类只留一条。
 *  3. **漂移守卫**：两文件的文案字面量必须一致；只改一处会让收敛静默失效（回到各弹一条）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

async function source(path) {
  return (await readFile(`${appRoot}/${path}`, "utf8")).replace(/\r\n/g, "\n");
}

test("api.js 在两条请求路径上都把 401 UNAUTHORIZED 归一成可执行中文", async () => {
  const api = await source("public/api.js");
  const normalizations = [...api.matchAll(
    /if \(response\.status === 401 && String\(errorPayload\?\.code \?\? ""\) === "UNAUTHORIZED"\) \{\n\s+throw new ApiError\("会话凭据已失效", 401, payload\);/g,
  )];
  assert.equal(
    normalizations.length,
    2,
    "request() 与 requestBlob() 都必须归一；只修一条会让二进制路径继续漏出原始英文诊断",
  );
  // 原始服务端诊断不得再被直接当作用户文案抛给调用方
  assert.doesNotMatch(api, /Missing or invalid local access token/);
});

test("toast() 收敛认证失效并去重，且文案与 api.js 不漂移", async () => {
  const [api, app] = await Promise.all([source("public/api.js"), source("public/app.js")]);

  const declared = /const AUTH_FAILURE_TEXT = "([^"]+)";/.exec(app);
  assert.ok(declared, "app.js 必须用命名常量声明认证失效文案");
  const marker = declared[1];

  // 漂移守卫：api.js 抛出的 message 必须**逐字**等于 toast 用来识别的标记，
  // 否则 toast 认不出来，收敛静默失效——症状会原样退回「三条原始报错叠一柱」。
  assert.ok(
    api.includes(`"${marker}"`),
    `api.js 必须抛出逐字一致的 "${marker}"；改文案时两处必须同改`,
  );

  // 去重：同类只留一条，直到它自己消失
  assert.match(app, /node\.dataset\.toastAuth === "1"[\s\S]*?\) return;/);
  assert.match(app, /item\.dataset\.toastAuth = "1";/);
  // 恢复路径必须说准：旧带凭据地址的 nonce 已被消费，不能笼统让人"重新访问原地址"
  assert.match(app, /新启动时打印的地址/);
});

test("认证失效必须给**恢复入口**，且健康态下不得留假按钮", async () => {
  const app = await source("public/app.js");

  // 只认「已注册」的原生命令，不新开凭据通道
  assert.match(app, /invoke\("restart_app"\)/);
  // 桌面端才走重启；浏览器端如实说明无法自愈（不假装能修）
  assert.match(app, /__TAURI_INTERNALS__\?\.invoke/);
  assert.match(app, /浏览器模式无法自动恢复/);

  // 标记**只在** auth === "error" 时打上，否则每个用户都会看到一个点了没用的按钮
  const marker = /if \(snapshot\.auth === "error"\) \{\n\s+badge\.dataset\.authRecovery = "1";/.exec(app);
  assert.ok(marker, "徽章的恢复标记必须由 auth===\"error\" 门控");
  assert.match(app, /\} else \{\n\s+delete badge\.dataset\.authRecovery;/);

  // 键盘可达：role/tabindex 同进同出，且有 Enter/Space 处理
  assert.match(app, /badge\.setAttribute\("role", "button"\)/);
  assert.match(app, /badge\.removeAttribute\("tabindex"\)/);
  assert.match(app, /event\.key !== "Enter" && event\.key !== " "/);

  // 可点必须看得出来（能点却看不出能点 = 等于没有这个入口）
  const shell = await source("public/forge/shell.css");
  assert.match(shell, /\.connection-badge\[data-auth-recovery="1"\] \{\n\s+cursor: pointer;/);
  assert.match(shell, /\.connection-badge\[data-auth-recovery="1"\]:focus-visible \{/);
});
