/**
 * terminal-panel.js — Wave G 终端（xterm 多页签 + PTY 后端），已工厂化。
 *
 * 契约：
 *   - vendored xterm（/vendor/xterm/，离线无 CDN）；主题跟随 forge 明暗
 *   - 输出走 fetch 流式读（与 app.js consumeEvents 同款，可带 Authorization）
 *   - 输入 POST 单飞；ResizeObserver 自适应；会话退出标记页签
 *   - 门闸未开放 → 引导卡；零 emoji；lucideIcon；无内联 style 属性
 *
 * 工厂化（布局模仿波 2026-07-26）：
 *   createTerminalPanel(root) 返回独立实例（各自 tabs 台账），终端视图与协作台
 *   底部 dock 各持一份。PTY 后端 stream 是订阅制（replay + 广播），多实例同挂
 *   一个 session 等价 tmux 双 attach——输出全量各收，输入两路皆可达。
 */
import { request, apiReady, getAccessToken } from "./api.js";
import { lucideIcon } from "./lucide.js";
import { escapeHtml } from "./utils.js";
import { ACTIVE_RUN_STATES } from "./state.js";
import { resolveWorkbenchPtySpawn, folderNameFromPath } from "./modules/workbench-cwd.js";
import { Terminal } from "./vendor/xterm/xterm.mjs";
import { FitAddon } from "./vendor/xterm/addon-fit.mjs";

function themeTokens() {
  const style = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: pick("--forge-bg-primary", "#1c1917"),
    foreground: pick("--forge-text-primary", "#e7e5e4"),
    cursor: pick("--forge-accent", "#e11d48"),
    cursorAccent: pick("--forge-bg-primary", "#1c1917"),
    selectionBackground: pick("--forge-accent-soft", "#57534e"),
    // 追加 Nerd Font 候选：oh-my-posh / starship 的提示符字形只有装了 Nerd Font 才不显示成方块；
    // 装了就自动生效，没装则按顺序回落到普通等宽字体。
    fontFamily: [
      pick("--forge-font-mono", ""),
      "'CaskaydiaCove Nerd Font'", "'CaskaydiaCove NF'", "'MesloLGS NF'", "'FiraCode Nerd Font'", "'JetBrainsMono Nerd Font'",
      "'Cascadia Mono'", "Consolas", "'Courier New'", "monospace",
    ].filter(Boolean).join(", "),
  };
}

function gateCard(root, gate, reason) {
  root.innerHTML = `
    <div class="forge-empty-waveg">
      ${lucideIcon("lock", "icon lucide icon-lg")}
      <h2>终端门闸未开放</h2>
      <p class="subtle">${gate ?? "pty"} · ${reason ?? "需要 LO 授权账本记录"}</p>
    </div>`;
}

