---
name: motion-orchestration-staggered
description: Orchestrate page-load motion with Framer Motion (or CSS-only) — staggered reveals, choreographed entries, micro-interactions, scroll-driven animation. Use on hero sections, product reveals, dashboard load, or any moment where the page should feel like it composed itself in front of the viewer.
category: motion-graphics
version: 0.1.0
tags: [motion, framer-motion, animation, css, scroll]
recommended_npm: ["framer-motion", "motion"]
license: MIT
author: claude-code-skills
---

A page that animates *every* element on load is amateur. A page that orchestrates a *sequence* — shell first, then content, then accents — feels designed.

## The 3-beat opening

```tsx
import { motion } from "framer-motion";

const beats = {
  shell: { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] } },
  content: { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, delay: 0.15, ease: [0.16, 1, 0.3, 1] } },
  accent: { initial: { opacity: 0, scale: 0.96 }, animate: { opacity: 1, scale: 1 }, transition: { duration: 0.5, delay: 0.35, ease: [0.16, 1, 0.3, 1] } },
};

export const Hero = () => (
  <section>
    <motion.nav {...beats.shell}>…</motion.nav>
    <motion.h1 {...beats.content}>…</motion.h1>
    <motion.div {...beats.accent}>…</motion.div>
  </section>
);
```

`cubic-bezier(0.16, 1, 0.3, 1)` is "easeOutExpo" — feels premium because real-world objects decelerate this way.

## Staggered child reveals

```tsx
const container = {
  initial: {},
  animate: { transition: { staggerChildren: 0.06, delayChildren: 0.2 } },
};
const item = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] } },
};

<motion.ul variants={container} initial="initial" animate="animate">
  {items.map((it) => <motion.li key={it.id} variants={item}>{it.label}</motion.li>)}
</motion.ul>
```

For lists, `staggerChildren` between **0.04 and 0.08s** is the sweet spot. Less = looks simultaneous. More = feels slow.

## CSS-only alternative (no JS)

```css
@keyframes rise {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}
.reveal {
  animation: rise 600ms cubic-bezier(0.16, 1, 0.3, 1) backwards;
}
.reveal:nth-child(1) { animation-delay: 0ms; }
.reveal:nth-child(2) { animation-delay: 60ms; }
.reveal:nth-child(3) { animation-delay: 120ms; }
.reveal:nth-child(4) { animation-delay: 180ms; }
```

Use CSS when the count is fixed and small; Framer Motion when the list is dynamic.

## Scroll-driven (CSS Scroll-Linked Animations, baseline 2025)

```css
@keyframes parallax-up {
  from { transform: translateY(40px); }
  to   { transform: translateY(-40px); }
}
.parallax-img {
  animation: parallax-up linear;
  animation-timeline: view();
  animation-range: entry exit;
}
```

No JS, no `IntersectionObserver`, no scroll listener. Browser support is solid in 2026 evergreens; provide a static fallback for legacy.

## Micro-interactions worth shipping

| Interaction | Effect | Why |
| --- | --- | --- |
| Button hover | `scale(1.02)` + brighten background by 4% | Confirms hit target. |
| Card hover | `translateY(-2px)` + shadow grow | Affordance for "clickable". |
| Click feedback | `scale(0.98)` for 80ms | Real-world depression of a button. |
| Toggle switch | Spring with `damping: 18, stiffness: 280` | Mechanical confidence. |
| Form error shake | `keyframes` with 6 oscillations, 250ms total | Universal "no". |

## When NOT to animate

- ❌ On every render. If the user navigates back, the staggered hero replays — annoying. Use `viewport={{ once: true }}` or `sessionStorage`.
- ❌ When `prefers-reduced-motion: reduce` is set. Always:
  ```css
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
  ```
- ❌ Above-the-fold hero on a low-power device. Profile on a mid-tier Android (CPU 4× throttle).

## Anti-patterns

- ❌ Animating opacity AND transform AND scale AND blur on the same element — one is enough.
- ❌ Bounce easing (`spring(damping=8)`) on UI — feels toy-like; reserve for marketing/onboarding.
- ❌ 1200ms entry animations — viewer waits, doesn't admire. Cap entries at 600ms.
- ❌ Animating `width`/`height`/`top` — paint-bound; use `transform` and `opacity` only.
- ❌ Stagger of 200ms+ on a list of 20 items — last item appears 4 seconds in. User leaves.
- ❌ "Particles" / floating dots in the background — 2014 called.

## Quality gates

- All animations under 600ms.
- `prefers-reduced-motion` honored everywhere.
- 60fps on a mid-tier Android (verify with DevTools Performance, 4× CPU throttle).
- No animation triggers a layout (`transform` and `opacity` only — verify with Paint Profiler).
- Animation is a moment of impact, not a constant background drone.
