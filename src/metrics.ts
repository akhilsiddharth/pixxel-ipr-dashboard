// Pure aggregation over an already-filtered Order[]. No DOM, no I/O.
// Denominator conventions follow 00-figures.md:
//  - pipeline rates are over the PROCESSABLE population unless noted
//  - the ambiguous-label headline is over ALL orders
//  - no order is excluded for cloud

import type { Order, Priority, Satellite } from "./types";

export const PRIORITY_ORDER: Priority[] = ["P0", "P1", "P2", "Standard", "Unknown"];
export const QC_DECIDED = new Set(["Pass", "Pass_With_Note", "Fail"]);
export const QC_PASSED = new Set(["Pass", "Pass_With_Note"]);

export const processable = (o: Order[]): Order[] => o.filter((x) => x.processable);

function pct(num: number, den: number): number {
  return den === 0 ? 0 : (num / den) * 100;
}

// ---------------------------------------------------------------------------
// funnel
// ---------------------------------------------------------------------------

export interface FunnelStep {
  label: string;
  count: number;
}

export function funnel(orders: Order[]): FunnelStep[] {
  const p = processable(orders);
  return [
    { label: "Acquired", count: p.length },
    { label: "Processed", count: p.filter((o) => o.procKind !== "defect").length },
    { label: "QC decision", count: p.filter((o) => QC_DECIDED.has(o.qcStatus)).length },
    { label: "QC passed", count: p.filter((o) => QC_PASSED.has(o.qcStatus)).length },
    { label: "Delivered", count: p.filter((o) => o.delivered).length },
    { label: "On time", count: p.filter((o) => o.metSla === true).length },
  ];
}

// ---------------------------------------------------------------------------
// on-time by priority
// ---------------------------------------------------------------------------

export interface PriorityRow {
  priority: Priority;
  orders: number;
  delivered: number;
  onTime: number;
  onTimePctOrders: number;
  onTimePctDelivered: number;
}

export interface OnTimeByPriority {
  rows: PriorityRow[];
  blendedPctOrders: number;
  totals: PriorityRow;
}

export function onTimeByPriority(orders: Order[]): OnTimeByPriority {
  const p = processable(orders);
  const rows = PRIORITY_ORDER.map((priority): PriorityRow => {
    const tier = p.filter((o) => o.priority === priority);
    const delivered = tier.filter((o) => o.delivered).length;
    const onTime = tier.filter((o) => o.metSla === true).length;
    return {
      priority,
      orders: tier.length,
      delivered,
      onTime,
      onTimePctOrders: pct(onTime, tier.length),
      onTimePctDelivered: pct(onTime, delivered),
    };
  }).filter((r) => r.orders > 0);

  const orderN = p.length;
  const deliveredN = p.filter((o) => o.delivered).length;
  const onTimeN = p.filter((o) => o.metSla === true).length;

  return {
    rows,
    blendedPctOrders: pct(onTimeN, orderN),
    totals: {
      priority: "Standard",
      orders: orderN,
      delivered: deliveredN,
      onTime: onTimeN,
      onTimePctOrders: pct(onTimeN, orderN),
      onTimePctDelivered: pct(onTimeN, deliveredN),
    },
  };
}

// ---------------------------------------------------------------------------
// WIP by stage + staleness
// ---------------------------------------------------------------------------

export type WipStageId =
  | "waiting_to_process"
  | "in_processing"
  | "waiting_for_qc"
  | "in_qc";

export interface WipStage {
  id: WipStageId;
  label: string;
  count: number;
}

export interface WipSummary {
  stages: WipStage[];
  inFlight: number;
  oldestAgeH: number | null;
  staleTotal: number;
  staleByPriority: Record<Priority, number>;
  inQcP0P1: number;
}

// Stage by the FURTHEST timestamp reached, not the first gap: some in-flight
// orders have a QA-assigned time but a missing Processing End time (a logging
// gap, not a pipeline position). An order with a QA timestamp is past QA.
export function wipStage(o: Order): WipStageId {
  if (o.tQa !== null) return "in_qc";
  if (o.tProcEnd !== null) return "waiting_for_qc";
  if (o.tTrigger !== null) return "in_processing";
  return "waiting_to_process";
}