export function createTerminalPanel(root, { fixedSessions = null, allowSpawn = true, onAllClosed = null, onFirstChunk = null, onTabClosed = null, onSessionExited = null } = {}) {
  const tabs = new Map(); // id → { session, term, fit, paneEl, tabEl, streamCtl, observer, exited }

  /**
   * 订阅一条会话流。断线后自动重连，且重连一律 `replay=0`：
   *   - 不重连 → 流一断就再也收不到输出，表现是"终端打不出字"（输入其实发出去了）
   *   - 重连时重放 → 每断一次就多一整份首屏，表现是"打开终端有很多条"
   * 只有首次订阅才允许重放缓冲，后续重连只接实时增量。
   */
  async function fetchStream(sessionId, tab, { attempt = 0 } = {}) {
    const headers = { Accept: "text/event-stream" };
    if (getAccessToken()) headers.Authorization = `Bearer ${getAccessToken()}`;
    const query = attempt === 0 ? "" : "?replay=0";
    try {
      const response = await fetch(`/api/pty/${sessionId}/stream${query}`, { headers, signal: tab.streamCtl.signal });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const match = /\r?\n\r?\n/.exec(buffer);
          if (!match) break;
          const frame = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          for (const line of frame.split(/\r?\n/)) {
            if (!line.startsWith("data: ")) continue;
            try {
              // 服务端 JSON.stringify 输出本无真实换行（其 replace 是 no-op），
              // 这里必须直接 parse——先反转义会让 JSON 含非法控制字符，含 \n 的 chunk 全丢。
              const payload = JSON.parse(line.slice(6));
              if (payload.exited) {
                const firstExit = !tab.exited;
                tab.exited = true;
                markTabExited(tab);
                if (firstExit) {
                  // CLI 进程自然退出（用户在 TUI 里 /exit 等）：宿主据此把成员页签的映射
                  // 还原为"未启动"，再点即重新 spawn——不残留指向死会话的僵尸 chip
                  try { onSessionExited?.(sessionId, tab); } catch { /* 宿主钩子异常不炸流 */ }
                }
              } else if (typeof payload.chunk === "string") {
                // 首块非空输出 = 原生 TUI 已活：通知宿主撤掉冷启动提示（只火一次）
                if (!tab.gotChunk && payload.chunk) {
                  tab.gotChunk = true;
                  try { onFirstChunk?.(tab); } catch { /* 宿主提示物异常不炸流 */ }
                }
                tab.term.write(payload.chunk);
              }
            } catch { /* 单帧解析失败不炸流 */ }
          }
        }
      }
      // 服务端正常收尾（进程退出）会先推 exited 帧；否则视为连接断开，重连续听
      if (!tab.exited && !tab.streamCtl.signal.aborted) {
        void reconnectStream(sessionId, tab, attempt, "连接结束");
      }
    } catch (error) {
      if (!tab.streamCtl.signal.aborted) {
        void reconnectStream(sessionId, tab, attempt, error.message);
      }
    }
  }

  /** 指数退避重连（上限 5 次 / 8 秒）。用尽后才把中断如实写进终端，不静默假死。 */
  async function reconnectStream(sessionId, tab, attempt, reason) {
    if (tab.exited || tab.streamCtl.signal.aborted) return;
    if (attempt >= 5) {
      tab.term?.write(`\r\n\x1b[31m[连接中断：${String(reason ?? "未知").replace(/[\r\n]+/g, " ")}；请关闭该标签后重开]\x1b[0m\r\n`);
      return;
    }
    const delay = Math.min(8000, 400 * 2 ** attempt);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (tab.exited || tab.streamCtl.signal.aborted) return;
    void fetchStream(sessionId, tab, { attempt: attempt + 1 });
  }

  function markTabExited(tab) {
    tab.tabEl?.classList.add("is-exited");
    tab.term?.write("\r\n\x1b[2m[进程已退出]\x1b[0m\r\n");
  }

  function activateTab(id) {
    // 先按 DOM 全量清一遍 is-active：只遍历 tabs 会漏掉"已从 Map 移除但 DOM 还在"的孤儿面板，
    // 那些孤儿会一直保留 is-active 而与当前面板同时可见（LO 2026-08-08：同一份首屏并排出现很多条）。
    for (const pane of root.querySelectorAll(".terminal-pane")) pane.classList.remove("is-active");
    for (const [tabId, tab] of tabs) {
      const active = tabId === id;
      tab.tabEl?.classList.toggle("is-active", active);
      tab.paneEl?.classList.toggle("is-active", active);
      if (active) {
        requestAnimationFrame(() => {
          tab.fit.fit();
          // 从隐藏态切回可见时 xterm 不会自己补画，必须显式 refresh，否则是一片空白
          try { tab.term.refresh(0, Math.max(0, tab.term.rows - 1)); } catch { /* 尺寸未就绪 */ }
          tab.term.focus();
        });
      }
    }
    root.querySelector(".terminal-new-input")?.classList.add("is-hidden");
  }

  async function closeTab(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    tab.streamCtl.abort();
    tab.observer?.disconnect();
    try {
      await request(`/api/pty/${id}`, { method: "DELETE" });
    } catch { /* 已死 */ }
    disposeTab(tab); // 与重复挂载走同一条释放路径，避免两处清理逻辑各漏一半
    tabs.delete(id);
    try { onTabClosed?.(id); } catch { /* 宿主钩子异常不阻断关闭 */ }
    const remaining = [...tabs.keys()];
    if (remaining.length) activateTab(remaining[remaining.length - 1]);
    else {
      renderTabStrip();
      // 专用面板（沉浸接续）最后一页关掉 = 视图使命结束，通知宿主收罩层
      if (!remaining.length && typeof onAllClosed === "function") onAllClosed();
    }
  }

  /** 给既有/新建 session 挂 DOM + xterm + 流（spawn 与恢复共用）。 */
  /** 释放一个 tab 的流、观察者与 xterm 实例（重复挂载与关闭共用，避免残留订阅重放缓冲）。 */
  function disposeTab(tab) {
    if (!tab) return;
    tab.streamCtl.abort();
    tab.observer?.disconnect();
    window.clearTimeout(tab.resizeTimer); // 去抖中的 resize 不能打到已释放的会话上
    try { tab.term.dispose(); } catch { /* 已释放 */ }
    tab.paneEl?.remove();
    tab.tabEl?.remove();
  }

  function attachSession(session) {
    // 幂等：同一 session 被重复 attach 时先拆旧的。每条 SSE 连接都会重放整个环形缓冲，
    // 残留订阅会把同一份首屏一遍遍写进终端（LO 2026-08-08：打开终端看到很多条重复）。
    const existing = tabs.get(session.id);
    if (existing) {
      disposeTab(existing);
      tabs.delete(session.id);
    }
    const panesRoot = root.querySelector(".terminal-panes");
    const paneEl = document.createElement("div");
    // xterm 硬性约束：open() 必须在元素可见时调用，否则渲染器按 0 尺寸初始化，
    // 之后 write() 的内容不会被绘出来——表现就是"终端里打不出字"。
    // .terminal-pane 默认 display:none，所以这里先让新面板可见（其余面板由 activateTab 统一收敛）。
    paneEl.className = "terminal-pane";
    for (const other of root.querySelectorAll(".terminal-pane")) other.classList.remove("is-active");
    paneEl.classList.add("is-active");
    panesRoot.appendChild(paneEl);

    const tokens = themeTokens();
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: tokens.fontFamily,
      theme: tokens,
      scrollback: 2000,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(paneEl);
    const tab = {
      id: session.id,
      session,
      term,
      fit,
      paneEl,
      tabEl: null,
      streamCtl: new AbortController(),
      exited: Boolean(session.exited),
      resizeTimer: 0,
      lastSize: `${session.cols ?? 0}x${session.rows ?? 0}`, // 与服务端已知尺寸对齐，首帧不做无谓上报
    };
    tabs.set(session.id, tab);

    // 输入失败绝不静默：用户看到的表象是"终端打不出字"，必须把真实原因打进终端。
    // 只在由通到断的那一次提示，避免每个按键刷一行。
    term.onData((data) => {
      if (tab.exited) return;
      void request(`/api/pty/${session.id}/input`, { method: "POST", body: JSON.stringify({ data }) })
        .then(() => { tab.inputBroken = false; })
        .catch((error) => {
          if (tab.inputBroken) return;
          tab.inputBroken = true;
          tab.term.write(`\r\n\x1b[31m[输入未送达：${String(error?.message ?? "未知错误").replace(/[\r\n]+/g, " ")}]\x1b[0m\r\n`);
        });
    });
    // 点击面板任意处都聚焦：xterm 只在自己的画布上自动聚焦，点到内边距会打不进字
    paneEl.addEventListener("mousedown", () => term.focus());
    // ConPTY 每收到一次 resize 就让 shell 重绘整屏（oh-my-posh 提示符尤其明显）。
    // 拖动外框时 ResizeObserver 逐帧触发，逐帧上报会把几十份重绘追加进滚动缓冲——
    // 表现就是"反复拉伸终端会出现重复显示"（LO 2026-08-08）。
    // 因此：fit 立即执行保证视觉跟手，上报去抖到静止后一次，且尺寸没变就完全不打扰 ConPTY。
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return; // 隐藏态 fit 失败可忽略
      }
      window.clearTimeout(tab.resizeTimer);
      tab.resizeTimer = window.setTimeout(() => {
        const size = `${term.cols}x${term.rows}`;
        if (size === tab.lastSize) return;
        tab.lastSize = size;
        // 尺寸同步失败不阻断可用性；真正的会话级故障由 input 与 stream 两条路径报出
        void request(`/api/pty/${session.id}/resize`, { method: "POST", body: { cols: term.cols, rows: term.rows } }).catch(() => {});
      }, 140);
    });
    observer.observe(paneEl);
    tab.observer = observer;

    void fetchStream(session.id, tab);
    renderTabStrip();
    activateTab(session.id);
  }

  function sessionTabLabel(session) {
    const folder = folderNameFromPath(session.cwd);
    const name = session.title || folder || String(session.shell ?? "").split(/[\\/]/).pop() || "pwsh";
    return `${name} · ${session.id}`;
  }

  async function spawnTab(shell = "") {
    const context = resolveWorkbenchPtySpawn();
    const payload = {
      ...(shell ? { shell } : {}),
      ...context,
    };
    const { session } = await request("/api/pty", { method: "POST", body: JSON.stringify(payload) });
    attachSession(session);
  }

  function renderTabStrip() {
    const strip = root.querySelector(".terminal-tabs");
    if (!strip) return;
    strip.innerHTML = "";
    for (const [id, tab] of tabs) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `terminal-tab${tab.exited ? " is-exited" : ""}`;
      item.innerHTML = `${lucideIcon("square-terminal", "icon lucide")}<span>${escapeHtml(sessionTabLabel(tab.session))}</span>`;
      item.addEventListener("click", () => activateTab(id));
      const close = document.createElement("span");
      close.className = "terminal-tab-close";
      close.innerHTML = lucideIcon("x", "icon lucide");
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        void closeTab(id);
      });
      item.appendChild(close);
      tab.tabEl = item;
      strip.appendChild(item);
    }
    const add = document.createElement("button");
    add.type = "button";
    add.className = "terminal-tab terminal-tab-add";
    add.innerHTML = `${lucideIcon("plus", "icon lucide")}<span>新建</span>`;
    add.addEventListener("click", () => void spawnTab());
    if (allowSpawn) strip.appendChild(add); // 沉浸接续等专用面板不提供裸 shell 入口
  }

  let mounting = null;

  /** 并发/重复挂载保护：抽屉展开、重试按钮、宿主自举都可能触发 mount，
      不串行化就会各自 spawn 一个 pwsh 并各自重放缓冲。 */
  function mount() {
    if (mounting) return mounting;
    mounting = mountOnce().finally(() => { mounting = null; });
    return mounting;
  }

  async function mountOnce() {
    // 首个请求必须等 token 自举完成（api.js:62 的 401 竞态）。底部终端抽屉会在启动时
    // 恢复上次的打开态并立刻 mount，这条 await 是它不被渲染成「终端服务异常」的唯一保证。
    await apiReady;
    // 重挂载前清干净：innerHTML 会换掉 DOM，但旧 tab 的 SSE 订阅与 xterm 实例不会自己消失
    for (const tab of tabs.values()) disposeTab(tab);
    tabs.clear();
    let sessions = [];
    if (fixedSessions) {
      // 沉浸接续等专用场景：只挂指定会话，不列全量台账、零会话时也不自起新 shell
      sessions = fixedSessions;
    } else {
      try {
        const payload = await request("/api/pty");
        // CLI 接续会话（kind:"cli"）只属于沉浸罩层——底部抽屉/终端视图保持纯项目 shell，
        // 不把 agent TUI 混进来（LO 2026-08-17：下侧栏终端只显示项目路径下的命令行）
        sessions = (payload?.sessions ?? []).filter((session) => session?.kind !== "cli");
      } catch (error) {
        if (error?.status === 501 || /REMOTE_GATE/.test(error?.message || "")) {
          gateCard(root, "pty", error.message);
          return;
        }
        // 带重试入口：竞态类故障重试即恢复，真实故障则由 message 指认，不让用户只看到一句空泛的异常
        root.innerHTML = `<div class="forge-empty-waveg">${lucideIcon("triangle-alert", "icon lucide icon-lg")}<h2>终端服务异常</h2><p class="subtle">${escapeHtml(String(error?.message ?? "未知错误"))}</p><button class="button secondary" type="button" data-terminal-retry>重试</button></div>`;
        root.querySelector("[data-terminal-retry]")?.addEventListener("click", () => void mount(), { once: true });
        return;
      }
    }
    root.innerHTML = `
      <div class="terminal-shell">
        <div class="terminal-tabs" role="tablist" aria-label="终端会话"></div>
        <div class="terminal-panes"></div>
      </div>`;
    renderTabStrip();
    const live = sessions.filter((session) => !session.exited);
    for (const session of live) attachSession(session);
    if (fixedSessions) return;
    if (live.length === 0) {
      await spawnTab();
      return;
    }
    const wanted = resolveWorkbenchPtySpawn();
    const samePath = (left, right) => String(left || "").replace(/[\\/]+$/, "").toLowerCase()
      === String(right || "").replace(/[\\/]+$/, "").toLowerCase();
    if (wanted.cwd && !live.some((session) => samePath(session.cwd, wanted.cwd))) {
      await spawnTab();
    } else if (wanted.ssh && !live.some((session) => session.title && session.title.includes(wanted.ssh.hostId))) {
      await spawnTab();
    }
  }

  /** 抽屉展开后由宿主调用：xterm 在隐藏容器里 focus 无效，必须等可见再聚焦。 */
  function focusActive() {
    const active = [...tabs.values()].find((tab) => tab.paneEl?.classList.contains("is-active")) ?? [...tabs.values()].at(-1);
    if (!active) return;
    requestAnimationFrame(() => {
      try {
        active.fit.fit();
        active.term.focus();
      } catch { /* 尺寸未就绪时忽略，下一次展开会再试 */ }
    });
  }

  // 迟到会话接入（「新会话 → 远程」创建的 SSH 终端）：面板已挂载就直接 attach 新页签；
  // 未挂载/门闸卡则忽略——mountOnce 本来就会全量列会话。attachSession 幂等，重复事件安全。
  // 通用面板跳过 CLI 接续会话（kind:"cli"）：它们是 agent TUI，只进沉浸罩层，不占纯 shell 面板。
  function onPtySessionCreated(event) {
    const session = event.detail?.session;
    if (!session?.id) return;
    if (!fixedSessions && session.kind === "cli") return;
    if (!root.querySelector(".terminal-panes")) return;
    attachSession(session);
  }
  window.addEventListener("forge:pty-session-created", onPtySessionCreated);

  /** 当前激活页签的 session id（罩层成员条同步选中态用）。 */
  function activeTabId() {
    for (const [id, tab] of tabs) if (tab.paneEl?.classList.contains("is-active")) return id;
    return null;
  }

  /** 宿主销毁时调用：断全局监听 + 全量释放 tab（SSE/xterm），root 移除后不残留订阅。 */
  function dispose() {
    window.removeEventListener("forge:pty-session-created", onPtySessionCreated);
    for (const tab of tabs.values()) disposeTab(tab);
    tabs.clear();
  }

  // attach/activate/close/activeTabId 暴露给沉浸罩层的成员页签条：成员切换 = 罩层自己驱动
  // 面板增删激活页签（罩层内面板自带页签条被 CSS 隐藏，成员条是唯一切换入口）
  return { mount, root, focusActive, dispose, attach: attachSession, activate: activateTab, close: closeTab, activeTabId };
}

