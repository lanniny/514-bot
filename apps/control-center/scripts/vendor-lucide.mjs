import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = join(root, "node_modules/lucide/dist/esm/icons");

// Forge 全量清单：与 public/lucide-icons.json 的 manifest 保持一致；
// 上游 stop-circle 已更名 circle-stop（不要再加回 stop-circle）。
const names = [
  "activity", "archive", "arrow-down", "arrow-left", "arrow-right", "arrow-up", "arrow-up-right", "bell", "book-open", "bot", "box", "boxes",
  "brain", "brush", "camera", "chart-column", "check", "chevron-down", "chevron-right", "circle-alert", "circle-check",
  "circle-dot", "circle-pause", "circle-play", "circle-stop", "clipboard-list", "cloud", "cloud-download", "cloud-upload",
  "code", "command", "compass", "copy", "corner-down-left", "cpu", "database", "diamond", "download", "ellipsis", "external-link", "image",
  "eye", "file-input", "file-json", "file-pen-line", "file-plus-2", "file-text", "file-type", "fingerprint", "flame",
  "flask-conical", "folder", "folder-git-2", "folder-open", "gauge",
  "list-filter",
  "git-branch", "git-commit-horizontal", "globe", "grid-2x2", "hammer", "heart-pulse", "hexagon", "history", "import", "info",
  "key-round", "layers", "layout-dashboard", "library", "lightbulb", "link", "list", "loader-circle", "lock",
  "log-in", "log-out", "message-circle", "message-square", "messages-square", "mic", "minus", "monitor", "moon", "network", "orbit", "package",
  "package-plus", "palette", "panel-left", "panel-right", "paperclip", "pencil", "pin", "pause", "play", "plug-zap", "plus", "puzzle",
  "radar", "refresh-ccw", "refresh-cw", "repeat", "rocket", "rotate-ccw", "route", "satellite-dish", "save",
  "scan-search", "search", "send", "server", "settings", "shield", "shield-alert", "shield-check", "shopping-bag", "sparkles",
  "square", "square-terminal", "star", "store", "sun", "telescope", "terminal", "timer", "trash-2",
  "triangle-alert", "type", "unplug", "upload", "user-minus", "user-round", "users", "wallet", "wand-sparkles", "waves", "waypoints",
  "webhook", "workflow", "wrench", "x", "zap",
];

const symbols = [];
const missing = [];

for (const name of names) {
  const file = join(dir, `${name}.js`);
  try {
    const src = readFileSync(file, "utf8");
    // lucide 0.5xx: `const IconName = [ ["path", {...}], ... ]; export { IconName as default };`
    const m = src.match(/const\s+\w+\s*=\s*(\[[\s\S]*?\]);\s*\nexport/);
    if (!m) {
      missing.push(`${name}:no-match`);
      continue;
    }
    // eslint-disable-next-line no-new-func
    const arr = Function(`"use strict"; return (${m[1]});`)();
    const id = `lucide-${name}`;
    let inner = "";
    for (const [tag, attrs] of arr) {
      const attrStr = Object.entries(attrs)
        .map(([k, v]) => `${k}="${String(v).replace(/"/g, "&quot;")}"`)
        .join(" ");
      inner += `<${tag} ${attrStr}/>`;
    }
    symbols.push(
      `<symbol id="${id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${inner}</symbol>`,
    );
  } catch (error) {
    missing.push(`${name}:${error.message}`);
  }
}

const svg = `<!-- Lucide icons (ISC License) vendored offline for 514 Forge desktop.
     Source: lucide@0.511.0 — https://lucide.dev
     Do not hand-edit; regenerate via: node scripts/vendor-lucide.mjs
     CSP：根元素不得带 style 属性（style-src 'self' 拦截）；隐藏由挂载宿主 #lucide-sprite-host[hidden] 承担。 -->
<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
${symbols.join("\n")}
</svg>
`;

writeFileSync(join(root, "public/lucide-sprite.svg"), svg);
writeFileSync(
  join(root, "public/lucide-icons.json"),
  `${JSON.stringify({ count: symbols.length, icons: [...names].sort(), missing, renamed: { "stop-circle": "circle-stop" } }, null, 2)}\n`,
);
console.log(`wrote ${symbols.length} lucide symbols; missing=${missing.length}`);
if (missing.length) console.log(missing.join("\n"));
