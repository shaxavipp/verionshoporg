---
name: design-elevation-protocol
description: Run a 5-pass interrogation on any visual artifact before shipping — first principles, element-by-element analysis, reference checking, uniqueness assessment, and removal testing. Use before delivering any landing page, dashboard, slide deck, or design mockup. The default LLM aesthetic is generic; this protocol is what makes it intentional.
category: ui-design
version: 0.1.0
tags: [design, aesthetic, design-system, review]
recommended_npm: []
license: MIT
author: claude-code-skills
---

The default LLM-generated visual is **generic by construction**. To ship something that feels intentional, run this 5-pass interrogation before declaring done.

## Pass 1 — First principles

Ask, in order:
- What is this artifact for? (one sentence)
- Who is the viewer at the moment they see it?
- What is the one thing they should remember 30 minutes after closing the tab?
- What is the conceptual direction (not the visual style — the *idea*)?

If you can't answer any of these in one sentence, the design has no spine. Stop and find the spine first.

## Pass 2 — Element-by-element analysis

Walk the artifact top-to-bottom. For each element ask:
- Why is this here?
- What does it do that nothing else does?
- What font choice, color, and weight did I just commit to, and was it deliberate?

If an element exists "because layouts have one of these," delete it.

## Pass 3 — Reference checking

Pick **one** reference from each tier and compare honestly:

- **Modern peer**: Stripe, Linear, Vercel, Arc, Things 3, Raycast. What's *better* about your version?
- **Historical movement**: Bauhaus, Swiss Design, Memphis, Brutalism, Art Deco. What does your version borrow?
- **Natural pattern**: golden ratio, fractal recursion, organic asymmetry, crystalline grids. What grounds the composition?

If your version isn't *different* in some specific axis from the modern peer, you're shipping a reskin.

## Pass 4 — Uniqueness assessment

Show the design to someone who hasn't seen it. Ask: "Without reading the brand name, what kind of company is this?" If the answer is "I dunno, a SaaS company," generic. If they say "this looks like Notion / shadcn," generic. The goal is a specific answer that's *yours*.

## Pass 5 — Removal test

For each element on the page, ask: *what breaks if I remove this?*

- If the answer is "nothing", remove it.
- If the answer is "the composition feels less full", you found a load-bearing absence — the composition was overstuffed.
- If the answer is "the meaning is lost", keep it.

The best designs survive the removal test with surprisingly little left.

## Decision matrix when in doubt

| Tension | Default to | Why |
| --- | --- | --- |
| Bold vs subtle | Whichever fits the *idea* | Both work; mismatch with concept doesn't. |
| Density vs whitespace | More whitespace | Easier to add density later than to remove it. |
| Custom vs system fonts | Custom (1-2 weights subset) | Fonts are the strongest character signal. |
| Animation everywhere vs sparingly | Sparingly | High-impact moments only; default = static. |
| Many accent colors vs one | One sharp accent on muted base | Easier to balance; harder to look generic. |

## Restraint verification

Before shipping, count:
- Distinct fonts used: ≤ 2 (display + body, optionally mono)
- Distinct accent colors: 1 (with shades)
- Animations on first paint: ≤ 3
- Components with custom shadows: ≤ 2 (rest use the system)

Exceeding any of these without a specific reason = overdesigned.

## Anti-patterns

- ❌ "I'll fix the type pairing later" — type pairing IS the design.
- ❌ Three CTAs of similar weight — the eye doesn't know where to go.
- ❌ Stock illustrations from undraw.co / openpeeps — distinctive design with stock illustrations is a contradiction.
- ❌ Default Tailwind palette (zinc + blue) — recognized as default in 2 seconds.
- ❌ "Glassmorphism" applied to anything other than a hero section — it ages instantly.
- ❌ Skipping Pass 5 because the design "already looks done" — every design has 1-2 elements that should die.

## When to skip this skill

Pure utility UIs: admin tables, debug panels, internal tooling for ≤5 users. There, function dominates. Anywhere a customer or evaluator will see the artifact in the next 6 months — run all five passes.
