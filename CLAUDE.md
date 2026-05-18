# Archetype AI Design System

## Stack

- Svelte 5 with runes (`$props`, `$state`, `$derived`, `$bindable`)
- Tailwind v4 with semantic tokens (`@archetypeai/ds-lib-tokens`)
- shadcn-svelte registry pattern (via `@archetypeai/ds-cli`)
- bits-ui for headless primitives
- layerchart for data visualization

## Commands

- `npx @archetypeai/ds-cli add ds-ui-svelte` - install all components
- `npx shadcn-svelte@latest add <url>` - install individual component

## Tokens

Prefer semantic tokens for themed colors:

- `bg-background`, `text-foreground`, `border-border`
- `bg-primary`, `text-primary-foreground`
- `bg-muted`, `text-muted-foreground`
- `bg-card`, `bg-popover`, `bg-accent`, `bg-destructive`
- `bg-atai-neutral`, `text-atai-good`, `text-atai-warning`, `text-atai-critical`
- etc.

Standard Tailwind is fine for:

- Spacing/sizing: `p-4`, `w-full`, `gap-2`, `h-screen`
- Layout: `flex`, `grid`, `absolute`, `relative`

## CSS Import Order

```css
@import '@archetypeai/ds-lib-tokens/fonts.css';
@import '@archetypeai/ds-lib-tokens/theme.css';
@import 'tailwindcss';
```

## Component Patterns

- **Props**: `let { class: className, ref = $bindable(null), children, ...restProps } = $props();`
- **Classes**: `cn()` from `$lib/utils.js` - never raw concatenation
- **Variants**: `tailwind-variants` (tv) for component variants
- **Slots**: `{@render children?.()}`

## Pattern Registry

Before building a new component, fetch the pattern catalog from:
`https://design-system.archetypeai.workers.dev/r/patterns.json`

Each entry includes a `name`, `title`, `description`, and `registryDependencies`. Reuse or extend existing patterns instead of rebuilding from scratch.

Before installing, check if the pattern already exists locally in `$lib/components/ui/patterns/{name}/`. Only install if it is missing:
`npx shadcn-svelte@latest add https://design-system.archetypeai.workers.dev/r/{name}.json`

## Skills

**Skill composition:** When building a demo that uses a Newton or Embedding API skill:
1. Use `@skills/create-dashboard` for the page layout (dashboard with Menubar)
2. Fetch `https://design-system.archetypeai.workers.dev/r/patterns.json` and reuse existing patterns before creating new components
3. Apply `@rules/design-principles` aesthetic conventions (BackgroundCard for single-purpose cards, mono font for headers/numbers)
4. Only include chart components if the user's request involves time-series or explicitly mentions charts

Read these when relevant to your task:

- `@skills/apply-ds` - apply DS tokens, components, and patterns to an existing demo
- `@skills/build-pattern` - create composite patterns from primitives
- `@skills/setup-chart` - set up charts with layerchart
- `@skills/create-dashboard` - scaffold a full-viewport dashboard with menubar and panels
- `@skills/fix-accessibility` - audit and fix a11y issues
- `@skills/fix-metadata` - update page titles, favicons, and OG tags
- `@skills/deploy-worker` - deploy SvelteKit projects to Cloudflare Workers
- `@skills/embedding-from-file` - run an Embedding Lens by streaming sensor data from a CSV file
- `@skills/embedding-from-sensor` - run an Embedding Lens by streaming real-time data from a physical sensor
- `@skills/embedding-upload` - run an Embedding Lens by uploading a CSV file for server-side processing
- `@skills/newton-activity-monitor-lens-on-video` - analyze uploaded video files using Newton's activity monitor lens
- `@skills/newton-camera-frame-analysis` - live webcam frame analysis using Newton's vision model
- `@skills/newton-direct-query` - simple direct query to Newton model using the /query API endpoint
- `@skills/newton-machine-state-from-file` - run a Machine State Lens by streaming sensor data from a CSV file
- `@skills/newton-machine-state-from-sensor` - run a Machine State Lens by streaming real-time data from a physical sensor
- `@skills/newton-machine-state-upload` - run a Machine State Lens by uploading a CSV file for server-side processing

## Rules

See `@rules/` for comprehensive guidance on design principles, components, styling, charts, and linting.

- `@rules/accessibility` — a11y guidelines and ARIA patterns
- `@rules/charts` — chart setup, layerchart conventions, data visualization
- `@rules/components` — component API patterns, props, variants, slots
- `@rules/design-principles` — visual design language, spacing, typography
- `@rules/frontend-architecture` — component decomposition, page composition, API logic extraction
- `@rules/linting` — linting and formatting rules
- `@rules/state` — state management with Svelte 5 runes
- `@rules/styling` — Tailwind v4, semantic tokens, theming
