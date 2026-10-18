---
name: ColdChain
description: Real-time cold-chain monitoring for vaccine and insulin fridges, read like a vaccine vial monitor label.
colors:
  teal: "#0f766e"
  teal-strong: "#0b5e57"
  teal-wash: "#e3f4f1"
  on-teal: "#ffffff"
  ground: "#eef2f6"
  panel: "#ffffff"
  panel-2: "#f6f8fa"
  rule: "#d5dde6"
  rule-strong: "#b6c2cf"
  ink: "#0f1b2a"
  ink-2: "#44546a"
  ink-3: "#5b6b80"
  safe: "#15803d"
  safe-wash: "#e8f6ec"
  warning: "#a35400"
  warning-wash: "#fdf3e2"
  breach: "#c0262d"
  breach-wash: "#fdeceb"
  atrisk: "#c2410c"
  atrisk-wash: "#fff0e6"
  discard: "#3d0d10"
  discard-wash: "#f3e3e3"
  offline: "#5b6b80"
  offline-wash: "#edf1f5"
  demo: "#6d28d9"
  on-demo: "#ffffff"
  teal-dark: "#2dc6b5"
  teal-strong-dark: "#5fd8ca"
  teal-wash-dark: "#0f2e2e"
  on-teal-dark: "#04211e"
  ground-dark: "#0a121c"
  panel-dark: "#111c29"
  panel-2-dark: "#0e1823"
  rule-dark: "#24344a"
  rule-strong-dark: "#34486a"
  ink-dark: "#e7eef6"
  ink-2-dark: "#aab8c8"
  ink-3-dark: "#8d9db0"
  safe-dark: "#4ade80"
  safe-wash-dark: "#0f2a1a"
  warning-dark: "#fbbf4a"
  warning-wash-dark: "#2e2310"
  breach-dark: "#ff7a7a"
  breach-wash-dark: "#351416"
  atrisk-dark: "#fb9a5a"
  atrisk-wash-dark: "#33190c"
  discard-dark: "#ffb4b4"
  discard-wash-dark: "#2a0c0e"
  offline-dark: "#9aa8b8"
  offline-wash-dark: "#1a2533"
  demo-dark: "#7c3aed"
typography:
  display:
    fontFamily: "Public Sans Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.9rem"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Public Sans Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.33
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Public Sans Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 600
  body:
    fontFamily: "Public Sans Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "Public Sans Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    letterSpacing: "0.025em"
  figures:
    fontFamily: "Public Sans Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontFeature: "\"tnum\" 1"
rounded:
  focus: "4px"
  label: "6px"
  pill: "9999px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.teal}"
    textColor: "{colors.on-teal}"
    typography: "{typography.body}"
    rounded: "{rounded.label}"
    padding: "0 14px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.teal-strong}"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.label}"
    padding: "0 14px"
    height: "40px"
  button-secondary-hover:
    backgroundColor: "{colors.panel-2}"
  button-ghost:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.label}"
    padding: "0 14px"
    height: "40px"
  button-ghost-hover:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.ink}"
  panel:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.label}"
    padding: "16px"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.label}"
    padding: "8px 12px"
    height: "44px"
  status-chip-safe:
    backgroundColor: "{colors.safe-wash}"
    textColor: "{colors.safe}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  status-chip-breach:
    backgroundColor: "{colors.breach-wash}"
    textColor: "{colors.breach}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  nav-item:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.label}"
    padding: "0 12px"
    height: "40px"
  nav-item-active:
    backgroundColor: "{colors.teal-wash}"
    textColor: "{colors.teal-strong}"
  demo-banner:
    backgroundColor: "{colors.demo}"
    textColor: "{colors.on-demo}"
    padding: "6px 16px"
---

# Design System: ColdChain

## Overview

**Creative North Star: "The Vial Monitor Label"**

ColdChain is built from label stock. Cool white panels sit on a pale slate ground like adhesive labels on a fridge door, cut with a small die-cut corner and edged by a single 1px slate rule. Teal ink marks what you can act on and where you are; everything else stays quiet slate so that status can be loud when it has to be.

Status is read the way a nurse reads a vaccine vial monitor: a square inside a circle, the square darkening as the heat budget is used. That mark is both the logo and the status glyph, and every status in the product travels as colour plus mark plus word. The density is operational: a clinic PC and a night-shift wall monitor, desktop first, still whole at 360px. Light and dark are one system with remapped values; dark exists for the wall monitor, not as a mood.