export function wipByStage(orders: Order[]): WipSummary {
  const wip = orders.filter((o) => o.censored);
  const count = (id: WipStageId) => wip.filter((o) => wipStage(o) === id).length;
  const staleByPriority = Object.fromEntries(
    PRIORITY_ORDER.map((p) => [p, wip.filter((o) => o.stale && o.priority === p).length]),
  ) as Record<Priority, number>;
  const ages = wip.map((o) => o.ageH).filter((a): a is number => a !== null);

  return {
    stages: [
      { id: "waiting_to_process", label: "Waiting to process", count: count("waiting_to_process") },
      { id: "in_processing", label: "In processing", count: count("in_processing") },
      { id: "waiting_for_qc", label: "Waiting for QC", count: count("waiting_for_qc") },
      { id: "in_qc", label: "In QC / post-QA", count: count("in_qc") },
    ],
    inFlight: wip.length,
    oldestAgeH: ages.length ? Math.max(...ages) : null,
    staleTotal: wip.filter((o) => o.stale).length,
    staleByPriority,
    inQcP0P1: wip.filter((o) => wipStage(o) === "in_qc" && (o.priority === "P0" || o.priority === "P1")).length,
  };
}

// ---------------------------------------------------------------------------
// cohort by acquisition week
// ---------------------------------------------------------------------------

export interface CohortRow {
  week: number;
  n: number;
  deliveredPct: number;
  onTimePct: number;
  reprocessPct: number;
}

export function cohortByWeek(orders: Order[]): CohortRow[] {
  const p = processable(orders).filter((o) => o.acqIsoWeek !== null);
  const weeks = [...new Set(p.map((o) => o.acqIsoWeek as number))].sort((a, b) => a - b);
  return weeks.map((week): CohortRow => {
    const c = p.filter((o) => o.acqIsoWeek === week);
    return {
      week,
      n: c.length,
      deliveredPct: pct(c.filter((o) => o.delivered).length, c.length),
      onTimePct: pct(c.filter((o) => o.metSla === true).length, c.length),
      reprocessPct: pct(c.filter((o) => o.reprocessed).length, c.length),
    };
  });
}

// ---------------------------------------------------------------------------
// reprocessing
// ---------------------------------------------------------------------------

export interface ReprocessStats {
  base: number;
  reprocessed: number;
  ratePct: number;
  successNum: number;
  successDen: number;
  passedAttempt1: number;
}

export function reprocessing(orders: Order[]): ReprocessStats {
  const p = processable(orders);
  const re = p.filter((o) => o.reprocessed);
  return {
    base: p.length,
    reprocessed: re.length,
    ratePct: pct(re.length, p.length),
    successNum: re.filter((o) => o.reprocessSuccess).length,
    successDen: re.length,
    passedAttempt1: re.filter((o) => QC_PASSED.has(o.firstAttemptQc)).length,
  };
}

// ---------------------------------------------------------------------------
// first-pass QC yield
// ---------------------------------------------------------------------------

export interface FirstPassYield {
  num: number;
  den: number;
  pct: number;
}

export function firstPassYield(orders: Order[]): FirstPassYield {
  const p = processable(orders);
  const decided = p.filter((o) => QC_DECIDED.has(o.qcStatus));
  const num = decided.filter((o) => o.firstPassSuccess).length;
  return { num, den: decided.length, pct: pct(num, decided.length) };
}

// ---------------------------------------------------------------------------
// delivery-signal integrity
// ---------------------------------------------------------------------------

export interface IntegrityStats {
  cleanNum: number;
  base: number;
  integrityPct: number;
  ambiguousTotal: number;
  ambiguousProcessable: number;
  signalMismatch: number;
  outcomeAmbiguity: number;
}

