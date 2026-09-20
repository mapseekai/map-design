---
version: "0.4.0"
name: Quiet Atlas
description: "A restrained editorial atlas family for clear orientation and unhurried reading."
colors:
  paper: "#F8F4F0"
  water: "#AECFE2"
  waterway: "#A0C8F0"
  building: "#DFDBD7"
  road-warm: "#FFEEAA"
  road-amber: "#FFCC88"
  ink: "#171717"
  halo: "{colors.paper}"
widths:
  hairline: 0.5px
  road-primary: 2.5px
  road-secondary: 1.25px
  waterway: 1.25px
  road-overview: 1px
  road-regional: 1.5px
  road-detail: 4px
  label-halo: 1px
sizes:
  point-small: 5px
  point-medium: 8px
opacities:
  solid: 1
  context: 0.58
spacing:
  label-gap: 2px
  symbol-label-gap: 4px
dashes:
  boundary: [4px, 2px]
typography:
  label-primary:
    fontFamily: ["Source Serif 4", "Georgia", "serif"]
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: 0.01em
  label-context:
    fontFamily: ["Source Sans 3", "Arial", "sans-serif"]
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: 0em
elements:
  paper-ground:
    geometry: background
    family: atlas-ground
    role: canvas
    state: default
    layerRole: background
    color: "{colors.paper}"
  water-area:
    geometry: polygon
    family: water
    role: context
    state: default
    layerRole: context
    fillColor: "{colors.water}"
    fillOpacity: "{opacities.context}"
  waterway-line:
    geometry: line
    family: water
    role: detail
    state: default
    layerRole: context
    strokeColor: "{colors.waterway}"
    strokeWidth: "{widths.waterway}"
  road-primary:
    geometry: line
    family: road
    role: primary
    state: default
    layerRole: subject
    strokeColor: "{colors.road-warm}"
    strokeWidth: "{widths.road-primary}"
    casingColor: "{colors.paper}"
    casingWidth: "{widths.hairline}"
  road-secondary:
    geometry: line
    family: road
    role: secondary
    state: default
    layerRole: context
    strokeColor: "{colors.road-amber}"
    strokeWidth: "{widths.road-secondary}"
    opacity: "{opacities.context}"
  administrative-boundary:
    geometry: line
    family: boundary
    role: reference
    state: default
    layerRole: context
    strokeColor: "{colors.ink}"
    strokeWidth: "{widths.hairline}"
    dash: "{dashes.boundary}"
    opacity: "{opacities.context}"
  place-label-primary:
    geometry: label
    family: place-label
    role: primary
    state: default
    layerRole: annotation
    color: "{colors.ink}"
    haloColor: "{colors.halo}"
    haloWidth: "{widths.label-halo}"
    typography: "{typography.label-primary}"
    spacing: "{spacing.label-gap}"
  place-label-context:
    geometry: label
    family: place-label
    role: context
    state: default
    layerRole: annotation
    color: "{colors.ink}"
    typography: "{typography.label-context}"
    opacity: "{opacities.context}"
  atlas-point:
    geometry: point
    family: atlas-point
    role: reference
    state: default
    layerRole: annotation
    color: "{colors.ink}"
    size: "{sizes.point-small}"
---

## Overview

Quiet Atlas is a restrained editorial map family: warm paper, pale blue water,
and near-black ink make the page feel calmly printed rather than brightly
screen-lit. It favors pauses, generous margins, and a small set of durable
signals that let a reader settle into an unfamiliar place.

## Colors

Use {colors.paper} as the low-glare canvas and {colors.water} as its cool,
quiet counterweight. {colors.building} holds built texture a
half-step above the canvas. {colors.road-warm} and {colors.road-amber} are
related, sparing navigation accents; {colors.ink} anchors essential names and
decisive editorial marks rather than broad decoration. Aim for WCAG 2.2 contrast of at
least 4.5:1 for ordinary critical text and 3:1 for large text or essential
non-text marks against their effective backgrounds. Preserve meaning with
weight, outline, dash, symbol, or placement as well as hue.

