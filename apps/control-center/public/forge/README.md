# 514 Forge — v4.0 design system

Vanilla-CSS design layer for the control-center SPA. No build step, no CDN,
no new dependencies. Load order (after `styles.css` / `atelier.css`):

1. `forge/tokens.css` — OKLCH design tokens
2. `forge/motion.css` — durations, easings, keyframes, motion utilities
3. `forge/primitives.css` — restyle of existing generic controls + new primitives

Equal-specificity rule: forge CSS loads last, so redeclaring the same selector
wins the cascade. Avoid `!important` except inside utilities and the
`prefers-reduced-motion` blocks.

## Tokens (`tokens.css`)

Light lives on `:root`, dark overrides on `[data-theme="dark"]`.

- Core: `--background --foreground --card --card-foreground --muted --muted-foreground --border --input --ring`
- Primary (Claude humanist copper `#D97757`, OKLCH-derived): `--primary --primary-foreground --primary-hover --primary-soft`
- Semantic (+ `-soft` variant each): `--success --warning --danger --info`
- Agent brand: `--agent-claude --agent-codex --agent-grok --agent-kimi --agent-pi --agent-cursor`
- Radius: `--radius` (10px base), `--radius-sm/md/lg/xl/2xl/3xl/4xl` = 6/8/10/14/18/22/26px
- Elevation: `--shadow-sm/md/lg/xl/2xl`
- Type: `--text-xs/sm/base/lg/xl/2xl/3xl` = 11/12.5/14/16/20/24/30px;
  headings use `font-weight:600; letter-spacing:-0.02em` (see `.forge-h1/h2/h3`)
- z-index: `--z-base/raised/dropdown/sticky/overlay/drawer/modal/toast/palette/tooltip`

Utilities: `.num` (tabular-nums — use for every metric/timestamp/counter).

## Motion (`motion.css`)

- Durations `--dur-fast/med/slow/slower` = 100/150/240/300ms; easings `--ease-out`, `--ease-spring`.
- `.forge-enter` — fade + zoom-95 entrance, 100ms.
- `.forge-shimmer` — gradient text sweep (text only, uses `bg-clip:text`).
- `.forge-press` — 1px dip on `:active`.
- `.forge-pulse-dot` — status dot pulse.
- `.forge-conic-spin` — conic-gradient loader ring (`@property --forge-angle`; static fallback).
- `.forge-spin` — transform spinner (e.g. on the `loader-circle` icon).

Everything is disabled under `prefers-reduced-motion: reduce`. Any new
animation you add must honor that too.

## Primitives (`primitives.css`)

Restyles existing classes: `.button` (+`.primary/.secondary/.danger`),
`.icon-button`, `.text-button`, `.metric-card`, `.action-dialog`,
`.command-palette`, `textarea`/`input`/`select`, app scrollbars, `kbd`.

New primitives for forge views:

- `.forge-card` (+ `.forge-card-interactive` for hover-lift cards)
- `.forge-glass` — translucent blurred surface
- `.forge-badge` / `.forge-pill` (+ `-primary/-success/-warning/-danger/-info`)

## Icons (`../lucide.js` + `../lucide-sprite.svg`)

UI copy must contain **zero emojis** — use Lucide icons only.

```js
import { lucideIcon } from "./lucide.js";

lucideIcon("search");                        // default "icon lucide" classes
lucideIcon("sparkles", "icon icon-lg");      // custom classes
lucideIcon("loader-circle", "icon forge-spin", 14); // explicit size
```

Allowed names = whatever is listed in `../lucide-icons.json` (`icons` array).
Do not reference icon names that are not in the manifest. To add one, extend
`scripts/vendor-lucide.mjs` and regenerate the sprite (offline, from the
vendored `lucide` package — never hotlink a CDN; server CSP is
`script-src 'self'`). Legacy `#icon-*` sprite ids keep working via
`remapLegacyIconUses()`; `stop-circle` was renamed upstream to `circle-stop`.

## Cascade contract

The 24 stylesheets in `index.html` are ordered, not layered — **load order is
cascade order**, and there is no `@layer` and no build step. Before editing any
global rule, find which layer owns it. Writing the same rule in two layers means
the loser is silently dead code and the winner is an accident of ordering.

Single sources of truth:

| Concern | Owned by | Never touch from elsewhere |
|---|---|---|
| Colour + scale tokens (`--*`) | `forge/tokens.css` | any other file |
| Type scale (`--text-*`) | `forge/tokens.css` | any other file |
| Motion tokens (`--dur-*`, `--ease-*`) | `forge/tokens.css` | `motion.css` owns keyframes + utilities only |
| Ambient stage (`.atelier-stage`, `-mesh`, `-orb`, `-grain`, `#atelier-canvas`) | `forge/art-direction.css` | `atelier.css`, `experience-polish.css` |
| `.main-content` (the only global scroll container) | one block in `styles.css` | do not re-declare |
| Bot work surface | `forge/bot-shell.css` (loads last) | must not leak globally |

