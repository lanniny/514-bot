import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

// W3.9 远程主机资源仪表：探针 metrics 进主机卡 + 30s 轻刷新（源码契约断言，
// 与 market-panel.test.mjs 同款惯例——模块非纯函数导出，走静态结构断言）
test("hosts panel renders probe metrics gauges and schedules a 30s refresh", async () => {
  const panel = await readFile(`${appRoot}/public/hosts-panel.js`, "utf8");
  assert.match(panel, /function metricsHtml\(metrics\)/);
  assert.match(panel, /hostmeter-bar/);
  assert.match(panel, /usagePercent/);
  assert.match(panel, /metrics\.load/);
  assert.match(panel, /metrics\.uptimeSeconds/);
  assert.match(panel, /data-worktree-remove|probeHostEnv\(root, id\)/, "refresh loop re-probes expanded hosts");
  assert.match(panel, /30_000/);
  assert.match(panel, /\$\{metricsHtml\(probe\.metrics\)\}/, "detailHtml embeds the metrics strip");

  const css = await readFile(`${appRoot}/public/styles.css`, "utf8");
  assert.match(css, /\.hostmeter-bar/);
});
