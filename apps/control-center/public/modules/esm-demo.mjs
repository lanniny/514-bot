/**
 * W1 解耦波 — 原生 ESM 模块化示范。
 *
 * 将 app.js 中的核心逻辑抽取为独立模块，使用 import/export 重写依赖关系。
 * 不引入构建工具，浏览器直接加载（需 HTTP/2 支持多路复用）。
 *
 * 下一步：
 *   1. 将 providers.mjs/orchestrator.mjs 等大模块按职责拆分为更小单元
 *   2. index.html 改用 <script type="importmap"> + type="module"
 *   3. 评估首屏加载性能，决定是否引入 esbuild minify
 */

// 示例：提取路由逻辑到独立模块
export function initRouter() {
  console.log("[ESM] Router module loaded");
  // TODO: 从 app.js 迁移路由初始化逻辑
}

// 示例：提取状态管理
export const appState = {
  currentRun: null,
  activeAgents: [],
  budget: { maxRounds: 6, currentRound: 0 },
};

// 示例：提取工具函数
export function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
