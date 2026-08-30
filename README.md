# IPR Pipeline Dashboard

Operational dashboard for the Image Product/Processing (IPR) pipeline, built on
the cleaned June 2026 order sample. Four persona views over one shared filter
bar; every number is computed live in the browser from `orders.csv` and traces
back to the hand-vetted figures in `00-figures.md`.

**Live:** https://akhilsiddharth.github.io/pixxel-ipr-dashboard/
**Deck:** https://akhilsiddharth.github.io/pixxel-ipr-dashboard/deck.html

A reviewer needs nothing but the link. `npm install` is only for developing.

## The four views

| View | Opens the day on |
| --- | --- |
| **Lead** | what needs a decision today — P0 late, stale, in-QC, untrusted records; the action queue; funnel + on-time + cohort as background |
| **Quality** | the ranked QC queue (P0 first, then ascending SLA slack), slack buckets, today's QC outcomes, artifact watch |
| **Engineering** | outright failures, processing-queue wait, rework volume, records we cannot trust, the FF02 outlier |
| **Customers** | who to call before they call you — P0/P1 watchlist with honest ETA, delivery by account, due-inside-a-day, status ≠ reality |

Click any number to open the orders behind it. Click a row for that order's full
timeline, the slack arithmetic, and its QC history. Filters, sort, dark/light,
and the current view are all in the URL / `localStorage`.

## How the numbers are produced

`orders.csv` is the cleaned export (95 orders / 136 raw rows). The dashboard
parses it in the browser and **re-derives** the boolean flags — `delivered`,
`censored`, `stale`, `metSla`, `firstPassSuccess`, `ambiguousSuccess` — from the
primitive timestamp/status columns. `test/derivations.test.ts` asserts every
re-derived flag matches the cleaned CSV's own column for all 95 rows;
`test/metrics.test.ts` pins the aggregates to `00-figures.md`. Arithmetic
columns (`age_h`, `dur_*_h`) are trusted as cleaned input.

SLA slack (the QC queue-ranking rule) = `deadline − now − Σ p80 of the stages
not yet cleared`, where the p80s are pulled from delivered orders in the current
filtered set. Queue order is P0 first (contractual tier), then ascending slack.

"Compare to prior period" is an illustrative stub — there is only one June
sample, so the deltas are against fixed baseline values, not real history.

## Develop

```sh
npm install
npm run dev        # vite dev server on :5173
npm test           # vitest — derivations + metrics + view/selector smoke
npm run build      # tsc --noEmit && vite build  ->  dist/
npm run preview    # serve the production build
```

Node 22 (`.nvmrc`). Stack: Vite 5 + TypeScript (strict) + Vitest, PapaParse for
the CSV, no UI framework — views are string-templating functions over pure
aggregation modules (`src/metrics.ts`, `src/slack.ts`).

## Layout

```
public/orders.csv        cleaned export, fetched at runtime
public/deck.html         the standalone deck, served verbatim at /deck.html
src/parse.ts             CSV -> Order[], flag re-derivation
src/metrics.ts           pure aggregation (funnel, on-time, WIP, BBR, ...)
src/slack.ts             SLA-slack queue ranking
src/selectors.ts         drill-down list registry + per-order detail
src/views/*.ts           the four persona views
src/ui/render.ts         component vocabulary (cards, meters, tables)
src/ui/drawer.ts         the order / list slide-over
src/main.ts              state, URL sync, event delegation, sidebar + filter bar
```

## Deploy

Push to `main` → `.github/workflows/deploy.yml` runs `npm ci && npm test &&
npm run build` and publishes `dist/` to GitHub Pages. The production base path
is `/pixxel-ipr-dashboard/` (set in `vite.config.ts`); dev uses `/`.
