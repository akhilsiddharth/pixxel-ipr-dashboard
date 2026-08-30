// View 2 — Quality. The ranked queue to work top-down, plus slack buckets,
// today's QC outcomes, and the artifact watch.

import {
  bbrByBandset,
  bbrBySatellite,
  bbrOverall,
  firstPassYield,
  qcOutcomeMix,
} from "../metrics";
import {
  exportCutoff,
  qcQueueRanked,
  slackBuckets,
  stageP80s,
  type RankedOrder,
} from "../slack";
import type { Order, ViewCtx } from "../types";
import {
  card,
  cellPill,
  dataTable,
  esc,
  grid2,
  hrs,
  pct1,
  pctRows,
  shortPri,
  statGrid,
  track,
  view,
} from "../ui/render";

const SORTABLE = new Set(["slack", "pri", "age", "sla", "bandset", "id"]);
const PRANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, Standard: 3, Unknown: 4 };

function sortQueue(ranked: RankedOrder[], key: string, dir: 1 | -1): RankedOrder[] {
  if (!SORTABLE.has(key)) return ranked;
  const q = [...ranked];
  if (key === "slack") {
    return q.sort(
      (a, b) =>
        (a.order.priority === "P0" ? 0 : 1) - (b.order.priority === "P0" ? 0 : 1) ||
        (a.slackH - b.slackH) * dir,
    );
  }
  const val: Record<string, (r: RankedOrder) => number | string> = {
    pri: (r) => PRANK[r.order.priority] ?? 9,
    age: (r) => -(r.ageH ?? 0),
    sla: (r) => r.order.slaHours,
    bandset: (r) => r.order.bandset,
    id: (r) => r.order.imageId,
  };
  const f = val[key]!;
  return q.sort((a, b) => {
    const av = f(a);
    const bv = f(b);
    return (typeof av === "string" ? av.localeCompare(bv as string) : av - (bv as number)) * dir;
  });
}