/**
 * 会话 → 原生 CLI 沉浸接续（LO 2026-08-17：红框区域整体变终端，不要只开底部抽屉）：
 * 罩层覆盖整个 conversation-pane（对话流 + composer + 底部抽屉），与抽屉/终端视图共享
 * 同一 PTY 会话（tmux 式多挂，双向实时）。Esc / × 返回对话——只拆罩层视图，PTY 会话不死。
 * 单例：重复打开先收旧罩层再挂新会话。宿主缺失返回 false，调用方负责切视图后重试。
 *
 * 成员页签（同日 LO 追加）：members 是该 run 全部可接续成员（服务端 interactiveCliSpecsForRun），
 * 罩层头部渲染成员条——已起 PTY 的成员点击即切，未起的点击懒调 /cli-terminal 起进程。
 * 面板自带页签条在罩层内被 CSS 隐藏，成员条是唯一切换入口。
 */
let immersiveState = null; // { overlay, panel, onKeydown }

export function closeImmersiveTerminal() {
  if (!immersiveState) return;
  window.removeEventListener("keydown", immersiveState.onKeydown, true);
  if (immersiveState.pollTimer) window.clearInterval(immersiveState.pollTimer);
  immersiveState.panel.dispose();
  immersiveState.overlay.remove();
  immersiveState = null;
}

