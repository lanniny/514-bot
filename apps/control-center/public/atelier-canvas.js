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
    // 514 Forge Awwwards 级活体编排场：赤陶铜橙与深墨折射
    return dark
      ? {
          particle: "rgba(237, 155, 120, 0.38)",
          particleGlow: "rgba(217, 119, 87, 0.65)",
          lineNear: "rgba(237, 155, 120, 0.16)",
          lineFar: "rgba(237, 155, 120, 0.02)",
          spotCore: "rgba(217, 119, 87, 0.08)",
          spotRing: "rgba(90, 140, 220, 0.04)"
        }
      : {
          particle: "rgba(184, 92, 62, 0.32)",
          particleGlow: "rgba(217, 119, 87, 0.55)",
          lineNear: "rgba(184, 92, 62, 0.12)",
          lineFar: "rgba(87, 70, 58, 0.015)",
          spotCore: "rgba(217, 119, 87, 0.065)",
          spotRing: "rgba(6, 117, 98, 0.025)"
        };
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
    // 弹性平滑缓动追随光标
    pointer.x += (pointer.tx - pointer.x) * 0.045;
    pointer.y += (pointer.ty - pointer.y) * 0.045;

    ctx.clearRect(0, 0, w, h);
    const ink = themeInk();
    const px = pointer.x * w;
    const py = pointer.y * h;

    // 双环多层微光晕（Dual-tier atmospheric ambient spotlight）
    const spotRadius = Math.max(w, h) * 0.38;
    const g = ctx.createRadialGradient(px, py, 0, px, py, spotRadius);
    g.addColorStop(0, ink.spotCore);
    g.addColorStop(0.35, ink.spotRing);
    g.addColorStop(0.8, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const pts = [];
    for (const p of particles) {
      p.x += p.vx + Math.sin(t * 0.00035 + p.phase) * 0.000045;
      p.y += p.vy + Math.cos(t * 0.0003 + p.phase) * 0.000045;
      if (p.x < -0.05) p.x = 1.05;
      if (p.x > 1.05) p.x = -0.05;
      if (p.y < -0.05) p.y = 1.05;
      if (p.y > 1.05) p.y = -0.05;

      // 柔和天体引力透镜偏转（Celestial gravity lens toward pointer）
      const dx = pointer.x - p.x;
      const dy = pointer.y - p.y;
      const dist = Math.hypot(dx, dy) || 1;
      if (dist < 0.32) {
        const pull = (1 - dist / 0.32) * 0.0009;
        p.x += dx * pull;
        p.y += dy * pull;
      }
      pts.push({ x: p.x * w, y: p.y * h, r: p.r, isNear: dist < 0.18 });
    }

    // 星轨拓扑微连线
    ctx.lineWidth = 0.85;
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        const a = pts[i];
        const b = pts[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < 135) {
          const alphaRatio = 1 - d / 135;
          ctx.strokeStyle = a.isNear || b.isNear ? ink.lineNear : ink.lineFar;
          ctx.globalAlpha = alphaRatio * 0.65;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    // 粒子节点绘制（近光晕节点附带微呼吸光环）
    ctx.globalAlpha = 1;
    for (const p of pts) {
      if (p.isNear) {
        ctx.fillStyle = ink.particleGlow;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = ink.particle;
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
