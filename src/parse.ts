import Papa from "papaparse";
import type {
  CloudStatus,
  CustomerVisibleStatus,
  Order,
  Priority,
  ProcKind,
  QcStatus,
  Satellite,
} from "./types";

// ---------------------------------------------------------------------------
// primitive coercion
// ---------------------------------------------------------------------------

function truthy(v: string): boolean {
  return ["true", "1", "yes"].includes(v.trim().toLowerCase());
}

function num(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

function parseDate(v: string): Date | null {
  const t = v.trim();
  if (t === "") return null;
  // Cleaned data is mostly "YYYY-MM-DD HH:MM:SS"; tolerate "YYYY/MM/DD HH:MM".
  const iso = t.replace(/\//g, "-").replace(" ", "T");
  const withZone = iso.length <= 16 ? `${iso}:00Z` : `${iso}Z`;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoWeek(d: Date): number {
  const date = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = date.getTime();
  date.setUTCMonth(0, 1);
  if (date.getUTCDay() !== 4) {
    date.setUTCMonth(0, 1 + ((4 - date.getUTCDay() + 7) % 7));
  }
  return 1 + Math.ceil((firstThursday - date.getTime()) / 604_800_000);
}

function cvStatus(v: string): CustomerVisibleStatus | null {
  const t = v.trim().replace(/\s+/g, "_");
  if (t === "") return null;
  return t as CustomerVisibleStatus;
}

// ---------------------------------------------------------------------------
// derived flags — recomputed here from primitive columns rather than trusted
// from the cleaned CSV, so test/derivations.test.ts can fence the definitions.
// ---------------------------------------------------------------------------

/** The subset of Order fields we re-derive instead of reading straight through. */
export interface DerivedFlags {
  delivered: boolean;
  censored: boolean;
  stale: boolean;
  ambiguousSuccess: boolean;
  firstPassSuccess: boolean;
  metSla: boolean | null;
}

interface DeriveInput {
  processable: boolean;
  procKind: ProcKind;
  tUpload: Date | null;
  tDeadline: Date | null;
  ageH: number | null;
  slaHours: number;
  ambiguousReason: string;
  firstAttemptQc: string;
  reprocessed: boolean;
}

export function deriveFlags(i: DeriveInput): DerivedFlags {
  const delivered = i.tUpload !== null;
  const censored =
    i.processable &&
    !delivered &&
    i.procKind !== "defect" &&
    i.procKind !== "nonproc";
  const stale = censored && i.ageH !== null && i.ageH > 2 * i.slaHours;
  const metSla: boolean | null = !delivered
    ? null
    : i.tUpload !== null && i.tDeadline !== null && i.tUpload <= i.tDeadline;
  const firstPassSuccess =
    (i.firstAttemptQc === "Pass" || i.firstAttemptQc === "Pass_With_Note") &&
    !i.reprocessed;
  return {
    delivered,
    censored,
    stale,
    ambiguousSuccess: i.ambiguousReason.trim() !== "",
    firstPassSuccess,
    metSla,
  };
}

// ---------------------------------------------------------------------------
// row -> Order
// ---------------------------------------------------------------------------

type Row = Record<string, string>;

/** What the cleaned CSV itself asserts for the re-derived flags. */
export interface StatedFlags {
  imageId: string;
  delivered: boolean;
  censored: boolean;
  stale: boolean;
  ambiguousSuccess: boolean;
  firstPassSuccess: boolean;
  metSla: boolean | null;
}

export interface ParsedRow {
  order: Order;
  stated: StatedFlags;
}

function toRow(r: Row): ParsedRow {
  const tAcq = parseDate(r.t_acq ?? "");
  const tUpload = parseDate(r.t_upload ?? "");
  const tDeadline = parseDate(r.t_deadline ?? "");
  const procKind = (r.proc_kind ?? "") as ProcKind;
  const processable = truthy(r.processable ?? "");
  const ageH = num(r.age_h ?? "");
  const slaHours = num(r.sla_hours ?? "") ?? 0;
  const ambiguousReason = r.ambiguous_reason ?? "";
  const firstAttemptQc = r.first_attempt_qc ?? "";
  const reprocessed = truthy(r.reprocessed ?? "");

  const derived = deriveFlags({
    processable,
    procKind,
    tUpload,
    tDeadline,
    ageH,
    slaHours,
    ambiguousReason,
    firstAttemptQc,
    reprocessed,
  });

  const order: Order = {
    imageId: r.image_id ?? "",
    satellite: (r.satellite ?? "") as Satellite,
    aoi: r.aoi ?? "",
    customer: r.customer ?? "",
    isInternal: truthy(r.is_internal ?? ""),
    bandset: r.bandset ?? "",
    queue: r.queue ?? "",
    attempt: num(r.attempt ?? "") ?? 1,
    isReprocess: truthy(r.is_reprocess ?? ""),

    tAcq,
    tTrigger: parseDate(r.t_trigger ?? ""),
    tProcEnd: parseDate(r.t_proc_end ?? ""),
    tQa: parseDate(r.t_qa ?? ""),
    tUpload,
    tDeadline,
    lastTs: parseDate(r.last_ts ?? ""),

    cloudStatus: (r.cloud_status ?? "Unknown") as CloudStatus,
    cloudPct: num(r.cloud_pct ?? ""),
    targetStatus: r.target_status ?? "",
    planCoveragePct: num(r.plan_coverage_pct ?? ""),

    qcStatus: (r.qc_status ?? "Unknown") as QcStatus,
    imageComplete: r.image_complete ?? "",
    procState: r.proc_state ?? "",
    procTerminal: truthy(r.proc_terminal ?? ""),
    procKind,
    failReasonRaw: r.fail_reason_raw ?? "",

    processable,
    nonProcessableReason: r.non_processable_reason ?? "",

    delivered: derived.delivered,
    deliveredSecondary: truthy(r.delivered_secondary ?? ""),
    ambiguousSuccess: derived.ambiguousSuccess,
    ambiguousReason,

    customerVisibleStatus: cvStatus(r.customer_visible_status ?? ""),
    priority: (r.priority ?? "Unknown") as Priority,
    slaHours,
    stripFulfillment: r.strip_fulfillment ?? "",

    offNadir: num(r.off_nadir ?? ""),
    relativeLight: r.relative_light ?? "",
    bbrFlag: truthy(r.bbr_flag ?? ""),
    notes: r.notes ?? "",

    durQueueH: num(r.dur_queue_h ?? ""),
    durProcessingH: num(r.dur_processing_h ?? ""),
    durQcQueueH: num(r.dur_qc_queue_h ?? ""),
    durQcDeliverH: num(r.dur_qc_deliver_h ?? ""),
    durE2eH: num(r.dur_e2e_h ?? ""),

    reprocessed,
    reprocessSuccess: truthy(r.reprocess_success ?? ""),
    firstAttemptQc,
    firstPassSuccess: derived.firstPassSuccess,

    censored: derived.censored,
    stale: derived.stale,
    ageH,
    metSla: derived.metSla,

    acqIsoWeek: tAcq ? isoWeek(tAcq) : null,
  };

  const statedMet = (r.met_sla ?? "").trim();
  const stated: StatedFlags = {
    imageId: order.imageId,
    delivered: truthy(r.delivered ?? ""),
    censored: truthy(r.censored ?? ""),
    stale: truthy(r.stale ?? ""),
    ambiguousSuccess: truthy(r.ambiguous_success ?? ""),
    firstPassSuccess: truthy(r.first_pass_success ?? ""),
    metSla: statedMet === "" ? null : truthy(statedMet),
  };

  return { order, stated };
}

function parseRows(csvText: string): ParsedRow[] {
  const res = Papa.parse<Row>(csvText, {
    header: true,
    skipEmptyLines: true,
  });
  return res.data.filter((r) => (r.image_id ?? "").trim() !== "").map(toRow);
}

export function parseOrders(csvText: string): Order[] {
  return parseRows(csvText).map((p) => p.order);
}

export function parseWithStated(csvText: string): ParsedRow[] {
  return parseRows(csvText);
}
