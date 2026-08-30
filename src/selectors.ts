// Drill-down layer: every clickable number resolves to the exact orders behind
// it, so a count in a panel and the list in the drawer always agree.
// Also derives the per-order detail shown in the order drawer.

import {
  PRIORITY_ORDER,
  QC_DECIDED,
  QC_PASSED,
  processable,
  wipStage,
  type WipStageId,
} from "./metrics";
import { orderSlack, type StageP80 } from "./slack";
import type { Order, Priority } from "./types";
import type { Tone } from "./ui/render";
import { hrs } from "./ui/render";

export interface SelCtx {
  cutoff: Date;
  p80: StageP80;
}

export interface ListSource {
  title: string;
  sub: string;
  orders: Order[];
}

const untrusted = (o: Order): boolean =>
  (o.tUpload !== null && o.customerVisibleStatus !== "Delivered") ||
  (o.customerVisibleStatus === "Delivered" && o.tUpload === null) ||
  (o.tQa !== null && o.tProcEnd !== null && o.tQa < o.tProcEnd);

const FAIL_STAGES = ["L1C", "L2A", "ISOFIT", "Geometry", "Radiometry"] as const;

/** Bucket kept-attempt processing failures by keyword in the recorded reason. */
export function failStageBuckets(orders: Order[]): { key: string; orders: Order[] }[] {
  const defects = processable(orders).filter((o) => o.procKind === "defect");
  const buckets = FAIL_STAGES.map((key) => ({
    key,
    orders: defects.filter((o) => o.failReasonRaw.toUpperCase().includes(key.toUpperCase())),
  }));
  const matched = new Set(buckets.flatMap((b) => b.orders.map((o) => o.imageId)));
  const other = defects.filter((o) => !matched.has(o.imageId));
  return [...buckets, { key: "other", orders: other }].filter((b) => b.orders.length > 0);
}

