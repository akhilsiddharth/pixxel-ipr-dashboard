// View 3 — Engineering. Where the pipeline loses time: outright failures are
// rare, the cost is queue wait and rework. FF02 is the outlier.

import {
  dataQualityMonitor,
  percentile,
  processable,
  processingFailures,
  processingQueueWait,
  reprocessing,
} from "../metrics";
import { failStageBuckets } from "../selectors";
import type { Order, ViewCtx } from "../types";
import {
  card,
  edgeRows,
  esc,
  grid2,
  pct1,
  round,
  statGrid,
  track,
  view,
} from "../ui/render";

export function renderEng(orders: Order[], _ctx: ViewCtx): string {
  const p = processable(orders);
  const pf = processingFailures(orders);
  const wait = processingQueueWait(orders);
  const r = reprocessing(orders);
  const dq = dataQualityMonitor(orders);

  // ---- failures ----
  const stages = failStageBuckets(orders);
  const failMax = Math.max(1, ...stages.map((s) => s.orders.length));
  const failPanel = card({
    caption: "Runs that failed outright",
    sample: true,
    body:
      `<div class="big-stat"><span class="big-n">${pf.failed}</span><span class="big-note">of ${pf.base} orders. The pipeline is not the problem.</span></div>` +
      stages
        .map(
          (s) => `<div class="mrow hit" role="button" tabindex="0" data-open-list="failstage:${esc(s.key)}">
        <span class="mrow-label mono">${esc(s.key)}</span>
        <span class="mrow-n">${s.orders.length}</span>
        ${track(s.orders.length / failMax, "warn")}
        <span class="mrow-trail"></span>
      </div>`,
        )
        .join(""),
  });

  // ---- queue wait ----
  const waitRows = [
    { label: "typical order", v: wait.p50 },
    { label: "slowest 1 in 5", v: wait.p80 },
    { label: "slowest 1 in 10", v: wait.p90 },
  ];
  const waitMax = Math.max(1, ...waitRows.map((w) => w.v ?? 0));
  const waitPanel = card({
    caption: "Waiting to start processing",
    note: "the slow tail swallows a 12h promise",
    body: waitRows
      .map(
        (w) => `<div class="mrow">
        <span class="mrow-label">${esc(w.label)}</span>
        <span class="mrow-n ${(w.v ?? 0) >= 16 ? "t-warn" : ""}">${round(w.v, 1)}h</span>
        ${track((w.v ?? 0) / waitMax, (w.v ?? 0) >= 16 ? "warn" : "accent")}
        <span class="mrow-trail"></span>
      </div>`,
      )
      .join(""),
  });

  // ---- rework ----
  const reworkPanel = card({
    caption: "Work done twice",
    body:
      edgeRows([
        {
          label: "Ran more than once",
          value: String(r.reprocessed),
          note: `${pct1(r.ratePct)} of all orders`,
          tone: "warn",
          click: { list: "reproc:ran" },
        },
        {
          label: "Second run worked",
          value: String(r.successNum),
          note: `of ${r.successDen}`,
          tone: "good",
          click: { list: "reproc:ok" },
        },
        {
          label: "First run had already passed",
          value: String(r.passedAttempt1),
          note: `of ${r.reprocessed}`,
          tone: "bad",
          click: { list: "reproc:a1pass" },
        },
      ]) +
      `<div class="note-box t-warn">${r.passedAttempt1} of the ${r.reprocessed} orders we ran again had already passed the first time. That is work we chose, not work we needed — find the cause before adding capacity.</div>`,
  });

  // ---- data quality ----
  const dqPanel = card({
    caption: "Records we cannot trust",
    body: edgeRows([
      {
        label: "Marked reviewed before the step finished",
        value: String(dq.qaOutOfOrder),
        note: "qc time set before processing-end time",
        tone: "warn",
        click: { list: "dq:ooo" },
      },
      {
        label: "Sent, but no record of the upload",
        value: String(dq.deliveredNoUploadTs),
        note: "status = Delivered, upload timestamp empty",
        tone: "bad",
        click: { list: "dq:noupload" },
      },
      {
        label: "Uploaded, but the status never moved",
        value: String(dq.uploadedStatusNotRefreshed),
        note: "upload timestamp later than status",
        tone: "warn",
        click: { list: "dq:stale" },
      },
    ]),
  });

  // ---- FF02 ----
  const ff02 = p.filter((o) => o.satellite === "FF02");
  const ff03 = p.filter((o) => o.satellite === "FF03");
  const otRate = (g: Order[]): number =>
    g.length ? (g.filter((o) => o.metSla === true).length / g.length) * 100 : 0;
  const ff02Bbr = bbrRate(orders, "FF02");
  const ff02Reproc = ff02.length
    ? (ff02.filter((o) => o.reprocessed).length / ff02.length) * 100
    : 0;
  const ff02Tail =
    percentile(
      ff02.map((o) => o.durQueueH).filter((x): x is number => x !== null),
      80,
    ) ?? 0;

  const ff02Panel = card({
    caption: "FF02 is the outlier",
    tone: "warn",
    edge: "left",
    span: 2,
    note: "same window, same bandsets, worse numbers",
    body: statGrid(
      [
        { value: pct1(otRate(ff02)), label: `on time — FF03 manages ${pct1(otRate(ff03))}`, tone: otRate(ff02) < 50 ? "bad" : "warn" },
        { value: pct1(ff02Bbr), label: "artifacts — others sit at 10–12%", tone: "warn" },
        { value: pct1(ff02Reproc), label: `run twice — ${ff02.length} orders this window`, tone: "" },
        { value: `${round(ff02Tail, 1)}h`, label: "slow tail of waiting — the bird, or the queue behind it?", tone: "" },
      ],
      4,
    ),
  });

  return view(
    grid2(failPanel, waitPanel),
    grid2(reworkPanel, dqPanel),
    ff02Panel,
  );
}

/** One satellite's BBR rate as a percentage of its processable orders. */
function bbrRate(orders: Order[], sat: string): number {
  const g = processable(orders).filter((o) => o.satellite === sat);
  return g.length ? (g.filter((o) => o.bbrFlag).length / g.length) * 100 : 0;
}
