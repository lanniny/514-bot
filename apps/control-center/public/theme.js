// 主题首帧引导：在样式表之前同步执行，避免暗色用户看到白屏闪烁。
// CSP script-src 'self' 禁内联脚本，所以独立成文件；app.js 里的 initializeTheme 负责后续切换。
(function () {
  var theme = "light";
  try {
    var stored = localStorage.getItem("514cc-control-theme");
    if (stored === "light" || stored === "dark") theme = stored;
    else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) theme = "dark";
  } catch (error) {
    /* localStorage 不可用（隐私模式等）时保持亮色 */
  }
  document.documentElement.dataset.theme = theme;
  try {
    document.documentElement.style.removeProperty("--text-base");
    document.documentElement.style.removeProperty("--text-sm");
    document.documentElement.style.removeProperty("--text-xs");
    document.documentElement.style.removeProperty("--text-lg");
    var size = parseInt(localStorage.getItem("514cc-ui-font-size"), 10);
    if (size >= 12 && size <= 18) {
      document.documentElement.style.setProperty("--ui-font-size", size + "px");
    }
    var codeSize = parseFloat(localStorage.getItem("514cc-code-font-size"));
    if (codeSize >= 11 && codeSize <= 16) {
      document.documentElement.style.setProperty("--code-font-size", codeSize + "px");
    }
    // 下方字体白名单是防白闪的最小副本；权威定义在 app.js 的 UI_FACE_SET / CODE_FACE_SET，改那里须同步这里。
    var face = localStorage.getItem("514cc-ui-font-face");
    document.documentElement.dataset.uiFace = face === "yahei" || face === "song" ? face : "system";
    var codeFace = localStorage.getItem("514cc-code-font-face");
    document.documentElement.dataset.codeFace = codeFace === "cascadia" || codeFace === "jetbrains" ? codeFace : "system";
    var accent = localStorage.getItem("514cc-accent");
    document.documentElement.dataset.accent = /^(rose|teal|indigo)$/.test(accent || "") ? accent : "copper";
    var density = localStorage.getItem("514cc-density");
    document.documentElement.dataset.density = density === "compact" || density === "comfortable" ? density : "default";
    document.documentElement.dataset.codeWrap = localStorage.getItem("514cc-code-wrap") === "on" ? "on" : "off";
    document.documentElement.dataset.codeLines = localStorage.getItem("514cc-code-lines") === "on" ? "on" : "off";
    document.documentElement.dataset.motion = localStorage.getItem("514cc-motion") === "reduce" ? "reduce" : "system";
  } catch (error) {
    /* 隐私模式等读不到偏好时保持默认 */
  }
})();
