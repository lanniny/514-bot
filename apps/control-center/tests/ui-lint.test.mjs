import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * UI-AUDIT 门禁回归（P0-1 裸色 / P0-2 裸字号 / P0-4 非标准断点 / P1-3 innerHTML）
 *
 * 基线制：scripts/ui-baseline.json 记录存量技术债，任何新增违规即红灯。
 * 这里以子进程方式调用门禁脚本，使其既可独立运行（npm run ui:lint），
 * 又被 `npm test` 自动纳入回归。
 */
test("ui-lint gate: no new bare style values or non-standard breakpoints", () => {
  const result = spawnSync(process.execPath, [join(appRoot, "scripts", "ui-lint.mjs")], {
    cwd: appRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `UI 门禁失败：\n${result.stdout ?? ""}${result.stderr ?? ""}`);
});

test("ui-tokens codemod: every font-size px value maps onto a --text-* token", async () => {
  const { fontSizeToken } = await import("../scripts/ui-tokens.mjs");
  // 可读性硬下限：任何 <12px 的输入都必须落到 --text-xs（12px），不允许更小档位
  for (const px of [8, 9, 9.5, 10, 10.5, 11, 11.5, 12]) {
    assert.equal(fontSizeToken(px), "--text-xs", `${px}px 必须提升到 --text-xs`);
  }
  assert.equal(fontSizeToken(13), "--text-sm");
  assert.equal(fontSizeToken(14), "--text-base");
  assert.equal(fontSizeToken(16), "--text-lg");
  assert.equal(fontSizeToken(44), "--text-5xl");
});
