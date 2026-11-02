# Nexus Response — Brand

**Name:** Nexus Response  **Tagline:** Every event, resolved.
**Idea:** many sources converge on one response point. The mark is four vendor nodes feeding a single signal-orange hub with a halo ring.

## Voice
Calm, exact, operational. Short declaratives, verbs first ("Dispatch tow", "Open claim packet"). Numbers over adjectives. No exclamation marks, no hype words (seamless, revolutionary). Urgency is shown by color and position, not by shouting.

## Assets (`/shared/`)
- `logo.svg` full lockup (wordmark adapts to dark/light via prefers-color-scheme when used as `<img>`)
- `logo-mark.svg` mark only (neutral slate nodes + orange hub; works on both themes)
- `favicon.svg` mark on navy tile

## Color tokens (`--nx-*`, defined for both themes)
| Token | Dark | Light | Use |
|---|---|---|---|
| `--nx-bg` | #070D18 | #EEF2F7 | page |
| `--nx-surface / -2 / -3` | #0E1626 / #131D31 / #1A2740 | #FFF / #F5F7FB / #E9EEF6 | cards, inputs, hover |
| `--nx-border / -strong` | #1F2D47 / #2C4063 | #DAE1EC / #BCC8DA | lines |
| `--nx-text / -dim / -faint` | #E8EEF7 / #93A3BC / #5F7190 | #0B1220 / #4A5B75 / #7B8BA3 | text |
| `--nx-accent` | #FF6A1A | #F25C05 | signal orange: primary action, live, focus, brand. Not a severity. |
| `--nx-sev-critical/high/medium/low` | #FF3B4E #FF8A1F #F2C230 #4BB4F0 | #D61F36 #D9690A #A67C00 #0F7DB8 | severity only |
| `--nx-st-pending, validating, dispatched, en_route, on_scene, resolved, dismissed` | grey, violet, blue, teal, amber, green, dim | adjusted for contrast | status only |
| `--nx-ok / warn / danger / info` | green / yellow / red / blue | | feedback |

Rules: orange means "act here" (buttons, current item, live). Red is reserved for critical. Never use severity colors decoratively. Soft backgrounds are derived with `color-mix(... 14%)`, never hard-coded.

## Themes
Dark is the default (mission control, dispatch). Fleet and insurer portals should default light via `NX.theme.defaultTo('light')` (respects a user's saved choice). Set `<html data-theme="dark|light">`; with no attribute the OS preference applies. Toggle persists in `localStorage['nx-theme']`.

## Typography
- Display / KPI numerals / card titles: **Barlow Condensed** 500-700, uppercase for titles (`--nx-font-display`)
- UI text: **IBM Plex Sans** 400-600 (`--nx-font-ui`)
- Data, IDs, VINs, codes, timestamps, eyebrows: **IBM Plex Mono** (`--nx-font-mono`), tabular numerals
- All via Google Fonts with system fallbacks, so offline still renders.
Scale: 10.5 / 12 / 13 / 14.5 / 17 / 22 / 30 / 44 / 64 px (`--nx-text-2xs...4xl`). Eyebrow labels: mono, 10.5px, +0.12em, uppercase.

## Spacing, shape, depth
4px base: `--nx-sp-1..8` = 4, 8, 12, 16, 24, 32, 48, 72. Radii: 4 (badges), 8 (controls), 12 (cards), pill (chips). Shadows are subtle; elevation is mostly borders. Accent glow (`--nx-glow`) only on hover/selected primary things.

## Iconography
Mostly typographic and geometric: dots, rings, arrows, unicode glyphs. If icons are needed use 1.5px-stroke outline, 16 or 20px, `currentColor`. No emoji in product UI, no filled multicolor icons. Status is always dot + label, never color alone.

## Motion
Fast and functional. 120ms hover, 200ms enter, 400ms meters, ease `cubic-bezier(.2,.7,.2,1)`. Allowed ambient motion: live-dot ping, dashed data-flow lines, new-row flash (`.nx-new`), critical pulse (`.nx-pulse-critical`). All disabled under `prefers-reduced-motion`.

## Layout
Dense, data-first. Shell = topbar (52px) + sidebar (232px) + main. Sidebar collapses to a drawer under 900px; grids go single column under 640px. Print hides chrome and forces a white, black-text theme (warranty packets).

## v3 additions
- **Mantis** is the featured camera-first partner: in the launcher it gets the accent-filled wordmark with a "camera-first partner" tag, the same accent node in the convergence diagram, and `.nx-badge--mantis`. Other vendors stay neutral wordmarks (text only, never real logos).
- **Predict and prevent** story: history in, risk assessed, projected, alert before the crash. Predictive alerts use `.nx-alert-card` (severity stripe), forecasts use `.nx-stat-delta`; keep them visually distinct from live incidents.
- **Wizard components**: `.nx-stepper` (step status: done = green check, active = orange), `.nx-dropzone` (dashed, orange on hover or drag), `.nx-progress` (orange determinate, green when done, indeterminate for unknown length). Catalog with markup in docs/HANDOFFS.md.
- Portal order everywhere: Dispatch, Fleet, Insurer, Onboarding.