The world refuses the generic IoT dashboard: no grid of KPI cards with sparklines standing in for state.

**Key Characteristics:**
- Label-stock panels on a slate ground, 1px rules, 6px die-cut corners.
- Teal is the only action and selection ink; status inks never double as actions.
- Every status is colour + VVM mark + word, never colour alone.
- One workhorse face, Public Sans, with tabular figures for readings.
- Calm at rest; motion only when a status actually changes.

## Colors

A clinical slate-and-white neutral field, one teal action ink, and a fixed status vocabulary of six inks plus a violet disclosure colour, each paired with a pale wash.

### Primary
- **Monitor Teal** (teal): primary buttons, selection, focus rings, caret, the logo ring. In dark mode it lifts to a bright mint-teal with dark text on it.
- **Deep Teal** (teal-strong): primary hover, active nav text, role labels, avatar initials.
- **Teal Wash** (teal-wash): active nav item fill, avatar disc.

### Status inks (fixed vocabulary)
- **Safe Green** (safe / safe-wash): fridge in 2 to 8 °C, batch budget intact; the "Live" connection glyph.
- **Amber Warning** (warning / warning-wash): near the band edge, door open, on battery; the "Polling" glyph.
- **Breach Red** (breach / breach-wash): fridge outside 2 to 8 °C; field errors; destructive buttons.
- **At-Risk Orange** (atrisk / atrisk-wash): batch under 20 % of heat budget left.
- **Discard Oxblood** (discard / discard-wash): budget spent or expired. Always with the diagonal strike pattern.
- **Offline Slate** (offline / offline-wash): no data from the node; also the "Connecting" glyph.
- **Disclosure Violet** (demo / on-demo): the demo-mode banner only.

### Neutral
- **Slate Ground** (ground): the page behind every panel.
- **Label Stock** (panel): panels, top bar, inputs, menus, modals, bottom bar.
- **Rail Stock** (panel-2): sidebar rail, table heads, hover fills, skeletons, login story column.
- **Hairline Rule** (rule): every panel edge, header divider, row divider.
- **Strong Rule** (rule-strong): input and secondary-button borders, scrollbar thumb.
- **Label Ink** (ink): primary text. **Ink 2** (ink-2, 7.4:1 on panel): secondary text, nav at rest, table heads. **Ink 3** (ink-3, 5.4:1 on panel): hints, placeholders, tertiary meta.

### Named Rules
**The Three-Signal Rule.** A status is never colour alone: it is the status ink, the VVM mark (or a distinct lucide glyph for connection state), and a word. Where width forces the word out, it moves to `sr-only`, not away.

**The Teal-Is-Action Rule.** Teal means "act here" or "you are here". It never signals a status, and status inks never fill a primary action except Breach Red on a destructive confirm.

**The Wash Pairing Rule.** Status ink sits on its own wash (chips) or on a 9 % mix of the ink into panel (the global status pill), with a border of the ink at 35 to 40 % opacity. Every ink-on-wash pair holds 4.5:1 or better in both themes.

**The Violet Disclosure Rule.** Disclosure Violet appears only on the demo-mode banner, full width, above the top bar, on every screen while time is accelerated.

## Typography

**Display Font:** Public Sans Variable (with ui-sans-serif, system-ui, sans-serif)
**Body Font:** Public Sans Variable
**Label/Mono Font:** Public Sans with tabular numerals (the `figures` role); no separate mono face.

**Character:** A plain, public-service sans with a government-forms honesty; weight and size carry the hierarchy, not a second family.

### Hierarchy
- **Display** (700, 1.9rem, tight leading, -0.02em): the login story line only.
- **Headline** (700, 1.5rem, -0.015em, balanced wrap): page titles in the page header.
- **Title** (600, 0.95rem): panel titles; modal titles step up to 1rem; empty-state titles 1rem.
- **Body** (400, 0.875rem): almost all running text, table cells, menu items, helper text. Inputs read at 0.95rem. Explanatory text caps at `max-w-prose`.
- **Label** (600, 0.75rem, 0.025em tracking, uppercase): table column heads only. Field labels are 0.875rem semibold sentence case. Bottom-bar tab labels are 0.7rem semibold.
- **Wordmark** (700, 1.05rem, -0.01em): "ColdChain" beside the logo mark.

