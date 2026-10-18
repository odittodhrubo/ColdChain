---
version: 1
slug: "frontend-src"
primary_target: "frontend/src"
related_targets: []
---

# Surface brief: ColdChain web app shell (frontend/src)

Scope: the authenticated app shell (sidebar, top bar, login, guards, realtime layer, ui kit) that every page reuses. Mode: Operate. Desktop first (clinic PC, wall monitor); works at 360 px.
Audience and job: pharmacist / admin / inspector watching fridges and batches; hackathon judges in the demo. Constraint: spec-pinned clinical white/slate, teal primary, status palette, colour never alone.

## Direction contract

THESIS: Every batch and fridge wears a vaccine-vial-monitor mark: a square inside a circle whose square darkens as heat budget is used. Status is read the way a nurse reads a VVM, at a glance, colour plus shape plus word. Refuses the generic IoT dashboard of KPI cards and sparklines.

OWN-WORLD: label stock: cool white panels on a pale slate ground, 1px slate rules, small die-cut radius, teal ink for actions and selection. Status inks green / amber / red / orange / deep red with diagonal strike / grey / violet demo. One workhorse face (Public Sans, tabular numerals for readings). The VVM mark is the logo and the status glyph.

STORY: the visitor sees at once whether everything is safe, which fridge or batch is not, and whether the data is live; then acts (ack, move, reset) within their role.

FIRST VIEWPORT: left label-rail nav with the VVM logo; top bar with the global status pill (VVM mark + words), live/polling indicator, theme toggle, user menu; demo banner above when accelerated; page body below.

FORM: Vial Monitor Label, my rank 1 (pick card), seed key 0d6af820. Signature interaction: the VVM mark's inner square fills with used budget and pulses once when its state changes.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
