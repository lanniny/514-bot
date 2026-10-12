// 主题首帧引导：在样式表之前同步执行，避免暗色用户看到白屏闪烁。
// CSP script-src 'self' 禁内联脚本，所以独立成文件；app.js 里的 initializeTheme 负责后续切换。
(function () {
  var bootPrefs = {};
  try {
    var bootNode = typeof document !== "undefined" && document.getElementById ? document.getElementById("__514CC_BOOT_PREFS__") : null;
    if (bootNode && bootNode.textContent) {
      bootPrefs = JSON.parse(bootNode.textContent) || {};
    }
  } catch (e) {}

  function getPref(key) {
    try {
      var local = localStorage.getItem(key);
      if (local !== null) return local;
    } catch (e) {}
    if (bootPrefs && typeof bootPrefs[key] === "string") {
      try { localStorage.setItem(key, bootPrefs[key]); } catch (e) {}
      return bootPrefs[key];
    }
    return null;
  }

  try {
    if (bootPrefs && typeof bootPrefs === "object") {
      for (var k in bootPrefs) {
        if (Object.prototype.hasOwnProperty.call(bootPrefs, k) && typeof bootPrefs[k] === "string") {
          try {
            if (localStorage.getItem(k) === null) {
              localStorage.setItem(k, bootPrefs[k]);
            }
          } catch (e) {}
        }
      }
    }
  } catch (e) {}

  var theme = "light";
  try {
    var stored = getPref("514cc-control-theme");
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
    var size = parseInt(getPref("514cc-ui-font-size"), 10);
    if (size >= 12 && size <= 18) {
      document.documentElement.style.setProperty("--ui-font-size", size + "px");
    }
    var codeSize = parseFloat(getPref("514cc-code-font-size"));
    if (codeSize >= 11 && codeSize <= 16) {
      document.documentElement.style.setProperty("--code-font-size", codeSize + "px");
    }
    // 下方字体白名单是防白闪的最小副本；权威定义在 app.js 的 UI_FACE_SET / CODE_FACE_SET，改那里须同步这里。
    var face = getPref("514cc-ui-font-face");
    document.documentElement.dataset.uiFace = face === "yahei" || face === "song" ? face : "system";
    var codeFace = getPref("514cc-code-font-face");
    document.documentElement.dataset.codeFace = codeFace === "cascadia" || codeFace === "jetbrains" ? codeFace : "system";
    var accent = getPref("514cc-accent");
    document.documentElement.dataset.accent = /^(rose|teal|indigo)$/.test(accent || "") ? accent : "copper";
    var density = getPref("514cc-density");
    document.documentElement.dataset.density = density === "compact" || density === "comfortable" ? density : "default";
    var botFace = getPref("514cc-bot-face");
    if (document.documentElement.classList) {
      if (botFace === "workbench") document.documentElement.classList.remove("is-bot-grok-face");
      else document.documentElement.classList.add("is-bot-grok-face");
    }
    document.documentElement.dataset.codeWrap = getPref("514cc-code-wrap") === "on" ? "on" : "off";
    document.documentElement.dataset.codeLines = getPref("514cc-code-lines") === "on" ? "on" : "off";
    document.documentElement.dataset.motion = getPref("514cc-motion") === "reduce" ? "reduce" : "system";

    // ── 壁纸与玻璃态首帧引导：同步偏好先行，消除 1-2s 白底等待 ──
    var rawWall = getPref("514cc-global-wallpaper");
    if (rawWall) {
      var wallPref = JSON.parse(rawWall);
      var validPresets = ["custom", "aurora", "ember", "tide", "moss", "noir"];
      if (wallPref && validPresets.indexOf(wallPref.preset) !== -1) {
        if (wallPref.preset !== "custom" || wallPref.hasCustom) {
          if (document.documentElement.classList) {
            document.documentElement.classList.add("team-bg-active");
          }
          document.documentElement.dataset.teamBg = wallPref.preset;
          if (wallPref.fit === "contain" || wallPref.fit === "tile" || wallPref.fit === "cover") {
            document.documentElement.dataset.bgFit = wallPref.fit;
          }
        }
      }
    }
  } catch (error) {
    /* 隐私模式等读不到偏好时保持默认 */
  }

  // 若首帧已激活壁纸，在 <body> 挂入 DOM 的第一时刻补齐 body.team-bg-active
  function applyBodyWallpaper() {
    try {
      if (!document.body) return;
      if (document.documentElement.classList && document.documentElement.classList.contains("team-bg-active")) {
        document.body.classList.add("team-bg-active");
        if (document.documentElement.dataset.teamBg) {
          document.body.dataset.teamBg = document.documentElement.dataset.teamBg;
        }
      }
    } catch (e) {}
  }
  if (typeof MutationObserver !== "undefined" && document.documentElement) {
    var observer = new MutationObserver(function () {
      if (document.body) {
        observer.disconnect();
        applyBodyWallpaper();
      }
    });
    observer.observe(document.documentElement, { childList: true });
  }
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("DOMContentLoaded", applyBodyWallpaper);
  }
})();

