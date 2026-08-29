/**
 * hero-starmap.js — 协作星图（挂在团队编排面，不再是独立观测页）。
 *
 * 节点 = 当前团队席位（不是写死的 6 个 CLI 家族）。
 * 亮点 = 该席位 busy；连线 = 本队 TaskGraph delegations。
 * 物理：库仑斥力 + 环形锚点 + 指针井；主题 token；reduced-motion 停 raf。
 */
const BRAND_COLORS = Object.freeze({
  claude: { var: "--agent-claude", fallback: "#d97757" },
  codex: { var: "--agent-codex", fallback: "#7a9dff" },
  grok: { var: "--agent-grok", fallback: "#a78bfa" },
  kimi: { var: "--agent-kimi", fallback: "#eab308" },
  pi: { var: "--agent-pi", fallback: "#2dd4bf" },
  gemini: { var: "--agent-cursor", fallback: "#9ca3af" },
  cursor: { var: "--agent-cursor", fallback: "#9ca3af" },
  other: { var: "--muted-foreground", fallback: "#78716c" },
});

const BRAND_GLYPH = Object.freeze({
  claude: "主",
  codex: "烛",
  grok: "织",
  kimi: "前",
  pi: "驻",
  gemini: "研",
  cursor: "研",
});

const STATUS_LABEL = Object.freeze({
  busy: "执行中",
  ready: "待命",
  degraded: "降级",
  offline: "离线",
  unknown: "未核验",
});

const mounted = new WeakMap();

export function memberGlyph(agent) {
  const name = String(agent?.name || "").trim();
  if (/^[\u4e00-\u9fff]/.test(name)) return name[0];
  return BRAND_GLYPH[agent?.brand] || name.slice(0, 1) || "?";
}

export function activityFromPanel(panel) {
  const agents = Array.isArray(panel?.agents) ? panel.agents : [];
  const members = agents.map((agent) => {
    const status = STATUS_LABEL[agent.status] ? agent.status : "unknown";
    return {
      id: String(agent.id || ""),
      label: String(agent.name || agent.id || "席位"),
      glyph: memberGlyph(agent),
      brand: agent.brand || "other",
      role: String(agent.role || agent.title || "运行席"),
      title: String(agent.title || ""),
      status,
      active: status === "busy",
      coordinator: agent.id === panel.coordinatorId || agent.layer === "leader",
      currentTask: agent.currentTask ? String(agent.currentTask) : null,
    };
  }).filter((member) => member.id);
  const edges = new Set();
  for (const flow of panel?.flows ?? []) {
    const from = String(flow?.from || "");
    const to = String(flow?.to || "");
    if (!from || !to || from === to) continue;
    edges.add([from, to].sort().join("~"));
  }
  return {
    teamName: String(panel?.teamName || "未选择团队"),
    coordinatorId: panel?.coordinatorId || null,
    members,
    edges,
  };
}

function readTokens() {
  const style = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  return {
    primary: pick("--primary", "#d97757"),
    foreground: pick("--foreground", "#1c1917"),
    muted: pick("--muted-foreground", "#78716c"),
    background: pick("--background", "#ffffff"),
    colorFor(brand) {
      const spec = BRAND_COLORS[brand] || BRAND_COLORS.other;
      return pick(spec.var, spec.fallback);
    },
  };
}

function nodeRadius(count, coordinator) {
  const base = count > 8 ? 18 : count > 5 ? 21 : 24;
  return coordinator ? base + 4 : base;
}

