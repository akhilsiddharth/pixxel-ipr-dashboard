// The right-side slide-over. Two kinds: a single order's full history, or a
// filtered list of orders behind a number. Pure render — main.ts owns the
// open/close state and event delegation.

import { orderDetail, resolveList, type SelCtx } from "../selectors";
import { orderSlack } from "../slack";
import type { DrawerState, Order } from "../types";
import { days, esc, hrs, shortPri } from "./render";

export interface DrawerViewState {
  slackMathOpen: boolean;
  rawOpen: boolean;
}

export function renderDrawer(
  drawer: DrawerState | null,
  orders: Order[],
  filtered: Order[],
  ctx: SelCtx,
  vs: DrawerViewState,
): string {
  if (!drawer) return "";
  const body =
    drawer.kind === "order"
      ? orderPanel(orders.find((o) => o.imageId === drawer.imageId), ctx, vs)
      : listPanel(drawer.sourceKey, filtered, ctx);
  return `<div class="drawer-scrim" data-drawer-close></div>${body}`;
}

function closeBtn(): string {
  return `<button type="button" class="drawer-close" data-drawer-close>close</button>`;
}

// ---- list ----------------------------------------------------------------

function listPanel(key: string, filtered: Order[], ctx: SelCtx): string {
  const src = resolveList(key, filtered, ctx);
  if (!src) return `<aside class="drawer"><div class="drawer-head"><div class="drawer-title">Nothing to show</div>${closeBtn()}</div></aside>`;

  const rows = src.orders
    .map((o) => {
      const age = o.ageH ?? o.durE2eH;
      const where = o.delivered ? "delivered" : o.censored ? orderSlack(o, ctx.p80, ctx.cutoff).stage.replace(/_/g, " ") : "—";
      return `<div class="tr hit" role="button" tabindex="0" data-open-order="${esc(o.imageId)}">
        <div class="td ${o.priority === "P0" ? "t-bad" : ""}">${esc(shortPri(o.priority))}</div>
        <div class="td mono ell">${esc(o.imageId)}</div>
        <div class="td ell">${esc(o.customer)}</div>
        <div class="td al-right">${esc(hrs(age))}</div>
        <div class="td al-right dim">${esc(where)}</div>
      </div>`;
    })
    .join("");

  return `<aside class="drawer drawer-list">
    <div class="drawer-head">
      <div><div class="drawer-title">${esc(src.title)}</div><div class="drawer-sub">${esc(src.sub)}</div></div>
      ${closeBtn()}
    </div>
    <div class="dtable list" style="--tgrid:34px minmax(0,1fr) 92px 58px 72px">
      <div class="thead"><div class="th">pri</div><div class="th">order</div><div class="th">customer</div><div class="th al-right">waiting</div><div class="th al-right">where</div></div>
      <div class="tbody">${rows || `<div class="drawer-empty">No orders match.</div>`}</div>
    </div>
  </aside>`;
}

// ---- order --------------------------------------------------------------

function orderPanel(o: Order | undefined, ctx: SelCtx, vs: DrawerViewState): string {
  if (!o) return `<aside class="drawer"><div class="drawer-head"><div class="drawer-title">Order not found</div>${closeBtn()}</div></aside>`;
  const d = orderDetail(o, ctx);

  const stats = `<div class="stat-grid cols-3">${d.stats
    .map(
      (s) => `<div class="stat"><div class="stat-v t-${s.tone || "muted"}">${esc(
        s.value,
      )}</div><div class="stat-l">${esc(s.label)}</div></div>`,
    )
    .join("")}</div>`;

  const timeline = d.timeline
    .map(
      (t) => `<div class="tl-row">
      <span class="tl-dot t-${t.tone || "muted"}"></span>
      <span class="tl-stage">${esc(t.stage)}</span>
      <span class="tl-ts">${esc(t.ts)}</span>
    </div>`,
    )
    .join("");

  const qc = d.qcHistory
    .map(
      (q) => `<div class="qc-row">
      <span class="qc-attempt">${esc(q.attempt)}</span>
      <span class="qc-status t-${q.tone || "muted"}">${esc(q.status)}</span>
    </div>`,
    )
    .join("");

  const slackMath = `<div class="fold">
    <button type="button" class="fold-btn${vs.slackMathOpen ? " on" : ""}" data-detail="slackMath" aria-expanded="${vs.slackMathOpen}"><span class="i-dot">i</span><span>how the time left was worked out</span></button>
    ${vs.slackMathOpen ? `<div class="fold-body mono">${esc(d.slackMath)}</div>` : ""}
  </div>`;

  const raw = `<div class="fold">
    <button type="button" class="fold-btn${vs.rawOpen ? " on" : ""}" data-detail="raw" aria-expanded="${vs.rawOpen}"><span class="i-dot">i</span><span>the stored record</span></button>
    ${vs.rawOpen ? `<div class="fold-body mono break">${esc(d.rawRow)}</div>` : ""}
  </div>`;

  return `<aside class="drawer drawer-order">
    <div class="drawer-head">
      <div class="drawer-id">
        <div class="mono drawer-title">${esc(d.imageId)}</div>
        <div class="drawer-tags">
          <span class="cpill${d.priority === "P0" ? " t-bad" : ""}">${esc(shortPri(d.priority))}</span>
          <span class="cpill t-${d.stateTone || "muted"}">${esc(d.stateLabel)}</span>
          <span class="dim">${esc(d.customer)} · ${esc(d.bandset)}</span>
        </div>
      </div>
      ${closeBtn()}
    </div>

    ${stats}

    <div class="drawer-cap">Where it has been</div>
    <div class="tl">${timeline}</div>

    ${slackMath}

    <div class="drawer-cap">Every look it has had</div>
    <div class="qc-hist">${qc}</div>

    ${raw}

    <div class="drawer-actions">
      <button type="button" class="btn" disabled>Move up the queue</button>
      <button type="button" class="btn" disabled>Tell the customer</button>
      <button type="button" class="btn" disabled>Run it again</button>
    </div>
    <div class="drawer-foot">Age is real elapsed time, not system status${
      d.inFlight ? ` · oldest look ${days(o.ageH)} ago` : ""
    }. Actions are illustrative — not wired in this sample build.</div>
  </aside>`;
}