export function deliverySignalIntegrity(orders: Order[]): IntegrityStats {
  const p = processable(orders);

  // Integrity rate = processable orders that carry NO contradictory success
  // label, over all processable. Matches 00-figures.md (~58/89 ~= 65%).
  //
  // Note: metric 5's stricter written reading — "all three signals (upload ts,
  // customer status, QC status) positively agree" over "flagged by any signal"
  // — lands near 35%, because it counts the benign customer-status lag that
  // metric 5 itself sets aside. We show the looser rate the summary/deck quote.
  const ambiguousProc = p.filter((o) => o.ambiguousSuccess).length;
  const cleanNum = p.length - ambiguousProc;

  // Ambiguous-label headline is over ALL orders, not just processable.
  const ambiguous = orders.filter((o) => o.ambiguousSuccess);
  const signalMismatch = ambiguous.filter((o) =>
    o.ambiguousReason.includes("delivery_signal_mismatch"),
  ).length;
  const outcomeAmbiguity = ambiguous.filter(
    (o) =>
      (o.ambiguousReason.includes("low_snr_accepted") &&
        !o.ambiguousReason.includes("delivery_signal_mismatch")) ||
      o.ambiguousReason.includes("qc_pass_but_processing_failed"),
  ).length;

  return {
    cleanNum,
    base: p.length,
    integrityPct: pct(cleanNum, p.length),
    ambiguousTotal: ambiguous.length,
    ambiguousProcessable: ambiguousProc,
    signalMismatch,
    outcomeAmbiguity,
  };
}

// ---------------------------------------------------------------------------
// technical cuts (BBR / satellite) — directional, small n
// ---------------------------------------------------------------------------

export interface RateCut {
  key: string;
  num: number;
  den: number;
  pct: number;
}

export function bbrBySatellite(orders: Order[]): RateCut[] {
  const p = processable(orders);
  const sats: Satellite[] = ["FF01", "FF02", "FF03"];
  return sats
    .map((s): RateCut => {
      const g = p.filter((o) => o.satellite === s);
      const num = g.filter((o) => o.bbrFlag).length;
      return { key: s, num, den: g.length, pct: pct(num, g.length) };
    })
    .filter((c) => c.den > 0);
}

export function bbrByBandset(orders: Order[]): RateCut[] {
  const p = processable(orders);
  const bands = [...new Set(p.map((o) => o.bandset))].sort();
  return bands
    .map((b): RateCut => {
      const g = p.filter((o) => o.bandset === b);
      const num = g.filter((o) => o.bbrFlag).length;
      return { key: b, num, den: g.length, pct: pct(num, g.length) };
    })
    .filter((c) => c.den > 0)
    .sort((a, b) => b.pct - a.pct);
}

export function bbrOverall(orders: Order[]): RateCut {
  const p = processable(orders);
  const num = p.filter((o) => o.bbrFlag).length;
  return { key: "overall", num, den: p.length, pct: pct(num, p.length) };
}

export interface SatelliteRow {
  satellite: Satellite;
  orders: number;
  delivered: number;
  onTimePctOrders: number;
}

export function bySatellite(orders: Order[]): SatelliteRow[] {
  const p = processable(orders);
  const sats: Satellite[] = ["FF01", "FF02", "FF03"];
  return sats
    .map((s): SatelliteRow => {
      const g = p.filter((o) => o.satellite === s);
      return {
        satellite: s,
        orders: g.length,
        delivered: g.filter((o) => o.delivered).length,
        onTimePctOrders: pct(g.filter((o) => o.metSla === true).length, g.length),
      };
    })
    .filter((r) => r.orders > 0);
}

// ---------------------------------------------------------------------------
// percentiles + processing-queue wait + end-to-end TAT
// ---------------------------------------------------------------------------

