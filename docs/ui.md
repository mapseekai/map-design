# MapDesign UI

The UI uses Tailwind CSS 4.3.3 and the official shadcn/ui Base UI Nova registry components generated with shadcn CLI 4.21.0 (2026-09-08).

## Ownership

- `packages/components/src/ui/`: official shadcn source, adapted with `forwardRef` for the existing React 18.3 runtime.
- `packages/components/src/lib/utils.ts`: `cn` combines clsx and tailwind-merge.
- `apps/web/src/index.css`: Tailwind entry, shadcn state variants, animation utilities, explicit shared-package source scanning.
- `apps/web/src/styles/tokens.css`: the single semantic theme, retaining DESIGN.md's warm canvas, serif headings, and coral action palette. Primary uses the darker coral shade for readable white button text.
- Pages and domain components compose the shared components using Tailwind layout utilities. No page CSS Modules or global button/input rules remain.
- MapLibre keeps its own library CSS and runtime geometry. Dynamic dimensions and map colors remain data, not UI theme overrides.

## Component conventions

Import primitives from `@mapseekai/components`. Use semantic tokens (`bg-background`, `text-muted-foreground`, `border-border`) and standard variants. Forms use Field/FieldGroup; cards use Card composition; callouts use Alert; empty states use Empty.

All visible dropdowns use shadcn Select (SelectTrigger/SelectValue and portalled SelectContent/SelectGroup/SelectItem). NativeSelect is not included. Preserve empty/default domain values through a local nonempty UI sentinel, since the Select component reserves the empty string for clearing selection. Select roots supply their value-to-label items and use non-native popup lists. DialogRoot/DialogContent, Sheet and Popover use Base UI portals, keyboard handling and focus management. The small `Dialog` adapter preserves existing workflow callback props while using the same shadcn components, including focus restoration when no DialogTrigger is mounted.

The official source is checked in, not reimplemented through a second CSS layer. Generated components are React 18 ref-compatible; preserve that when updating from a newer React-oriented registry.

## Style ownership checks

Run `pnpm lint` (or `pnpm lint:shadcn`) at the repository root. The shadcn `no-restyle` rule checks Web pages and shared component consumers, permits layout classes, and excludes primitive implementations in `packages/components/src/ui/`. This dedicated command ignores inline ESLint directives, including directives for unrelated framework rules.

Use existing variants and sizes before adding presentation options. Put text truncation on the text node and spacing between composed children on an inner layout container. Shared primitives own their colors, borders, padding, and transitions. Project extensions retain the upstream defaults:

| Component | Opt-in presentation |
| --- | --- |
| Button | `size="content"` for multiline choices; `shape="circle"` for round icon actions |
| PopoverContent | `size="sm"` for compact action lists |
| ResizableHandle | `variant="subtle"` for the workspace separator |
| Tabs / TabsTrigger | `spacing="none"` for contiguous panels; `size="sm"` for compact tabs |
| DialogContent | `layout="sectioned"`, also forwarded by the Dialog adapter |
| SheetContent | `variant="panel"` for a sectioned inspector, including its closing transition |
| Empty | `variant="outline"` and `size="sm"` |
| Card | `variant="media"` for an edge-to-edge thumbnail |
| Alert | `appearance="floating"` or `appearance="banner"`, independent of its status variant |
| JsonEditor | `bordered={false}` when embedded in a workspace panel |

## Updating

From the repository root:

```sh
pnpm --dir apps/web exec shadcn info
pnpm --dir apps/web exec shadcn add button --diff -c ../../packages/components
pnpm --filter @mapseekai/components build
pnpm --filter @mapseekai/components test
pnpm --filter @mapseekai/web typecheck
pnpm --filter @mapseekai/web test
pnpm guard
```

Review registry updates before overwriting the local React 18 adapters. After adding components, confirm their direct dependencies are declared by the shared package and run a production web build so Tailwind scanning and state variants are checked.

Official references: [monorepos](https://ui.shadcn.com/docs/monorepo), [theming](https://ui.shadcn.com/docs/theming), [Base UI components](https://ui.shadcn.com/docs/components/base/button).

Base UI composition uses `render` instead of `asChild`. Popup focus uses `initialFocus` / `finalFocus`; close cancellation uses `onOpenChange` event details. Use array values for ToggleGroup and a scalar for single-thumb Slider. Runtime UI must not import Radix primitives.
