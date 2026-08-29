/**
 * 514 Forge Atelier Canvas — pointer-reactive light field + soft particle constellation.
 * Pure visual layer; never blocks input (pointer-events: none on host).
 */
(function () {
  const canvas = document.getElementById("atelier-canvas");
  if (!canvas || !canvas.getContext) return;

  const ctx = canvas.getContext("2d", { alpha: true });
  // DPR 每次 resize 现取：跨屏拖动/浏览器缩放后画布位图才不会停留旧缩放（模糊/错密度）
  const currentDpr = () => Math.min(window.devicePixelRatio || 1, 2);
  let w = 0;
  let h = 0;
  let raf = 0;
  let pointer = { x: 0.5, y: 0.35, tx: 0.5, ty: 0.35 };
  let reduced = false;
  let visible = !document.hidden;
  let motionQuery = null;

  try {
    motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduced = motionQuery.matches;
  } catch {
    /* ignore */
  }

  const particles = Array.from({ length: 22 }, (_, i) => ({
    x: Math.random(),
    y: Math.random(),
    r: 0.4 + Math.random() * 1.6,
    vx: (Math.random() - 0.5) * 0.00035,
    vy: (Math.random() - 0.5) * 0.00035,
    phase: Math.random() * Math.PI * 2,
    seed: i,
  }));

  function resize() {
    w = window.innerWidth;
    h = window.innerHeight;
    const dpr = currentDpr();
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function themeInk() {
    const dark = document.documentElement.dataset.theme === "dark";
    // 514 Forge 活体编排场：铜橙代表运行中的意图流，深墨承载静态结构。
    return dark
      ? { particle: "rgba(237, 155, 120, 0.28)", line: "rgba(237, 155, 120, 0.075)", glow: "rgba(217, 119, 87, 0.075)" }
      : { particle: "rgba(184, 92, 62, 0.24)", line: "rgba(87, 70, 58, 0.055)", glow: "rgba(217, 119, 87, 0.065)" };
  }

  function botSurfaceActive() {
    return document.documentElement.classList.contains("is-bot-surface");
  }

  function frame(t) {
    raf = 0;
    if (!visible || reduced || botSurfaceActive()) {
      if (botSurfaceActive()) ctx.clearRect(0, 0, w, h);
      return;
    }
    raf = requestAnimationFrame(frame);
    pointer.x += (pointer.tx - pointer.x) * 0.06;
    pointer.y += (pointer.ty - pointer.y) * 0.06;

    ctx.clearRect(0, 0, w, h);
    const ink = themeInk();
    const px = pointer.x * w;
    const py = pointer.y * h;

    // soft spotlight following pointer
    const g = ctx.createRadialGradient(px, py, 0, px, py, Math.max(w, h) * 0.42);
    g.addColorStop(0, ink.glow);
    g.addColorStop(0.45, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const pts = [];
    for (const p of particles) {
      p.x += p.vx + Math.sin(t * 0.0004 + p.phase) * 0.00005;
      p.y += p.vy + Math.cos(t * 0.00035 + p.phase) * 0.00005;
      if (p.x < -0.05) p.x = 1.05;
      if (p.x > 1.05) p.x = -0.05;
      if (p.y < -0.05) p.y = 1.05;
      if (p.y > 1.05) p.y = -0.05;
      // mild attraction to pointer
      const dx = pointer.x - p.x;
      const dy = pointer.y - p.y;
      const dist = Math.hypot(dx, dy) || 1;
      if (dist < 0.35) {
        p.x += dx * 0.0008;
        p.y += dy * 0.0008;
      }
      pts.push({ x: p.x * w, y: p.y * h, r: p.r });
    }

    ctx.lineWidth = 1;
    ctx.strokeStyle = ink.line;
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        const a = pts[i];
        const b = pts[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < 140) {
          ctx.globalAlpha = (1 - d / 140) * 0.55;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = ink.particle;
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function onMove(event) {
    pointer.tx = event.clientX / Math.max(1, w);
    pointer.ty = event.clientY / Math.max(1, h);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    ctx.clearRect(0, 0, w, h);
  }

  function start() {
    if (visible && !reduced && !botSurfaceActive() && !raf) raf = requestAnimationFrame(frame);
  }

  function onVisibilityChange() {
    visible = !document.hidden;
    if (visible) start();
    else stop();
  }

  function onMotionChange(event) {
    reduced = Boolean(event.matches);
    if (reduced) stop();
    else start();
  }

  resize();
  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("pointermove", onMove, { passive: true });
  document.addEventListener("visibilitychange", onVisibilityChange);
  motionQuery?.addEventListener?.("change", onMotionChange);
  start();

  window.addEventListener("beforeunload", () => {
    stop();
    window.removeEventListener("resize", resize);
    window.removeEventListener("pointermove", onMove);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    motionQuery?.removeEventListener?.("change", onMotionChange);
  }, { once: true });
})();