/** Linear-interpolation percentile. p in [0,100]. */
export function percentile(values: number[], p: number): number | null {
  const v = [...values].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  if (v.length === 1) return v[0] as number;
  const idx = (p / 100) * (v.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return (v[lo] as number) * (1 - frac) + (v[hi] as number) * frac;
}

export interface WaitPercentiles {
  p50: number | null;
  p80: number | null;
  p90: number | null;
  n: number;
}

function pctiles(values: number[]): WaitPercentiles {
  return {
    p50: percentile(values, 50),
    p80: percentile(values, 80),
    p90: percentile(values, 90),
    n: values.length,
  };
}

export function processingQueueWait(orders: Order[]): WaitPercentiles {
  return pctiles(
    processable(orders)
      .map((o) => o.durQueueH)
      .filter((x): x is number => x !== null),
  );
}

export function endToEndTat(orders: Order[]): WaitPercentiles {
  return pctiles(
    processable(orders)
      .filter((o) => o.delivered)
      .map((o) => o.durE2eH)
      .filter((x): x is number => x !== null),
  );
}

// ---------------------------------------------------------------------------
// processing failures + data-quality monitor
// ---------------------------------------------------------------------------

export interface ProcFailures {
  failed: number;
  base: number;
}

export function processingFailures(orders: Order[]): ProcFailures {
  const p = processable(orders);
  return { failed: p.filter((o) => o.procKind === "defect").length, base: p.length };
}

export interface DataQualityMonitor {
  qaOutOfOrder: number;
  deliveredNoUploadTs: number;
  uploadedStatusNotRefreshed: number;
}

export function dataQualityMonitor(orders: Order[]): DataQualityMonitor {
  return {
    // QA assigned before processing ended.
    qaOutOfOrder: orders.filter(
      (o) => o.tQa !== null && o.tProcEnd !== null && o.tQa < o.tProcEnd,
    ).length,
    // Customer status says Delivered but no upload timestamp.
    deliveredNoUploadTs: orders.filter(
      (o) => o.customerVisibleStatus === "Delivered" && o.tUpload === null,
    ).length,
    // Uploaded, but customer-visible status never moved to Delivered.
    uploadedStatusNotRefreshed: orders.filter(
      (o) => o.tUpload !== null && o.customerVisibleStatus !== "Delivered",
    ).length,
  };
}

// ---------------------------------------------------------------------------
// QC outcome mix (filtered set)
// ---------------------------------------------------------------------------

export interface QcOutcomeMix {
  pass: number;
  passWithNote: number;
  fail: number;
  pending: number;
  reprocessRequired: number;
}

export function qcOutcomeMix(orders: Order[]): QcOutcomeMix {
  const p = processable(orders);
  const n = (s: string) => p.filter((o) => o.qcStatus === s).length;
  return {
    pass: n("Pass"),
    passWithNote: n("Pass_With_Note"),
    fail: n("Fail"),
    pending: n("Pending"),
    reprocessRequired: p.filter((o) => o.firstAttemptQc === "Reprocess_Required").length,
  };
}

// ---------------------------------------------------------------------------
// customer success
// ---------------------------------------------------------------------------

export interface CustomerDeliveryRow {
  customer: string;
  orders: number;
  delivered: number;
  deliveredPct: number;
  hasP0: boolean;
}

export function deliveryByCustomer(orders: Order[]): CustomerDeliveryRow[] {
  const p = processable(orders);
  const customers = [...new Set(p.map((o) => o.customer))].sort();
  return customers
    .map((customer): CustomerDeliveryRow => {
      const g = p.filter((o) => o.customer === customer);
      const delivered = g.filter((o) => o.delivered).length;
      return {
        customer,
        orders: g.length,
        delivered,
        deliveredPct: pct(delivered, g.length),
        hasP0: g.some((o) => o.priority === "P0"),
      };
    })
    .sort((a, b) => a.deliveredPct - b.deliveredPct);
}

export interface NonProcessable {
  count: number;
  reasons: RateCut[];
}

export function nonProcessable(orders: Order[]): NonProcessable {
  const np = orders.filter((o) => !o.processable);
  const reasons = [...new Set(np.map((o) => o.nonProcessableReason || "unspecified"))].map(
    (r): RateCut => {
      const n = np.filter((o) => (o.nonProcessableReason || "unspecified") === r).length;
      return { key: r, num: n, den: np.length, pct: pct(n, np.length) };
    },
  );
  return { count: np.length, reasons };
}

export function cloudyCount(orders: Order[]): number {
  return orders.filter((o) => o.cloudStatus === "Cloudy").length;
}