export function renderQaQc(orders: Order[], ctx: ViewCtx): string {
  const p80 = stageP80s(orders);
  const cutoff = exportCutoff(orders);
  const ranked = qcQueueRanked(orders, p80, cutoff);
  const shown = sortQueue(ranked, ctx.sortKey, ctx.sortDir).slice(0, 14);
  const buckets = slackBuckets(ranked);
  const inflightN = ranked.length;

  const sort = { key: ctx.sortKey, dir: ctx.sortDir };
  const queueRows = shown.map((r, i) => {
    const s = r.slackH;
    const state =
      s <= 0
        ? cellPill("late", "bad")
        : s < 6
          ? cellPill("today", "warn")
          : cellPill("ok", "");
    return {
      cells: [
        `<span class="dim">${i + 1}</span>`,
        `<span class="big ${s <= 0 ? "t-bad" : s < 6 ? "t-warn" : "t-good"}">${esc(hrs(s))}</span>`,
        `<span class="${r.order.priority === "P0" ? "t-bad" : ""}">${esc(shortPri(r.order.priority))}</span>`,
        `<span class="mono ell">${esc(r.order.imageId)}</span>`,
        `<span class="dim">${esc(r.ageH === null ? "–" : hrs(r.ageH))}</span>`,
        `<span class="dim">${esc(r.order.slaHours)}h</span>`,
        `<span class="dim mono ell">${esc(r.order.bandset)}</span>`,
        state,
      ],
      tone: r.order.priority === "P0" ? ("bad" as const) : ("" as const),
      click: { order: r.order.imageId },
    };
  });

  const queuePanel = card({
    caption: "",
    title: "Work this top down",
    note: `showing ${shown.length} of ${inflightN} in the queue`,
    info: {
      id: "queue",
      open: ctx.infoOpen("queue"),
      text: "Top priority first, always. Everything else is ranked by how much time is left before the promised date, so a newer order can jump ahead of an older one if it is closer to breaking. Arrival order is deliberately ignored. Slack = deadline − now − Σ p80 of the stages not yet cleared.",
    },
    body: dataTable(
      [
        { key: "rank", label: "#", align: "left", width: "30px" },
        { key: "slack", label: "time left", align: "right", sortable: true, width: "72px" },
        { key: "pri", label: "pri", align: "left", sortable: true, width: "40px" },
        { key: "id", label: "order", align: "left", sortable: true, grow: true },
        { key: "age", label: "waiting", align: "right", sortable: true, width: "58px" },
        { key: "sla", label: "promise", align: "right", sortable: true, width: "56px" },
        { key: "bandset", label: "bandset", align: "left", sortable: true, width: "96px" },
        { key: "state", label: "", align: "center", width: "60px" },
      ],
      queueRows,
      sort,
    ),
  });

  // ---- slack buckets ----
  const bDefs: { key: string; label: string; n: number; tone: "bad" | "warn" | "good" }[] = [
    { key: "breach", label: "No time left", n: buckets.breach, tone: "bad" },
    { key: "at-risk", label: "Runs out today", n: buckets.atRisk, tone: "warn" },
    { key: "safe", label: "Room to spare", n: buckets.safe, tone: "good" },
  ];
  const bucketPanel = card({
    caption: "Time left before the promise breaks",
    info: {
      id: "slack",
      open: ctx.infoOpen("slack"),
      text: "Time left is the promised date, minus now, minus how long the remaining steps usually take (their p80). Recalculated every morning from timestamps already in the export. The current pile is entirely past deadline — it clears on the stale-backlog push, then this ranking governs new orders entering.",
    },
    body: bDefs
      .map(
        (b) => `<div class="brow t-${b.tone} hit" role="button" tabindex="0" data-open-list="bucket:${b.key}">
        <span class="brow-label">${esc(b.label)}</span>
        ${track(inflightN ? b.n / inflightN : 0, b.tone)}
        <span class="brow-n t-${b.tone}">${b.n}</span>
      </div>`,
      )
      .join(""),
  });

  // ---- QC outcomes ----
  const mix = qcOutcomeMix(orders);
  const fpy = firstPassYield(orders);
  const outcomePanel = card({
    caption: "Today's QC outcomes",
    sample: true,
    body:
      statGrid(
        [
          { value: String(mix.pass), label: "passed", tone: "good", click: { list: "qc-outcome:pass" } },
          { value: String(mix.passWithNote), label: "passed with a note", tone: "warn", click: { list: "qc-outcome:note" } },
          { value: String(mix.fail), label: "failed", tone: "bad", click: { list: "qc-outcome:fail" } },
          {
            value: String(mix.reprocessRequired),
            label: "going back through",
            tone: "bad",
            click: { list: "qc-outcome:reprocess" },
          },
        ],
        2,
      ) +
      `<div class="kv-line"><span>Passed on the first look</span><span class="mono">${pct1(
        fpy.pct,
      )} of ${fpy.den}</span></div>`,
  });

  // ---- BBR ----
  const bySat = bbrBySatellite(orders);
  const byBand = bbrByBandset(orders);
  const overall = bbrOverall(orders);
  const bbrMax = Math.max(1, ...bySat.map((c) => c.pct), ...byBand.map((c) => c.pct));
  const bbrPanel = card({
    caption: "Artifacts, who is producing them",
    span: 2,
    note: "small numbers — a lead to follow, not a verdict",
    body:
      `<div class="bbr-cols">
        <div><div class="mini-cap">by satellite</div>${pctRows(
          bySat.map((c) => ({
            label: c.key,
            frac: c.pct / bbrMax,
            pct: pct1(c.pct),
            frac_label: `${c.num}/${c.den}`,
            tone: c.key === "FF02" ? "warn" : "accent",
          })),
          { labelWidth: "52px" },
        )}</div>
        <div><div class="mini-cap">by bandset</div>${pctRows(
          byBand.map((c) => ({
            label: c.key,
            frac: c.pct / bbrMax,
            pct: pct1(c.pct),
            frac_label: `${c.num}/${c.den}`,
            tone: c.pct >= 20 ? "warn" : "accent",
          })),
          { labelWidth: "104px" },
        )}</div>
      </div>
      <div class="kv-line"><span>Overall</span><span class="mono">${overall.num}/${overall.den} = ${pct1(
        overall.pct,
      )}</span></div>`,
  });

  return view(queuePanel, grid2(bucketPanel, outcomePanel), bbrPanel);
}