### Named Rules
**The One Workhorse Rule.** Public Sans is the only family. Readings, counts, lot numbers and alert counts use tabular figures (`.figures`) so columns and live numbers do not jitter.

## Layout

Desktop: a 240px label rail (sidebar) on the left, sticky, full height on Rail Stock with a hairline right rule; to its right a column of demo banner, 56px sticky top bar on Label Stock, then the page body on Slate Ground with 32px side padding (16px below lg). Page header: headline plus one line of ink-2 context, actions right-aligned, 24px below.

Below lg (1024px) the rail becomes a fixed bottom bar: four primary destinations plus a "More" menu that opens upward, 56px tall tabs, safe-area padded; the body gets 96px bottom padding to clear it. From sm (640px) to lg the compact logo mark joins the top bar; below sm the global status pill takes that width and switches to compact copy ("2 alerts · 1 crit.").

Rhythm runs on 6 / 8 / 12 / 16 / 24 / 32px. Panels pad 16px; headers 12 to 16px horizontally with a 48px minimum height. Hit targets are 40px minimum (44px for inputs, 56px for bottom tabs).

The login screen splits at lg into a Rail Stock story column (logo, display line, VVM specimen row, status legend) and a form column whose card is top-anchored at 22vh so errors grow downward without moving it.

## Elevation & Depth

Depth is mostly tonal: Label Stock on Slate Ground, separated by hairline rules. Shadows are cool slate-ink (rgb 15 27 42) and come in three steps tied to role, never to decoration.

### Shadow Vocabulary
- **Label lift** (`box-shadow: 0 1px 2px rgb(15 27 42 / 0.05)`): resting panels and the login card; just enough to read as stock on a surface.
- **Floating menu** (`box-shadow: 0 12px 32px rgb(15 27 42 / 0.18)`): user menu, bottom-bar "More" menu. Toasts use `0 8px 24px rgb(15 27 42 / 0.14)`.
- **Modal** (`box-shadow: 0 18px 48px rgb(15 27 42 / 0.22)`): native dialog, over a `rgb(10 18 28 / 0.45)` backdrop.

### Named Rules
**The Label-On-Surface Rule.** Resting surfaces get the hairline label lift and nothing heavier; only things that float above the page (menus, toasts, dialogs) get diffuse shadows. No hard offset shadows.

## Shapes

One die-cut corner (6px) on everything that is label stock or a control: panels, buttons, inputs, menus, toasts, modals, nav items, icon buttons. Full rounding is reserved for status: the status chip, the global status pill, the avatar disc. Focus rings round to 4px. The recurring silhouette is the VVM mark itself: a ring (stroke 2.25 on a 24 grid) holding a square whose fill opacity runs from 0.14 (fresh) to 1 (spent); OFFLINE draws the square dashed and empty; DISCARD adds a panel-coloured diagonal cut through it.

**The Die-Cut Rule.** Containers and controls are 6px, status is round. Nothing in between, nothing sharper, nothing softer.

**The Strike Rule.** DISCARD is permanent and looks crossed out: a -45° repeating strike (2px ink at 16 % every 7px) over its wash, and the diagonal cut in its mark.

## Components

