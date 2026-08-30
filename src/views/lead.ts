// View 1 — Lead. "What needs a decision today." KPI strip + action queue up
// top; funnel / on-time / cohort are background, below the rule.

import {
  cohortByWeek,
  funnel,
  onTimeByPriority,
  processable,
  reprocessing,
  wipByStage,
  wipStage,
} from "../metrics";
import { orderSlack, stageP80s } from "../slack";
import type { Order, Priority, ViewCtx } from "../types";
import {
  barMeterRows,
  card,
  days,
  driverRows,
  edgeRows,
  esc,
  grid2,
  hrs,
  kpiStrip,
  pct1,
  pctRows,
  sectionRule,
  shortPri,
  view,
} from "../ui/render";

// Illustrative "prior sample" figures for the compare stub. Not real history —
// there is only one June sample — so the toggle is labelled as illustrative.
const PRIOR = { p0Late: 9, stale: 23, inQc: 21, untrusted: 40 };

const untrusted = (o: Order): boolean =>
  (o.tUpload !== null && o.customerVisibleStatus !== "Delivered") ||
  (o.customerVisibleStatus === "Delivered" && o.tUpload === null) ||
  (o.tQa !== null && o.tProcEnd !== null && o.tQa < o.tProcEnd);

export function renderLead(orders: Order[], ctx: ViewCtx): string {
  const p = processable(orders);
  const p80 = stageP80s(orders);
  const wip = wipByStage(orders);
  const inflight = orders.filter((o) => o.censored);
  const slackOf = (o: Order): number => orderSlack(o, p80, ctx.cutoff).slackH;
  const stageOf = (o: Order): string => orderSlack(o, p80, ctx.cutoff).stage.replace(/_/g, " ");

  const p0Late = inflight.filter((o) => o.priority === "P0" && slackOf(o) <= 0).length;
  const staleN = wip.staleTotal;
  const inQcN = wip.stages.find((s) => s.id === "in_qc")?.count ?? 0;
  const untrustedN = orders.filter(untrusted).length;

  const delta = (cur: number, prev: number): { delta: string; deltaTone: "good" | "bad" | "muted" } => {
    if (!ctx.compare) return { delta: "", deltaTone: "muted" };
    const d = cur - prev;
    return { delta: d === 0 ? "same" : d > 0 ? `+${d}` : `${d}`, deltaTone: d <= 0 ? "good" : "bad" };
  };

  const kpis = kpiStrip([
      {
        label: "top priority, late",
        value: p0Late,
        note: `of ${inflight.filter((o) => o.priority === "P0").length} open P0. None of this window's P0 orders arrived on time.`,
        tone: "bad",
        listKey: "p0-late",
        ...delta(p0Late, PRIOR.p0Late),
      },
      {
        label: "stale",
        value: staleN,
        note: "no movement in 2× the promised time",
        tone: "bad",
        listKey: "stale",
        ...delta(staleN, PRIOR.stale),
      },
      {
        label: "in qc",
        value: inQcN,
        note: inQcN
          ? `oldest has waited ${days(wip.oldestAgeH)}`
          : "queue is empty",
        tone: "warn",
        listKey: "in-qc",
        ...delta(inQcN, PRIOR.inQc),
      },
      {
        label: "records we cannot trust",
        value: untrustedN,
        note: "status does not match what happened",
        tone: "warn",
        listKey: "untrusted",
        ...delta(untrustedN, PRIOR.untrusted),
      },
    ]);

  // ---- action queue ----
  const actionOrders = [...inflight]
    .filter((o) => o.priority === "P0" || slackOf(o) <= 0 || o.stale)
    .sort(
      (a, b) =>
        (a.priority === "P0" ? 0 : 1) - (b.priority === "P0" ? 0 : 1) ||
        slackOf(a) - slackOf(b),
    );
  const actionRows = actionOrders
    .slice(0, 8)
    .map((o) => {
      const s = slackOf(o);
      const slackTone = s <= 0 ? "t-bad" : s < 6 ? "t-warn" : "";
      return `<div class="tr hit" role="button" tabindex="0" data-open-order="${esc(o.imageId)}">
        <div class="td ${o.priority === "P0" ? "t-bad" : ""}">${esc(shortPri(o.priority))}</div>
        <div class="td mono ell">${esc(o.imageId)}</div>
        <div class="td ell dim">${esc(o.customer)}</div>
        <div class="td dim">${esc(stageOf(o))}</div>
        <div class="td al-right big ${slackTone}">${esc(hrs(s))}</div>
        <div class="td al-right dim">${esc(days(o.ageH))}</div>
      </div>`;
    })
    .join("");

  const actionPanel = card({
    caption: "",
    title: "Needs a decision today",
    tone: "bad",
    note: `${actionOrders.length} orders · showing ${Math.min(8, actionOrders.length)}`,
    body: `<p class="card-lede">Top priority first, then whatever has least time left. Click any row to see where it has been.</p>
      <div class="dtable" style="--tgrid:38px minmax(0,1fr) 108px 92px 74px 54px">
        <div class="thead"><div class="th">pri</div><div class="th">order</div><div class="th">customer</div><div class="th">where it is</div><div class="th al-right">time left</div><div class="th al-right">waiting</div></div>
        <div class="tbody">${actionRows || `<div class="drawer-empty">Nothing needs a decision.</div>`}</div>
      </div>
      <div class="card-cta">
        <button type="button" class="btn primary" data-goto="qaqc">Open the full queue</button>
        <button type="button" class="btn" data-open-list="stale">See everything stale</button>
      </div>`,
  });

  // ---- where work is sitting ----
  const wipPanel = card({
    caption: "Where work is sitting",
    body: edgeRows(
      wip.stages.map((s) => {
        const g = inflight.filter((o) => wipStage(o) === s.id);
        const oldest = g.length ? Math.max(...g.map((o) => o.ageH ?? 0)) : 0;
        return {
          label: s.label,
          value: String(s.count),
          note: s.count ? `oldest ${days(oldest)}` : "empty",
          tone: s.count === 0 ? "muted" : oldest > 120 ? "bad" : oldest > 48 ? "warn" : "accent",
          click: { list: `wip:${s.id}` },
        };
      }),
    ),
  });

  // ---- drivers ----
  const r = reprocessing(orders);
  const ff02 = p.filter((o) => o.satellite === "FF02");
  const driversPanel = card({
    caption: "What is driving the risk",
    info: {
      id: "drivers",
      open: ctx.infoOpen("drivers"),
      text: "These three explain most of the delay. Rework and untrustworthy records are ours to fix. The satellite pattern is a lead worth investigating, not a conclusion.",
    },
    body: driverRows([
      {
        label: "Orders run more than once",
        note: `${r.passedAttempt1} of them had already passed the first time`,
        value: pct1(r.ratePct),
        tone: "warn",
        click: { list: "driver:reprocess" },
      },
      {
        label: "Records that disagree with reality",
        note: "the status the team reads is not the status that happened",
        value: String(untrustedN),
        tone: "warn",
        click: { list: "driver:untrusted" },
      },
      {
        label: "FF02 artifacts",
        note: "roughly double the other two satellites",
        value: pct1(ff02.length ? (ff02.filter((o) => o.bbrFlag).length / ff02.length) * 100 : 0),
        tone: "warn",
        click: { list: "driver:ff02-bbr" },
      },
    ]),
  });

  // ---- funnel ----
  const steps = funnel(orders);
  const acquired = steps[0]?.count ?? 0;
  const funnelKeys = ["acquired", "processed", "qc-decision", "qc-passed", "delivered", "on-time"];
  const funnelPanel = card({
    caption: "Where orders fall out",
    body: barMeterRows(
      steps.map((s, i) => ({
        label: s.label,
        value: String(s.count),
        frac: acquired ? s.count / acquired : 0,
        tone: i < 3 ? "accent" : i === steps.length - 1 && s.count / acquired < 0.7 ? "warn" : "good",
        trailing: i === 0 ? "" : `-${(steps[i - 1]?.count ?? 0) - s.count}`,
        click: { list: `funnel:${funnelKeys[i]}` },
      })),
    ),
  });

  // ---- on-time by priority ----
  const otp = onTimeByPriority(orders);
  const onTimePanel = card({
    caption: "Deadlines met, by priority",
    info: {
      id: "ontime",
      open: ctx.infoOpen("ontime"),
      text: `Measured against every order that came in, not only the ones we sent. Delivered-only would read ${pct1(
        otp.totals.onTimePctDelivered,
      )} and hide the P0 result. Blended across all orders is ${pct1(
        otp.blendedPctOrders,
      )} — shown struck through on purpose; the priority split is the metric.`,
    },
    body: pctRows(
      otp.rows.map((row) => {
        const f = row.orders ? row.onTimePctOrders / 100 : 0;
        return {
          label: labelPri(row.priority),
          frac: f,
          pct: row.orders ? pct1(row.onTimePctOrders) : "n/a",
          frac_label: `(${row.onTime}/${row.orders})`,
          tone: !row.orders ? "muted" : row.onTimePctOrders >= 70 ? "good" : row.onTimePctOrders <= 20 ? "bad" : "warn",
          flag: row.orders && row.onTimePctOrders <= 20 ? "!!" : "",
          click: { list: `ontime:${row.priority}` },
        };
      }),
    ),
  });

  // ---- cohort ----
  const cohort = cohortByWeek(orders);
  const cohortPanel = card({
    caption: "Is it getting better",
    span: 2,
    info: {
      id: "cohort",
      open: ctx.infoOpen("cohort"),
      text: "Each block follows the orders acquired in that week for their whole life, so a week can still change after it ends. Recent weeks look incomplete because some of those orders are still moving.",
    },
    body: `<div class="cohort-grid">${cohort
      .map((c) => {
        const flag =
          c.reprocessPct >= 33 ? "more rework" : c.onTimePct < 45 ? "worst week" : "";
        const row = (l: string, v: string, t: string): string =>
          `<div class="co-row"><span>${l}</span><span class="mono ${t}">${v}</span></div>`;
        return `<div class="cohort-block">
          <div class="co-head"><span class="mono">W${c.week}</span><span class="mono t-warn">${flag}</span></div>
          ${row("delivered", pct1(c.deliveredPct), "")}
          ${row("on time", pct1(c.onTimePct), c.onTimePct >= 70 ? "t-good" : c.onTimePct < 45 ? "t-bad" : "t-warn")}
          ${row("run again", pct1(c.reprocessPct), c.reprocessPct >= 33 ? "t-warn" : "")}
        </div>`;
      })
      .join("")}</div>`,
  });

  return view(
    kpis,
    actionPanel,
    grid2(wipPanel, driversPanel),
    sectionRule("Background, not for this morning"),
    grid2(funnelPanel, onTimePanel),
    cohortPanel,
  );
}

function labelPri(p: Priority): string {
  return p === "Unknown" ? "no tag" : p === "Standard" ? "Std" : p;
}
