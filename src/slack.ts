// SLA slack — the QC queue-ranking rule (deliverable 4), not a daily metric.
//
//   projected_slack_h = delivery_deadline - now - expected_remaining_h
//   expected_remaining_h = sum of p80 durations of the stages not yet cleared
//
// Queue order: P0 first (ascending slack within P0), then everyone else by
// ascending slack. Runs off timestamps already in the export.

import { percentile, processable } from "./metrics";
import type { Order } from "./types";

const HOUR_MS = 3_600_000;

export interface StageP80 {
  queue: number;
  processing: number;
  qcQueue: number;
  manualQc: number;
}

/** p80 of each stage duration, pulled from delivered orders in the data. */
export function stageP80s(orders: Order[]): StageP80 {
  const delivered = processable(orders).filter((o) => o.delivered);
  const p80 = (pick: (o: Order) => number | null): number => {
    const vals = delivered.map(pick).filter((x): x is number => x !== null && x >= 0);
    return percentile(vals, 80) ?? 0;
  };
  return {
    queue: p80((o) => o.durQueueH),
    processing: p80((o) => o.durProcessingH),
    qcQueue: p80((o) => o.durQcQueueH),
    manualQc: p80((o) => o.durQcDeliverH),
  };
}

/** Export cutoff = latest timestamp observed anywhere in the data ("now"). */
export function exportCutoff(orders: Order[]): Date {
  let max = 0;
  for (const o of orders) {
    for (const t of [o.tAcq, o.tTrigger, o.tProcEnd, o.tQa, o.tUpload, o.tDeadline, o.lastTs]) {
      if (t && t.getTime() > max) max = t.getTime();
    }
  }
  return new Date(max);
}

export type QueueStage = "pre_processing" | "processing" | "qc_queue" | "in_qc";

export interface RankedOrder {
  order: Order;
  slackH: number;
  remainingH: number;
  ageH: number | null;
  stage: QueueStage;
}

// Furthest timestamp reached wins (see metrics.wipStage): a missing Processing
// End time behind a present QA-assigned time is a logging gap, not position.
function stageOf(o: Order): QueueStage {
  if (o.tQa !== null) return "in_qc";
  if (o.tProcEnd !== null) return "qc_queue";
  if (o.tTrigger !== null) return "processing";
  return "pre_processing";
}

function remainingH(stage: QueueStage, p80: StageP80): number {
  switch (stage) {
    case "pre_processing":
      return p80.queue + p80.processing + p80.qcQueue + p80.manualQc;
    case "processing":
      return p80.processing + p80.qcQueue + p80.manualQc;
    case "qc_queue":
      return p80.qcQueue + p80.manualQc;
    case "in_qc":
      return p80.manualQc;
  }
}

/** Stage, remaining work, and projected slack for one order. */
export function orderSlack(
  o: Order,
  p80: StageP80,
  cutoff: Date,
): { stage: QueueStage; remainingH: number; slackH: number } {
  const stage = stageOf(o);
  const remaining = remainingH(stage, p80);
  const deadlineH =
    o.tDeadline === null
      ? Number.NEGATIVE_INFINITY
      : (o.tDeadline.getTime() - cutoff.getTime()) / HOUR_MS;
  return { stage, remainingH: remaining, slackH: deadlineH - remaining };
}

/** All in-flight (censored) orders, ranked for the QC desk. */
export function qcQueueRanked(
  orders: Order[],
  p80: StageP80,
  cutoff: Date,
): RankedOrder[] {
  const ranked = orders
    .filter((o) => o.censored)
    .map((order): RankedOrder => {
      const s = orderSlack(order, p80, cutoff);
      return {
        order,
        remainingH: s.remainingH,
        slackH: s.slackH,
        ageH: order.ageH,
        stage: s.stage,
      };
    });

  return ranked.sort((a, b) => {
    const aP0 = a.order.priority === "P0" ? 0 : 1;
    const bP0 = b.order.priority === "P0" ? 0 : 1;
    if (aP0 !== bP0) return aP0 - bP0;
    return a.slackH - b.slackH;
  });
}

export interface SlackBuckets {
  breach: number;
  atRisk: number;
  safe: number;
}

export function slackBuckets(ranked: RankedOrder[]): SlackBuckets {
  return {
    breach: ranked.filter((r) => r.slackH <= 0).length,
    atRisk: ranked.filter((r) => r.slackH > 0 && r.slackH <= 6).length,
    safe: ranked.filter((r) => r.slackH > 6).length,
  };
}

const STAGE_LABEL: Record<QueueStage, string> = {
  pre_processing: "pre-processing",
  processing: "processing",
  qc_queue: "QC queue",
  in_qc: "in QC",
};

export function stageLabel(s: QueueStage): string {
  return STAGE_LABEL[s];
}

/**
 * Honest ETA heuristic for a watchlist order: the stale pile is worked
 * P0-first at ~2.5 orders/day, so an order's ETA tracks its rank.
 */
export function honestEtaBusinessDays(rankIndex: number): number {
  return Math.max(1, Math.ceil((rankIndex + 1) / 2.5));
}