### Buttons
Firm, flat and squared-off like a label tab.
- **Shape:** die-cut corner (6px), 1px border, 40px minimum height, 14px side padding, 0.875rem semibold, 8px icon gap.
- **Primary:** Monitor Teal fill and border, on-teal text; hover deepens to Deep Teal.
- **Secondary:** Label Stock with a Strong Rule border; hover to Rail Stock with an Ink 3 border.
- **Ghost:** transparent, Ink 2 text; hover fills Rail Stock and darkens text to Ink.
- **Danger:** Breach Red fill with `--on-breach` text (white in light, dark red ink #2a0709 in dark, both >= 4.5:1) for destructive confirmations.
- **Press / Loading / Disabled:** primary, secondary and danger nudge down 1px on press; loading swaps the icon for a spinner and sets `aria-busy`; disabled drops to 55 % opacity. Transitions run 150ms on colour and transform.

### Chips
- **Style:** the StatusChip: full round, status wash fill, status ink text, ink border at 35 %, VVM mark (13 or 15px) before a semibold word. Two sizes: sm (0.75rem, 2px × 8px) and md (0.875rem, 4px × 10px).
- **State:** one chip per status in the fixed vocabulary; DISCARD carries the strike pattern. A `title` gives the plain-language meaning.

### Cards / Containers
- **Corner Style:** die-cut (6px).
- **Background:** Label Stock on Slate Ground.
- **Shadow Strategy:** label lift only (see Elevation).
- **Border:** 1px Hairline Rule; an optional header row (title + actions) divided by a rule, 48px minimum.
- **Internal Padding:** 16px. Panels never nest inside panels.

### Inputs / Fields
- **Style:** visible semibold label above; a 44px Label Stock box with a Strong Rule border, 6px corners; hover border goes to Ink 3; placeholder in Ink 3; teal caret.
- **Focus:** the border turns Monitor Teal, plus the global 2px teal focus ring offset 2px.
- **Error / Disabled:** Breach Red border and a Breach Red message directly beneath, wired by `aria-describedby`; hints sit in the same slot in Ink 3.

### Navigation
- **Rail (lg and up):** Rail Stock, logo in a 56px header, 40px items with 18px lucide icons, 0.875rem medium Ink 2; hover lifts to Label Stock and Ink; active is Teal Wash with Deep Teal text.
- **Bottom bar (below lg):** Label Stock with a top rule, icon over 0.7rem semibold label, active in Deep Teal; "More" opens an upward floating menu using the rail item style.
- **Top bar:** global status pill at left, then connection state (distinct glyph per state: radio for live, refresh for polling, spinner for connecting), the cycling theme toggle, and the user menu.

### Tables
Semantic tables with a screen-reader caption, sticky Rail Stock head with uppercase label-role column heads, 16px cell padding, hairline row rules, tabular figures throughout, Rail Stock row hover when rows are clickable; they scroll sideways inside their panel.

### Feedback
- **Toasts:** bottom-right (above the bottom bar on mobile), Label Stock, die-cut, with a tone-coloured lucide glyph and a title; one polite live region, auto-dismiss at 6s, at most four.
- **Modal:** native `<dialog>`, max 32rem, header and footer divided by rules; reserved for confirmations that need protected focus (reset latch, delete).
- **Empty / Error states:** an empty state teaches what will appear and what makes it appear; errors name the problem and the recovery, and a 403 reads as "no permission". Skeletons keep the final size and breathe at 1.4s.

### VVM Mark (signature)
The vaccine-vial-monitor mark is the logo (teal, square two-thirds unspent) and the status glyph everywhere: chips at 13 to 15px, the status pill at 20px, the login specimen at 56px. Its square fills with used budget. It pulses once (scale to 1.22 over 420ms, `cubic-bezier(0.16, 1, 0.3, 1)`) when its status changes, never on mount, so lists and route changes stay still. Standalone it takes `role="img"` and a label; beside its word it is decorative.

**The Pulse-On-Change Rule.** Motion is a signal: the only attention motion is the single VVM pulse on a real status change. Reduced motion collapses all animation to 1ms.

## Do's and Don'ts

### Do:
- **Do** put every status through the shared vocabulary: status ink + VVM mark + word, from one source of truth.
- **Do** use Monitor Teal for primary actions, selection, focus and the logo, and only for those.
- **Do** keep containers and controls at the 6px die-cut corner and status shapes fully round.
- **Do** set readings, counts and lot numbers in tabular figures.
- **Do** show the demo-mode banner in Disclosure Violet on every screen whenever heat exposure is accelerated.
- **Do** show connection state (live, polling, connecting) with a distinct glyph per state, plus the word from sm up.
- **Do** strike DISCARD with the diagonal pattern wherever it appears.

### Don't:
- **Don't** build the generic IoT dashboard of KPI cards and sparklines; state is read from VVM marks and words.
- **Don't** signal status with colour alone, or with teal.
- **Don't** pulse or animate the VVM mark on mount, on route change, or on a loop.
- **Don't** nest panels inside panels.
- **Don't** add a second typeface.
- **Don't** use hard offset shadows or anything heavier than the label lift on resting surfaces.
- **Don't** use the modal for anything but protected-focus confirmations; everything else stays inline.