function createEngine(canvas, overlay, { onSelect } = {}) {
  const ctx = canvas.getContext("2d", { alpha: true });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let tokens = readTokens();
  let width = 0;
  let height = 0;
  let raf = 0;
  let running = false;
  let activity = { edges: new Set() };
  const pointer = { x: -9999, y: -9999, inside: false };
  let nodes = [];

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    width = Math.max(240, rect.width);
    height = Math.max(200, rect.height);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (reduced) draw(0);
  }

  function anchors() {
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) * 0.30;
    return nodes.map((node) => ({
      x: cx + Math.cos(node.anchorT) * radius * 1.28,
      y: cy + Math.sin(node.anchorT) * radius * 0.78,
    }));
  }

  function snapToAnchors() {
    const points = anchors();
    nodes.forEach((node, index) => {
      node.x = points[index].x;
      node.y = points[index].y;
      node.vx = 0;
      node.vy = 0;
    });
  }

  function rebuildNodes(members) {
    const prev = new Map(nodes.map((node) => [node.id, node]));
    nodes = members.map((member, index) => {
      const existing = prev.get(member.id);
      const angle = (index / Math.max(members.length, 1)) * Math.PI * 2 - Math.PI / 2;
      return {
        ...member,
        index,
        angle,
        anchorT: existing?.anchorT ?? angle,
        x: existing?.x ?? 0,
        y: existing?.y ?? 0,
        vx: existing?.vx ?? 0,
        vy: existing?.vy ?? 0,
        r: nodeRadius(members.length, member.coordinator),
        hover: existing?.hover ?? 0,
        seed: index * 137.51,
      };
    });
    if (width && height) snapToAnchors();
  }

  function step(time) {
    const anchorPoints = anchors();
    for (const node of nodes) {
      node.anchorT += 0.000016 * (1 + node.index * 0.12);
      const anchor = anchorPoints[node.index];
      node.vx += (anchor.x - node.x) * 0.0022;
      node.vy += (anchor.y - node.y) * 0.0022;
      for (const other of nodes) {
        if (other === node) continue;
        const dx = node.x - other.x;
        const dy = node.y - other.y;
        const distSq = Math.max(900, dx * dx + dy * dy);
        const force = 2600 / distSq;
        const dist = Math.sqrt(distSq);
        node.vx += (dx / dist) * force;
        node.vy += (dy / dist) * force;
      }
      if (pointer.inside) {
        const dx = pointer.x - node.x;
        const dy = pointer.y - node.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < 200 * 200 && distSq > 400) {
          const dist = Math.sqrt(distSq);
          const pull = 0.028 * (1 - dist / 200);
          node.vx += (dx / dist) * pull * dist * 0.05;
          node.vy += (dy / dist) * pull * dist * 0.05;
        }
      }
      node.vx += Math.sin(time * 0.00021 + node.seed) * 0.006;
      node.vy += Math.cos(time * 0.00017 + node.seed * 1.3) * 0.006;
      node.vx *= 0.94;
      node.vy *= 0.94;
      node.x += node.vx;
      node.y += node.vy;
      const hovering = pointer.inside
        && Math.hypot(pointer.x - node.x, pointer.y - node.y) < node.r + 14;
      node.hover += ((hovering ? 1 : 0) - node.hover) * 0.14;
    }
  }

  function drawEdge(a, b, time, active) {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const cx = width / 2;
    const cy = height / 2;
    const bend = 0.12;
    const qx = mx + (mx - cx) * bend;
    const qy = my + (my - cy) * bend;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(qx, qy, b.x, b.y);
    ctx.strokeStyle = active ? tokens.primary : tokens.muted;
    ctx.globalAlpha = active ? 0.38 : 0.08;
    ctx.lineWidth = active ? 1.4 : 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (active && !reduced) {
      for (let k = 0; k < 2; k += 1) {
        const t = ((time * 0.00022 + k * 0.5 + a.index * 0.13) % 1);
        const inv = 1 - t;
        const px = inv * inv * a.x + 2 * inv * t * qx + t * t * b.x;
        const py = inv * inv * a.y + 2 * inv * t * qy + t * t * b.y;
        ctx.beginPath();
        ctx.arc(px, py, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = tokens.primary;
        ctx.globalAlpha = 0.85 * Math.sin(t * Math.PI);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawCore(time) {
    const cx = width / 2;
    const cy = height / 2;
    for (let i = 0; i < 3; i += 1) {
      const phase = reduced ? 0.3 + i * 0.2 : ((time * 0.00035 + i / 3) % 1);
      const radius = 10 + phase * 64;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.strokeStyle = tokens.primary;
      ctx.globalAlpha = 0.20 * (1 - phase);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, 18);
    gradient.addColorStop(0, tokens.primary);
    gradient.addColorStop(1, "transparent");
    ctx.beginPath();
    ctx.arc(cx, cy, 18, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.globalAlpha = 0.5;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fillStyle = tokens.primary;
    ctx.fill();
  }

  function drawNode(node, time) {
    const color = tokens.colorFor(node.brand);
    const scale = 1 + node.hover * 0.28 + (node.active ? 0.06 : 0);
    const radius = node.r * scale;
    const glow = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, radius * 2.4);
    glow.addColorStop(0, color);
    glow.addColorStop(1, "transparent");
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius * 2.4, 0, Math.PI * 2);
    ctx.fillStyle = glow;
    ctx.globalAlpha = (node.active ? 0.22 : 0.10) + node.hover * 0.16;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (node.coordinator) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius + 5, 0, Math.PI * 2);
      ctx.strokeStyle = tokens.primary;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (node.active && !reduced) {
      ctx.save();
      ctx.translate(node.x, node.y);
      ctx.rotate(time * 0.0004 + node.seed);
      ctx.beginPath();
      ctx.setLineDash([3, 7]);
      ctx.arc(0, 0, radius + 7, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = tokens.background;
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.font = `600 ${Math.round(radius * 0.86)}px "Songti SC", "Noto Serif SC", "SimSun", serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(node.glyph, node.x, node.y + 1);
    ctx.fillStyle = tokens.muted;
    ctx.font = '500 11px system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(node.label, node.x, node.y + radius + 16);
    if (node.active) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x + radius * 0.72, node.y - radius * 0.72, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function draw(time) {
    ctx.clearRect(0, 0, width, height);
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const key = [nodes[i].id, nodes[j].id].sort().join("~");
        if (!activity.edges.has(key)) drawEdge(nodes[i], nodes[j], time, false);
      }
    }
    for (const key of activity.edges) {
      const [aId, bId] = key.split("~");
      const a = nodes.find((node) => node.id === aId);
      const b = nodes.find((node) => node.id === bId);
      if (a && b) drawEdge(a, b, time, true);
    }
    drawCore(time);
    for (const node of nodes) drawNode(node, time);
    syncOverlay();
  }

  function hoveredNode() {
    return nodes.find((node) => node.hover > 0.5) || null;
  }

  function syncOverlay() {
    if (!overlay) return;
    const hovered = hoveredNode();
    if (!hovered) {
      overlay.classList.remove("is-visible");
      overlay.textContent = "";
      return;
    }
    const status = STATUS_LABEL[hovered.status] || STATUS_LABEL.unknown;
    const lead = hovered.coordinator ? "主脑" : hovered.role;
    overlay.textContent = hovered.currentTask
      ? `${hovered.label} · ${lead} · ${status} · ${hovered.currentTask}`
      : `${hovered.label} · ${lead} · ${status}`;
    overlay.style.setProperty("--hero-tip-x", `${hovered.x}px`);
    overlay.style.setProperty("--hero-tip-y", `${hovered.y - hovered.r - 14}px`);
    overlay.classList.add("is-visible");
  }

  function frame(time) {
    if (!running) return;
    step(time);
    draw(time);
    raf = requestAnimationFrame(frame);
  }

  function start() {
    resize();
    snapToAnchors();
    resume();
  }

  function resume() {
    if (reduced || running) {
      if (reduced) draw(0);
      return;
    }
    running = true;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  function setFromPanel(panel) {
    const next = activityFromPanel(panel);
    const same = nodes.length === next.members.length
      && nodes.every((node, index) => node.id === next.members[index].id);
    if (!same) rebuildNodes(next.members);
    else {
      next.members.forEach((member, index) => {
        Object.assign(nodes[index], member, { r: nodeRadius(next.members.length, member.coordinator) });
      });
    }
    activity = { edges: next.edges };
    canvas.setAttribute("aria-label", `${next.teamName} 协作星图，${next.members.length} 个席位`);
    if (reduced) draw(0);
    return next;
  }

  function retokenize() {
    tokens = readTokens();
    if (reduced) draw(0);
  }

  // 背景画布全程承接指针移动：passive 避免每帧滚动阻塞主线程（处理器不依赖 preventDefault）
  canvas.addEventListener("pointermove", (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = event.clientX - rect.left;
    pointer.y = event.clientY - rect.top;
    pointer.inside = true;
  }, { passive: true });
  canvas.addEventListener("pointerleave", () => {
    pointer.inside = false;
    pointer.x = -9999;
    pointer.y = -9999;
  });
  canvas.addEventListener("click", () => {
    const hovered = hoveredNode();
    if (hovered) onSelect?.(hovered.id);
  });

  const observer = new ResizeObserver(() => resize());
  observer.observe(canvas.parentElement);

  return {
    start,
    stop,
    resume,
    setFromPanel,
    retokenize,
    resize,
    disconnect() {
      stop();
      observer.disconnect();
    },
  };
}

function syncChrome(root, meta) {
  const latin = root.querySelector(".hero-type-latin");
  const countNum = root.querySelector(".hero-count-num");
  const countLabel = root.querySelector(".hero-count-label");
  if (latin) latin.textContent = meta.teamName || "TEAM";
  if (countNum) countNum.textContent = String(meta.members.length);
  if (countLabel) countLabel.textContent = meta.members.length ? "TEAM SEATS" : "NO TEAM";
}

function highlightRoster(memberId) {
  document.querySelectorAll("#team-roster-root .tp-card.is-starmap-hot").forEach((card) => {
    card.classList.remove("is-starmap-hot");
  });
  const card = document.querySelector(`#team-roster-root [data-agent="${CSS.escape(memberId)}"]`);
  if (!card) return;
  card.classList.add("is-starmap-hot");
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  window.setTimeout(() => card.classList.remove("is-starmap-hot"), 1600);
  document.dispatchEvent(new CustomEvent("forge:starmap-select-member", { detail: { id: memberId } }));
}

export function mountTeamStarmap(root) {
  if (!root) return null;
  const existing = mounted.get(root);
  if (existing) return existing;

  root.innerHTML = `
    <div class="hero-stage">
      <canvas class="hero-canvas" aria-label="协作星图" role="img"></canvas>
      <div class="hero-tip" aria-hidden="true"></div>
      <div class="hero-type" aria-hidden="true">
        <span class="hero-type-vertical">协作星图</span>
        <span class="hero-type-latin">TEAM</span>
      </div>
      <div class="hero-count" aria-hidden="true">
        <span class="hero-count-num">0</span>
        <span class="hero-count-label">TEAM SEATS</span>
      </div>
    </div>`;

  const canvas = root.querySelector(".hero-canvas");
  const overlay = root.querySelector(".hero-tip");
  const engine = createEngine(canvas, overlay, { onSelect: highlightRoster });
  engine.start();

  const themeObserver = new MutationObserver(() => engine.retokenize());
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  const visibility = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) engine.resume();
    else engine.stop();
  }, { threshold: 0.08 });
  visibility.observe(root);

  const controller = {
    setFromPanel(panel) {
      const meta = engine.setFromPanel(panel);
      syncChrome(root, meta);
      return meta;
    },
    destroy() {
      visibility.disconnect();
      themeObserver.disconnect();
      engine.disconnect();
      mounted.delete(root);
    },
  };
  mounted.set(root, controller);
  return controller;
}