/** 协议徽标取短名：opencode-run-json → opencode，claude-code → claude。 */
function protoShort(protocol) {
  return String(protocol || "").split("-")[0] || "cli";
}

/** 成员色相按 agentId 稳定散列：同一成员每次开罩层都是同一个颜色。 */
function stableHue(text) {
  let hash = 0;
  for (const ch of String(text ?? "")) hash = (hash * 31 + (ch.codePointAt(0) || 0)) >>> 0;
  return hash % 360;
}

export function openImmersiveTerminal({ session, title = "", members = [], runId = null, activeAgentId = null } = {}) {
  if (!session?.id) return false;
  const host = document.querySelector("#view-bot.is-active .bot-conversation")
    || document.querySelector(".conversation-pane");
  if (!host) return false;
  closeImmersiveTerminal();
  const overlay = document.createElement("div");
  overlay.className = "cli-immersive";
  overlay.id = "cli-immersive";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "原生 CLI 终端");
  overlay.innerHTML = `
    <header class="cli-immersive-head">
      <span class="cli-immersive-title">${lucideIcon("terminal", "icon lucide")}<span>${escapeHtml(title || session.title || "CLI 终端")}</span></span>
      <span class="cli-run-status" data-run-status hidden></span>
      <span class="cli-immersive-hint">双击 Esc 返回 · 单 Esc 留给 CLI 自己 · Ctrl+Alt+PgUp/PgDn 切成员 · 收罩层不杀会话</span>
      <button class="icon-button cli-immersive-external" type="button" title="在系统终端打开（同一条原生会话；罩层内同名进程随后收掉，避免双写）" aria-label="在系统终端打开">${lucideIcon("external-link", "icon lucide")}</button>
      <button class="icon-button cli-immersive-close" type="button" title="返回对话（双击 Esc）" aria-label="返回对话">${lucideIcon("x", "icon lucide")}</button>
    </header>
    <div class="cli-member-strip" role="tablist" aria-label="团队成员 CLI 切换"></div>
    <div class="cli-immersive-body"></div>`;
  host.appendChild(overlay);
  // 冷启动桥接：新 PTY 缓冲是空的，opencode 装载大会话首屏要约 10s，且 TUI 起笔会清屏——
  // 提示必须活在罩层 DOM 里（不被 ANSI 重绘抹掉），首个非空输出块到达即撤。
  // 注意挂点是 overlay 而非 .cli-immersive-body：createTerminalPanel mount 时会重写
  // body 的 innerHTML，挂在 body 里的 chip 会被立刻抹掉（overlay 自身 DOM 无人重写）。
  const bootChip = document.createElement("div");
  bootChip.className = "cli-immersive-boot";
  bootChip.textContent = "正在启动原生 CLI 并装载会话上下文（约 8–10 秒）…";
  overlay.appendChild(bootChip);
  let bootToken = 0;
  const showBoot = (text, { sticky = false } = {}) => {
    const token = ++bootToken;
    if (text) bootChip.textContent = text;
    if (!bootChip.isConnected) overlay.appendChild(bootChip);
    if (!sticky) {
      // 失败提示 8s 后自动撤：错误不会自己变成输出块，等 onFirstChunk 是等不到的
      window.setTimeout(() => {
        if (bootToken === token && bootChip.isConnected) bootChip.remove();
      }, 8000);
    }
  };
  const pruneMemberTab = (ptySessionId) => {
    let pruned = false;
    for (const [agentId, id] of memberTabs) {
      if (id === ptySessionId) {
        memberTabs.delete(agentId);
        pruned = true;
      }
    }
    if (pruned) renderMemberStrip();
  };
  const panel = createTerminalPanel(overlay.querySelector(".cli-immersive-body"), {
    fixedSessions: [session],
    allowSpawn: false,
    onAllClosed: () => closeImmersiveTerminal(),
    onFirstChunk: () => bootChip.remove(),
    // CLI 进程退出/页签被关：成员条映射同步还原为"未启动"，再点即重新接续，不留僵尸 chip
    onSessionExited: (ptySessionId) => pruneMemberTab(ptySessionId),
    onTabClosed: (ptySessionId) => pruneMemberTab(ptySessionId),
  });

  // ── 成员页签条：agentId → 在罩层里的 PTY 会话 id；未启动的成员没有映射 ──
  const memberList = Array.isArray(members) ? [...members] : [];
  if (activeAgentId && !memberList.some((member) => member?.agentId === activeAgentId)) {
    memberList.unshift({ agentId: activeAgentId, label: "", protocol: "" });
  }
  const memberTabs = new Map();
  if (activeAgentId) memberTabs.set(activeAgentId, session.id);
  const strip = overlay.querySelector(".cli-member-strip");
  const overlayAlive = () => immersiveState && immersiveState.overlay === overlay;

  async function spawnMemberCli(member) {
    if (!runId || !overlayAlive()) return;
    const label = member.label || member.agentId;
    // 启动提示粘性：慢 CLI（opencode 大会话装载 ~10s）靠首个输出块撤，不按 8s 定时撤
    showBoot(`正在启动 ${label} 的原生 CLI 并装载会话上下文（约 8–10 秒）…`, { sticky: true });
    try {
      const result = await request(`/api/runs/${encodeURIComponent(runId)}/cli-terminal`, {
        method: "POST",
        // 严格模式：点名要哪个成员就是哪个，落空如实报错——不静默回落到别人的会话
        body: JSON.stringify({ agentId: member.agentId, strict: true }),
      });
      if (!overlayAlive()) return; // 等待期间罩层已被收起，静默丢弃
      if (!result?.session?.id) throw new Error("服务端未返回会话");
      memberTabs.set(member.agentId, result.session.id);
      panel.attach(result.session); // attach 内部自动激活新页签
      renderMemberStrip();
    } catch (error) {
      if (!overlayAlive()) return;
      showBoot(`打开 ${label} 失败：${String(error?.message ?? error).replace(/[\r\n]+/g, " ")}`);
    }
  }

  function renderMemberStrip() {
    if (!strip.isConnected) return;
    strip.innerHTML = "";
    const activeId = panel.activeTabId();
    for (const member of memberList) {
      const agentId = member.agentId;
      const ptyId = memberTabs.get(agentId);
      const live = Boolean(ptyId);
      const active = live && ptyId === activeId;
      if (active) {
        // 记住这条会话上次在罩层里看的是谁：重开罩层（dedupe 接回）时恢复焦点成员
        try { sessionStorage.setItem(`514cc:cli-active:${runId || ""}`, agentId); } catch { /* storage 可能被禁 */ }
        overlay.dataset.activeAgent = agentId;
      }
      const label = member.label || agentId;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `cli-member-chip${live ? " is-live" : ""}${active ? " is-active" : ""}`;
      chip.setAttribute("role", "tab");
      chip.setAttribute("aria-selected", active ? "true" : "false");
      chip.title = live ? `${label} · 已接续（点击切换，× 关闭该 CLI 进程）` : `${label} · 点击启动原生 CLI（与会话共享同一原生会话）`;
      chip.style.setProperty("--chip-hue", String(stableHue(agentId))); // CSSOM 路径，不落内联 style 属性
      chip.innerHTML = `
        <span class="cli-member-dot" aria-hidden="true"></span>
        <span class="cli-member-name">${escapeHtml(label)}</span>
        <span class="cli-member-proto">${escapeHtml(protoShort(member.protocol))}</span>`;
      chip.addEventListener("click", () => {
        const tabId = memberTabs.get(agentId);
        if (tabId) {
          panel.activate(tabId);
          renderMemberStrip();
        } else {
          void spawnMemberCli(member);
        }
      });
      if (live) {
        const close = document.createElement("span");
        close.className = "cli-member-close";
        close.setAttribute("aria-label", `关闭 ${label} 的 CLI`);
        close.innerHTML = lucideIcon("x", "icon lucide");
        close.addEventListener("click", (event) => {
          event.stopPropagation();
          memberTabs.delete(agentId);
          // close 是异步（先 DELETE 再激活剩余页签），完成后再重绘一次同步 is-active
          void panel.close(ptyId).then(() => renderMemberStrip());
          renderMemberStrip();
        });
        chip.appendChild(close);
      }
      strip.appendChild(chip);
    }
  }

  // 双击 Esc 才收罩层（600ms 窗口）：opencode/claude 原生 TUI 自己用单 Esc 打断当前轮，
  // 单按必须原样透传给终端；捕获相监听只是为了能抢在 xterm 之前识别双击。
  let lastEscAt = 0;
  const onKeydown = (event) => {
    // Ctrl+Alt+PgUp/PgDn：在已接续的成员页签间循环切换（gnome-terminal 同款）。
    // 只在 is-live 页签间走——键盘漫游不该背后替用户懒起新进程。
    if (event.ctrlKey && event.altKey && !event.shiftKey && (event.key === "PageDown" || event.key === "PageUp")) {
      const liveIds = memberList.map((member) => memberTabs.get(member.agentId)).filter(Boolean);
      if (liveIds.length < 2) return; // 少于两页无可循环，按键照常透传给终端
      event.preventDefault();
      event.stopPropagation();
      const current = panel.activeTabId();
      const index = liveIds.indexOf(current);
      const step = event.key === "PageDown" ? 1 : -1;
      const next = liveIds[(index + step + liveIds.length) % liveIds.length] ?? liveIds[0];
      panel.activate(next);
      renderMemberStrip();
      return;
    }
    if (event.key !== "Escape") return;
    const now = Date.now();
    if (now - lastEscAt >= 600) {
      lastEscAt = now;
      return; // 单按：不拦截，透传给终端
    }
    lastEscAt = 0;
    event.preventDefault();
    event.stopPropagation();
    closeImmersiveTerminal();
  };
  window.addEventListener("keydown", onKeydown, true);
  overlay.querySelector(".cli-immersive-close").addEventListener("click", () => closeImmersiveTerminal());

  // ── 控制台轮次状态徽标：罩层里也看得见"控制台那边的轮次在不在跑"（5s 轮询，罩层收起即停）。
  // 用户在 CLI 里输入前看一眼，避免与控制台在途轮次交错写同一份原生会话。──
  const statusBadge = overlay.querySelector("[data-run-status]");
  const RUN_STATUS_META = {
    running: { text: "控制台轮次进行中", tone: "is-busy", title: "控制台正在对该会话跑一轮；此时在终端里继续可能交错，建议等本轮结束或先停止" },
    waiting_agent: { text: "等待你在控制台回应", tone: "is-wait", title: "成员在控制台发起了提问（pending ask），回控制台回应或直接在 CLI 里聊都行" },
    waiting_approval: { text: "等待控制台审批", tone: "is-wait", title: "build 轮在等动作审批，回控制台处理" },
    recovery_required: { text: "待恢复确认", tone: "is-wait", title: "上一轮提交状态不明，回控制台确认恢复" },
  };
  let pollTimer = 0;
  const syncRunStatus = async () => {
    if (!overlayAlive() || !runId) return;
    try {
      const run = await request(`/api/runs/${encodeURIComponent(runId)}`);
      if (!overlayAlive()) return;
      // 未具名的活跃态（queued/executing/planning/…）同样算"轮次在途"——
      // 兜底成"空闲"会恰好在最该提醒的时候误导用户往终端里打字
      const meta = RUN_STATUS_META[run?.status]
        ?? (ACTIVE_RUN_STATES.has(run?.status) ? RUN_STATUS_META.running : null)
        ?? { text: "控制台空闲", tone: "is-idle", title: "控制台侧没有在途轮次，终端里随便聊" };
      statusBadge.textContent = meta.text;
      statusBadge.title = meta.title;
      statusBadge.className = `cli-run-status ${meta.tone}`;
      statusBadge.hidden = false;
    } catch { /* 轮询失败保持上一状态，下一轮再试 */ }
  };
  if (runId && statusBadge) {
    void syncRunStatus();
    pollTimer = window.setInterval(() => void syncRunStatus(), 5000);
  }

  // ── 在系统终端打开：同一条原生会话、同一份 resume 命令，宿主从罩层换成真终端窗口。
  // 迁移语义而非分身：两个 CLI 进程同时写同一份原生 session 文件就是 dedupe 要灭掉的争抢，
  // 所以外部窗口起成功后，罩层内同成员的在途 PTY 收掉（关的是最后一页时罩层随之收起）。──
  overlay.querySelector(".cli-immersive-external")?.addEventListener("click", async () => {
    if (!runId) {
      showBoot("缺少会话上下文，无法打开系统终端");
      return;
    }
    const agentId = overlay.dataset.activeAgent || activeAgentId || "";
    const label = memberList.find((member) => member.agentId === agentId)?.label || agentId || "当前成员";
    showBoot("正在请求系统终端…", { sticky: true });
    try {
      const result = await request(`/api/runs/${encodeURIComponent(runId)}/cli-terminal`, {
        method: "POST",
        body: JSON.stringify({ agentId: agentId || undefined, strict: true, external: true }),
      });
      if (!overlayAlive()) return;
      showBoot(result?.spec ? `已在系统终端打开：${result.spec.command}` : "已在系统终端打开");
      // 外部窗口已起：收掉罩层内同成员 PTY，同一份原生会话不交双写
      const livePty = agentId ? memberTabs.get(agentId) : null;
      if (livePty) {
        memberTabs.delete(agentId);
        await panel.close(livePty).catch(() => {}); // 最后一页会触发 onAllClosed 收罩层
        if (overlayAlive()) renderMemberStrip();
      }
    } catch (error) {
      if (!overlayAlive()) return;
      showBoot(`系统终端打开失败：${String(error?.message ?? error).replace(/[\r\n]+/g, " ")}`);
    }
  });

  immersiveState = { overlay, panel, onKeydown, pollTimer };
  renderMemberStrip();
  // mount 完成（首个会话 attach + 激活）后重绘一次成员条，补上 is-active 选中态
  void panel.mount().then(() => renderMemberStrip());
  return true;
}

window.addEventListener("forge:cli-immersive-open", (event) => {
  openImmersiveTerminal(event.detail ?? {});
});
window.addEventListener("forge:cli-immersive-close", () => closeImmersiveTerminal());

function bootWhenReady() {
  if (typeof document === "undefined") return;
  const start = () => {
    const root = document.getElementById("terminal-container");
    if (!root) return;
    // 终端视图必须等真正可见才挂载。此前是页面一加载就 mount：用户从没打开过终端视图，
    // 也会白起一个 pwsh（还要加载 profile 一秒多），并且底部抽屉随后会 attach 同一会话，
    // 于是同一个 PTY 上挂了两条 SSE、各重放一次缓冲——就是「打开终端有很多条」的来源。
    // 协作台底部抽屉由 workbench-chrome.js 自己懒挂载，两边都不提前占 PTY 会话。
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void apiReady.then(() => createTerminalPanel(root).mount());
    });
    observer.observe(root);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

bootWhenReady();