`atelier.css` is the **legacy** ambient implementation. `art-direction.css`
supersedes it: mesh and orb are switched off there on purpose, grain is activated
as a subtle tactile paper texture (opacity 0.035-0.045), and `#atelier-canvas`
survives as the living semantic layer.

### Two real bugs this contract exists to prevent (W0 cleanup)
1. **`.main-content` was declared twice in `styles.css`** — once near the top
   with `padding: 24px 26px 32px`, once near the bottom with the compact
   `padding: 16px 18px 18px` plus `background: var(--bg)`. Both were top-level,
   so the later one silently won and the earlier one had been dead for a long
   time. The dead copy is removed; keep exactly one.

2. **Ambient on/off was declared in two files with opposite conclusions.**
   `experience-polish.css` switched off mesh / orb / grain *and* the canvas;
   `art-direction.css` switched off mesh / orb / grain but *kept* the canvas.
   Order decided it, by luck. Worse, the same collision silently killed
   `experience-polish.css`'s `prefers-reduced-motion` rule
   (`.atelier-stage { display: none }`) — an accessibility preference that had
   never actually been in effect. The conflicting block is removed and the
   reduced-motion rule now lives with the owner, `art-direction.css`.

To switch or restyle the ambient field, edit `art-direction.css` and nowhere else.

### Two more the new `token-redefine` gate caught (v49 U0)

3. **`--dur-fast` / `--dur-slow` / `--ease-spring` were declared in both
   `tokens.css` and `motion.css`, with different values.** `motion.css` loads
   later, so `tokens.css`'s `160ms` / `360ms` / spring curve had been **dead code**
   — measured in the browser, `--dur-fast` resolved to `100ms`, affecting 158
   consumers. The `:root` block moved into `tokens.css` carrying **the values that
   were actually in effect**; behaviour is unchanged (48 computed values compared
   one by one, light + dark + content face). `motion.css` now owns keyframes and
   utility classes only.

4. **`--text-xs` was redefined as `calc(var(--ui-font-size) * 0.79)`** in
   `experience-polish.css`. `--ui-font-size` is a user-draggable slider (12–18px),
   so the default rung produced **11.06px** and the smallest **9.48px** — both below
   the 12px hard floor `tokens.css` states for itself ("中文 10px 以下字形糊化").
   57% of the workbench first screen rendered at 11.06px. None of the five existing
   lint rules could catch this by construction: `bare-font` only matches literal
   `font-size: Npx`, and `bare-hex`'s `CUSTOM_PROP_DEF_RE` deliberately skips every
   `--` line. Fixed with a `max(12px, …)` floor; the redefinition itself stays
   (a font-size slider has to redefine the scale) and is what the gate's baseline
   of 4 allows.

**Scale-token redefinition outside `tokens.css` is a baselined violation, not a
ban** — `experience-polish.css` legitimately needs it for the font-size slider.
What the gate demands is that any *new* one justifies why it needs no floor.
Static linting cannot evaluate `calc()`, so the runtime floor is enforced
separately by `inspectTypographyFloor` in `scripts/qa-ui.mjs --suite=layout`
(all seven slider rungs) — both layers are required.

## Gates

`npm run ui:lint` is baseline-based: existing debt is allowed, **any new
violation fails the build**.

- `bare-hex` / `bare-font` / `bare-duration` — no hard-coded colours, font sizes
  or transition timings; consume tokens.
- `odd-breakpoint` — breakpoints must land on 560 / 820 / 1100 / 1440.
- `bare-icon` — decorative SVG needs `aria-hidden`.
- `token-redefine` — scale-step tokens (`--text-*`, `--display-*`, `--space-N`,
  `--radius-*`, `--dur-*`) may only be *defined* in `tokens.css`. Colour and alias
  tokens (`--text-strong`, `--text-muted`, `--radius-card`, `--ease-*`) are
  deliberately excluded — layers are supposed to re-theme those. Baseline is 4
  (the font-size slider's own scaling block); see the cascade contract above.
- `emoji` — **zero emoji in user-visible strings**. Comments are exempt (they are
  developer notes, not UI). Implemented with `\p{Extended_Pictographic}`, which
  deliberately spares the ~260 typographic arrows (`→` `↑` `↓` `↵` `←`) that
  carry text meaning — but does flag `↔`, which has an emoji presentation and can
  render in colour on some systems.

## Hard rules

- No emojis in any UI string. Icons via `lucideIcon()` only.
- No external CDN/network fetches; no new dependencies; no build step.
- UI copy stays 简体中文.
- Honor `prefers-reduced-motion` for new animations.
- Null-guard mount points — containers may not exist yet.