/** Resolve a selector key to its title, sub-line, and orders. Null = unknown key. */
export function resolveList(
  key: string,
  filtered: Order[],
  ctx: SelCtx,
): ListSource | null {
  const p = processable(filtered);
  const inflight = filtered.filter((o) => o.censored);
  const slackOf = (o: Order): number => orderSlack(o, ctx.p80, ctx.cutoff).slackH;
  const wrap = (title: string, sub: string, orders: Order[]): ListSource => ({
    title,
    sub: sub || `${orders.length} orders. Click any row for the full history.`,
    orders,
  });

  const [prefix, arg] = key.includes(":") ? (key.split(":") as [string, string]) : [key, ""];

  switch (prefix) {
    case "p0-late":
      return wrap(
        "Top priority, already late",
        "Open P0 orders past the date we gave.",
        inflight.filter((o) => o.priority === "P0" && slackOf(o) <= 0),
      );
    case "stale":
      return wrap(
        "Stale orders",
        "No movement in twice the promised time, oldest first.",
        [...inflight.filter((o) => o.stale)].sort((a, b) => (b.ageH ?? 0) - (a.ageH ?? 0)),
      );
    case "in-qc":
      return wrap(
        "Sitting in QC",
        "In-flight orders that have reached QA-assignment.",
        inflight.filter((o) => wipStage(o) === "in_qc"),
      );
    case "untrusted":
      return wrap(
        "Records we cannot trust",
        "The stored status does not match what happened.",
        filtered.filter(untrusted),
      );

    case "wip": {
      const label: Record<WipStageId, string> = {
        waiting_to_process: "Waiting to process",
        in_processing: "In processing",
        waiting_for_qc: "Waiting for QC",
        in_qc: "In QC / post-QA",
      };
      const id = arg as WipStageId;
      return wrap(
        label[id] ?? "Work in progress",
        "Oldest first.",
        [...inflight.filter((o) => wipStage(o) === id)].sort(
          (a, b) => (b.ageH ?? 0) - (a.ageH ?? 0),
        ),
      );
    }

    case "driver":
      if (arg === "reprocess")
        return wrap("Orders run more than once", "", p.filter((o) => o.reprocessed));
      if (arg === "untrusted")
        return wrap("Records we cannot trust", "", filtered.filter(untrusted));
      if (arg === "ff02-bbr")
        return wrap(
          "FF02 orders with artifacts",
          "",
          p.filter((o) => o.satellite === "FF02" && o.bbrFlag),
        );
      return null;

    case "funnel": {
      const map: Record<string, [string, (o: Order) => boolean]> = {
        acquired: ["Acquired", () => true],
        processed: ["Processed", (o) => o.procKind !== "defect"],
        "qc-decision": ["Reached a QC decision", (o) => QC_DECIDED.has(o.qcStatus)],
        "qc-passed": ["Passed QC", (o) => QC_PASSED.has(o.qcStatus)],
        delivered: ["Delivered", (o) => o.delivered],
        "on-time": ["Delivered on time", (o) => o.metSla === true],
      };
      const hit = map[arg];
      return hit ? wrap(hit[0], "", p.filter(hit[1])) : null;
    }

    case "ontime": {
      const pri = arg as Priority;
      if (!PRIORITY_ORDER.includes(pri)) return null;
      const g = p.filter((o) => o.priority === pri);
      const ot = g.filter((o) => o.metSla === true).length;
      return wrap(`${pri} orders`, `${ot} of ${g.length} arrived on time.`, g);
    }

    case "bucket": {
      const pred: Record<string, (s: number) => boolean> = {
        breach: (s) => s <= 0,
        "at-risk": (s) => s > 0 && s <= 6,
        safe: (s) => s > 6,
      };
      const label: Record<string, string> = {
        breach: "No time left",
        "at-risk": "Runs out today",
        safe: "Room to spare",
      };
      const fn = pred[arg];
      if (!fn) return null;
      return wrap(
        label[arg] as string,
        "Least time left first.",
        [...inflight.filter((o) => fn(slackOf(o)))].sort((a, b) => slackOf(a) - slackOf(b)),
      );
    }

    case "qc-outcome": {
      const map: Record<string, [string, (o: Order) => boolean]> = {
        pass: ["Passed", (o) => o.qcStatus === "Pass"],
        note: ["Passed with a note", (o) => o.qcStatus === "Pass_With_Note"],
        fail: ["Failed", (o) => o.qcStatus === "Fail"],
        reprocess: ["Reprocess required", (o) => o.firstAttemptQc === "Reprocess_Required"],
      };
      const hit = map[arg];
      return hit ? wrap(`QC outcome — ${hit[0]}`, "", p.filter(hit[1])) : null;
    }

    case "failstage": {
      const b = failStageBuckets(filtered).find((x) => x.key === arg);
      return b ? wrap(`Failed at ${arg}`, "", b.orders) : null;
    }

    case "reproc": {
      const re = p.filter((o) => o.reprocessed);
      if (arg === "ran") return wrap("Ran more than once", "", re);
      if (arg === "ok") return wrap("Second run worked", "", re.filter((o) => o.reprocessSuccess));
      if (arg === "a1pass")
        return wrap(
          "First run had already passed",
          "",
          re.filter((o) => QC_PASSED.has(o.firstAttemptQc)),
        );
      return null;
    }

    case "dq":
      if (arg === "ooo")
        return wrap(
          "Marked reviewed before the step finished",
          "qc time set before processing-end time.",
          filtered.filter((o) => o.tQa !== null && o.tProcEnd !== null && o.tQa < o.tProcEnd),
        );
      if (arg === "noupload")
        return wrap(
          "Sent, but no record of the upload",
          "customer status = Delivered, no upload timestamp.",
          filtered.filter((o) => o.customerVisibleStatus === "Delivered" && o.tUpload === null),
        );
      if (arg === "stale")
        return wrap(
          "Uploaded, but the status never moved",
          "upload timestamp present, status not refreshed.",
          filtered.filter((o) => o.tUpload !== null && o.customerVisibleStatus !== "Delivered"),
        );
      return null;

    case "cust": {
      const g = p.filter((o) => o.customer === arg);
      const d = g.filter((o) => o.delivered).length;
      return wrap(arg, `${d} of ${g.length} orders delivered.`, g);
    }

    case "watchlist":
      return wrap(
        "High-priority orders still open",
        "P0 and P1, oldest first.",
        [...inflight.filter((o) => o.priority === "P0" || o.priority === "P1")].sort(
          (a, b) => (b.ageH ?? 0) - (a.ageH ?? 0),
        ),
      );

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// order detail
// ---------------------------------------------------------------------------

export interface DetailStat {
  label: string;
  value: string;
  tone: Tone;
}
export interface TimelineStep {
  stage: string;
  ts: string;
  tone: Tone;
}
export interface QcAttempt {
  attempt: string;
  status: string;
  tone: Tone;
}
export interface OrderDetail {
  imageId: string;
  priority: Priority;
  customer: string;
  bandset: string;
  stateLabel: string;
  stateTone: Tone;
  inFlight: boolean;
  stats: DetailStat[];
  timeline: TimelineStep[];
  slackMath: string;
  qcHistory: QcAttempt[];
  rawRow: string;
}

const fmtTs = (d: Date | null): string =>
  d === null
    ? "not yet"
    : `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(
        2,
        "0",
      )} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;

const qcTone = (s: string): Tone =>
  QC_PASSED.has(s) ? "good" : s === "Fail" || s === "Reprocess_Required" ? "bad" : s === "Pending" ? "warn" : "muted";

export function orderDetail(o: Order, ctx: SelCtx): OrderDetail {
  const { stage, remainingH, slackH } = orderSlack(o, ctx.p80, ctx.cutoff);
  const inFlight = o.censored;

  const stageLabels: Record<string, string> = {
    pre_processing: "waiting to process",
    processing: "in processing",
    qc_queue: "waiting for QC",
    in_qc: "in QC",
  };
  const stateLabel = o.delivered ? "delivered" : inFlight ? stageLabels[stage] ?? "in flight" : "not processable";
  const stateTone: Tone = o.delivered
    ? o.metSla === true
      ? "good"
      : "bad"
    : inFlight && slackH <= 0
      ? "bad"
      : inFlight
        ? "warn"
        : "muted";

  const timeSteps: [string, Date | null][] = [
    ["Acquired", o.tAcq],
    ["Triggered", o.tTrigger],
    ["Processed", o.tProcEnd],
    ["QA assigned", o.tQa],
    ["Delivered", o.tUpload],
  ];
  const lastDone = timeSteps.reduce((acc, [, d], i) => (d !== null ? i : acc), -1);
  const timeline: TimelineStep[] = timeSteps.map(([label, d], i) => ({
    stage: label,
    ts: fmtTs(d),
    tone: d !== null ? (i === lastDone ? (inFlight && slackH <= 0 ? "bad" : "accent") : "muted") : "",
  }));

  const stats: DetailStat[] = [
    {
      label: "waiting",
      value: hrs(o.ageH ?? o.durE2eH),
      tone: o.stale ? "bad" : "",
    },
    { label: "promised in", value: `${o.slaHours}h`, tone: "" },
    inFlight
      ? {
          label: "time left",
          value: hrs(slackH),
          tone: slackH <= 0 ? "bad" : slackH < 6 ? "warn" : "good",
        }
      : {
          label: "deadline",
          value: o.metSla === true ? "met" : o.metSla === false ? "missed" : "n/a",
          tone: o.metSla === true ? "good" : o.metSla === false ? "bad" : "muted",
        },
  ];

  const slackMath = inFlight
    ? `promised ${o.slaHours}h, minus ${Math.round(o.ageH ?? 0)}h already waited, minus ${Math.round(
        remainingH,
      )}h of work still ahead, leaves ${hrs(slackH)}${
        slackH <= 0
          ? ". Already late, so the top-priority rule sets its place in the queue, not this number."
          : "."
      }`
    : o.delivered
      ? `delivered ${hrs(o.durE2eH)} end to end. Deadline was ${
          o.metSla === true ? "met" : o.metSla === false ? "missed" : "not recorded"
        }.`
      : "Not a processable order — never captured.";

  const qcHistory: QcAttempt[] = [];
  const a1 = o.firstAttemptQc || "not recorded";
  qcHistory.push({ attempt: "look 1", status: a1.replace(/_/g, " "), tone: qcTone(a1) });
  if ((o.reprocessed || o.attempt > 1) && o.qcStatus && o.qcStatus !== o.firstAttemptQc) {
    qcHistory.push({
      attempt: `look ${Math.max(2, o.attempt)}`,
      status: o.qcStatus.replace(/_/g, " "),
      tone: qcTone(o.qcStatus),
    });
  }

  const rawRow = `(${[
    o.imageId,
    o.priority,
    `${o.slaHours}h`,
    `acq ${fmtTs(o.tAcq)}`,
    `proc_end ${fmtTs(o.tProcEnd)}`,
    `qa ${fmtTs(o.tQa)}`,
    `upload ${fmtTs(o.tUpload)}`,
    `deadline ${fmtTs(o.tDeadline)}`,
    `qc ${o.qcStatus || "null"}`,
    `attempt ${o.attempt}`,
    o.reprocessed ? "reprocessed" : "single-run",
  ].join(", ")})`;

  return {
    imageId: o.imageId,
    priority: o.priority,
    customer: o.customer,
    bandset: o.bandset,
    stateLabel,
    stateTone,
    inFlight,
    stats,
    timeline,
    slackMath,
    qcHistory,
    rawRow,
  };
}
