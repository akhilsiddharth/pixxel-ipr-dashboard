// View 4 — Customers. Who to call before they call you. Every date here is
// worked out from how long the remaining steps actually take, not the status
// field the customer sees.

import { deliveryByCustomer } from "../metrics";
import {
  exportCutoff,
  honestEtaBusinessDays,
  orderSlack,
  qcQueueRanked,
  stageP80s,
} from "../slack";
import type { Order, ViewCtx } from "../types";
import { card, days, esc, grid2, hrs, pct1, pctRows, shortPri, stack, view } from "../ui/render";

const untrustedStatus = (o: Order): boolean =>
  (o.tUpload !== null && o.customerVisibleStatus !== "Delivered") ||
  (o.customerVisibleStatus === "Delivered" && o.tUpload === null);

export function renderCs(orders: Order[], ctx: ViewCtx): string {
  const p80 = stageP80s(orders);
  const cutoff = exportCutoff(orders);
  const ranked = qcQueueRanked(orders, p80, cutoff);
  const rankOf = new Map(ranked.map((r, i) => [r.order.imageId, i]));
  const inflight = orders.filter((o) => o.censored);
  const slackOf = (o: Order): number => orderSlack(o, p80, ctx.cutoff).slackH;
  const stageOf = (o: Order): string => orderSlack(o, p80, ctx.cutoff).stage.replace(/_/g, " ");

  // ---- watchlist ----
  const watch = [...inflight]
    .filter((o) => o.priority === "P0" || o.priority === "P1")
    .sort((a, b) => (b.ageH ?? 0) - (a.ageH ?? 0));
  const lateN = watch.filter((o) => slackOf(o) <= 0).length;

  const watchRows = watch
    .slice(0, 8)
    .map((o) => {
      const late = slackOf(o) <= 0;
      const eta = late ? "~2 bd" : `~${honestEtaBusinessDays(rankOf.get(o.imageId) ?? 0)} bd`;
      return `<div class="tr hit" role="button" tabindex="0" data-open-order="${esc(o.imageId)}">
        <div class="td ${o.priority === "P0" ? "t-bad" : ""}">${esc(shortPri(o.priority))}</div>
        <div class="td mono ell">${esc(o.imageId)}</div>
        <div class="td ell dim">${esc(o.customer)}</div>
        <div class="td dim">${esc(stageOf(o))}</div>
        <div class="td al-right ${o.stale ? "t-bad" : "dim"}">${esc(days(o.ageH))}</div>
        <div class="td al-right dim">${esc(eta)}</div>
        <div class="td al-center">${
          late ? `<span class="cpill t-bad">call</span>` : `<span class="cpill">watch</span>`
        }</div>
      </div>`;
    })
    .join("");

  const watchPanel = card({
    caption: "",
    title: "Who is still waiting",
    info: {
      id: "eta",
      open: ctx.infoOpen("eta"),
      text: "The date here is built from how long the remaining steps actually take, not the status field the customer sees. The stale pile clears P0-first at ~2–3 orders/day, so ETA tracks queue rank — confirm with the QC lead before quoting a customer. When the built date and the shown status disagree, the order also appears in 'make a call today'.",
    },
    note: `${watch.length} open · ${lateN} past the date we gave`,
    body: `<div class="dtable" style="--tgrid:34px minmax(0,1fr) 96px 84px 50px 62px 58px">
      <div class="thead"><div class="th">pri</div><div class="th">order</div><div class="th">customer</div><div class="th">where it is</div><div class="th al-right">waiting</div><div class="th al-right">real eta</div><div class="th al-center">do this</div></div>
      <div class="tbody">${watchRows || `<div class="drawer-empty">No high-priority orders open.</div>`}</div>
    </div>`,
  });

  // ---- by customer ----
  const byCust = deliveryByCustomer(orders);
  const custPanel = card({
    caption: "How each account is being served",
    body: pctRows(
      byCust.map((c) => ({
        label: c.customer,
        frac: c.orders ? c.deliveredPct / 100 : 0,
        pct: c.orders ? pct1(c.deliveredPct) : "n/a",
        frac_label: `(${c.delivered}/${c.orders})`,
        tone: !c.orders ? "muted" : c.deliveredPct < 45 ? "bad" : c.deliveredPct < 68 ? "warn" : "good",
        flag: c.deliveredPct < 45 ? "!!" : c.hasP0 ? "P0" : "",
        click: { list: `cust:${c.customer}` },
      })),
      { labelWidth: "108px" },
    ),
  });

  // ---- due inside a day ----
  const dueSoon = [...inflight]
    .map((o) => ({ o, s: slackOf(o) }))
    .filter((x) => x.s > 0 && x.s <= 24)
    .sort((a, b) => a.s - b.s);
  const duePanel = card({
    caption: "Due inside a day",
    note: `${dueSoon.length} orders`,
    body: dueSoon.length
      ? `<div class="minirows">${dueSoon
          .slice(0, 6)
          .map(
            (x) => `<div class="tr hit" role="button" tabindex="0" data-open-order="${esc(x.o.imageId)}">
          <div class="td mono ell">${esc(x.o.imageId)}</div>
          <div class="td ell dim">${esc(x.o.customer)}</div>
          <div class="td al-right big t-warn">${esc(hrs(x.s))}</div>
        </div>`,
          )
          .join("")}</div>`
      : `<p class="card-lede">Nothing is due today. Everything urgent is already late — the worse version of this panel being empty.</p>`,
  });

  // ---- make a call today ----
  const needs = [...inflight]
    .filter((o) => untrustedStatus(o) || slackOf(o) <= 0)
    .sort((a, b) => slackOf(a) - slackOf(b))
    .slice(0, 6);
  const needsPanel = card({
    caption: "Make a call today",
    note: `${needs.length} orders`,
    body:
      `<p class="card-lede">The status the customer can see no longer matches what is happening.</p>` +
      `<div class="minirows">${needs
        .map(
          (o) => `<div class="tr hit" role="button" tabindex="0" data-open-order="${esc(o.imageId)}">
        <div class="td mono ell">${esc(o.imageId)}</div>
        <div class="td ell dim">${esc(o.customer)}</div>
        <div class="td al-right dim">${slackOf(o) <= 0 ? "date has passed" : "status is stale"}</div>
      </div>`,
        )
        .join("")}</div>`,
  });

  return view(watchPanel, grid2(custPanel, stack(duePanel, needsPanel)));
}