## Typography & Labels

Typography is measured, literate, and quietly contemporary. Use
{typography.label-primary} for the few names that guide orientation, and
{typography.label-context} for supporting place reading. Favor fewer,
well-placed names with {spacing.label-gap} of breathing room,
and keep {spacing.symbol-label-gap} between a point symbol and its label;
protect critical labels with the quiet halo in `place-label-primary`, never a
visible badge.

## Composition & Density

Compose from calm paper through contextual water and built texture to routes
and names. Protect open paper around important labels and across broad calm
areas. When density rises, reduce secondary texture and labels before crowding
the focal marks; breathing room is information design, not unused space.

## Layering & Depth

The conceptual order is paper ground, context, subject, then annotation.
`paper-ground` stays flat; `water-area`, `waterway-line`, and `road-secondary`
recede through lighter color and {opacities.context}. `road-primary` and `place-label-primary`
hold {opacities.solid} and emerge through weight, casing, and contrast without
making the map theatrical.

## Geometry & Symbols

Favor slender, deliberate linework; soft low-contrast areas; and compact marks
with unambiguous silhouettes. Point marks step from {sizes.point-small} to
{sizes.point-medium} only when a place truly earns the extra weight.
`administrative-boundary` uses {dashes.boundary} only for reference separation.
Curves should read as calm gestures rather than technical traces; remove
details that cannot retain their family resemblance at small sizes.

## Scale & Generalization

All declared elements use local as their base stage. Road-primary uses
{widths.road-overview} at overview, {widths.road-regional} at regional,
{widths.road-primary} at local and {widths.road-detail} at detail. Hide
road-secondary at overview and regional; keep its base width when visible.
Keep waterway width independent from road tokens even when values coincide.
Other visible components retain their base values. Atlas points appear at
detail; use {sizes.point-medium} only for reference places requiring emphasis.
Optional smooth transitions must preserve primary above secondary, orientation
labels above context labels, and quiet water beneath routes. Report stage
switching if smooth transitions cannot be maintained.

At `overview`, preserve the large spatial story and only the strongest names.
At `regional`, establish major water and route relationships. At `local`, reveal
supporting routes and contextual labels; at `detail`, add compact reference
marks selectively. Each stage simplifies before it shrinks and remains the same
printed atlas rather than a different visual system.

## Map Elements

This family maintains only default state. Interaction feedback is a task-level
adaptation and must preserve feature meaning and the restrained hierarchy;
permanent variants require an explicit design-system change.

Use road components for orientation routes, not quantitative magnitude or risk.
Use water components for contextual water, not an interchangeable route scale.
Use primary labels for orientation, context labels for supporting names; remove
context labels first. Atlas-point is a circular reference mark: size is diameter,
not radius. Label-gap and symbol-label-gap are edge-to-edge clearances, not
center distances. The road casing adds its thickness on each side. Boundaries
remain references and must never appear as emphasized routes.

`paper-ground` establishes the warm canvas. `water-area` and `waterway-line`
form the quiet water family, while `road-primary` and `road-secondary` express
one route family at different roles. `administrative-boundary` is a subdued
reference line. `place-label-primary` and `place-label-context` use the place
label family to separate orientation from context. `atlas-point` supplies a
compact, inked reference mark. These are visual components, not bindings to
specific datasets, fields, or rendering layers.

## Do's and Don'ts

Do preserve the paper-water-ink relationship and spend warm accents sparingly.
Do use related family, role, and state values when adding a persistent variant.
Do retain a second visual channel for important distinctions. Don't fill every
empty area with texture or labels. Don't use decorative color, heavy outlines,
or competing type voices to manufacture energy. Don't turn a temporary state
into a louder hierarchy than the subject it represents.
