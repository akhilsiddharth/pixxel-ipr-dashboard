// Domain types for the IPR pipeline dashboard.
// Vocabulary follows CONTEXT.md — do not drift to synonyms.

export type Satellite = "FF01" | "FF02" | "FF03";

/** Priority tier. "Unknown" = the order carried no priority tag in the export. */
export type Priority = "P0" | "P1" | "P2" | "Standard" | "Unknown";

export type QcStatus =
  | "Pass"
  | "Pass_With_Note"
  | "Pending"
  | "Fail"
  | "Not_Applicable"
  | "Unknown";

/** Coarse processing outcome assigned during cleaning. */
export type ProcKind = "inflight" | "success" | "defect" | "nonproc";

export type CloudStatus = "Clear" | "Partly_Cloudy" | "Cloudy" | "Unknown";

export type CustomerVisibleStatus =
  | "On_track"
  | "Delivered"
  | "At_risk"
  | "Internal_review"
  | "Delayed";

/** One image order = one Image ID, represented by its latest valid attempt. */
export interface Order {
  imageId: string;
  satellite: Satellite;
  aoi: string;
  customer: string;
  isInternal: boolean;
  bandset: string;
  /** Processing queue the kept attempt ran in. */
  queue: string;
  attempt: number;
  isReprocess: boolean;

  // Stage chain: acq -> trigger -> procEnd -> qa -> upload
  tAcq: Date | null;
  tTrigger: Date | null;
  tProcEnd: Date | null;
  tQa: Date | null;
  tUpload: Date | null;
  tDeadline: Date | null;
  /** Latest non-null timestamp on the kept attempt. Basis for age / staleness. */
  lastTs: Date | null;

  cloudStatus: CloudStatus;
  cloudPct: number | null;
  targetStatus: string;
  planCoveragePct: number | null;

  qcStatus: QcStatus;
  imageComplete: string;
  procState: string;
  procTerminal: boolean;
  procKind: ProcKind;
  failReasonRaw: string;

  /** false = never captured; excluded from pipeline-failure / yield rates. */
  processable: boolean;
  nonProcessableReason: string;

  /** DataHub Upload Complete Time present. */
  delivered: boolean;
  deliveredSecondary: boolean;
  /** Carries a contradictory success label (see ambiguousReason). */
  ambiguousSuccess: boolean;
  ambiguousReason: string;

  customerVisibleStatus: CustomerVisibleStatus | null;
  priority: Priority;
  slaHours: number;
  stripFulfillment: string;

  offNadir: number | null;
  relativeLight: string;
  bbrFlag: boolean;
  notes: string;

  durQueueH: number | null;
  durProcessingH: number | null;
  durQcQueueH: number | null;
  durQcDeliverH: number | null;
  durE2eH: number | null;

  reprocessed: boolean;
  reprocessSuccess: boolean;
  firstAttemptQc: string;
  /** Passed QC on attempt 1 and was not later reprocessed. */
  firstPassSuccess: boolean;

  /** In-flight (not delivered, not terminal-failure, not non-processable). */
  censored: boolean;
  /** In-flight and idle for more than 2x its SLA hours. */
  stale: boolean;
  /** Hours since lastTs at the export cutoff. Only in-flight orders carry this. */
  ageH: number | null;
  /** Delivered on time. null when the order was never delivered. */
  metSla: boolean | null;

  // ---- derived at parse time ----
  /** ISO week number of acquisition. null when tAcq is missing/unparseable. */
  acqIsoWeek: number | null;
}

/** Rolling window on acquisition time, measured back from the export cutoff. */
export type RangeId = "all" | "7d" | "14d" | "30d";

/** Global filter-bar state. An empty Set means "no constraint on this facet". */
export interface Filters {
  /** Rolling acquisition window. "all" = the whole sample. */
  range: RangeId;
  /** Acquisition time >= this. Derived from `range` against the export cutoff. */
  dateFrom: Date | null;
  /** Acquisition time <= this. */
  dateTo: Date | null;
  satellites: Set<Satellite>;
  bandsets: Set<string>;
  priorities: Set<Priority>;
  customers: Set<string>;
  queues: Set<string>;
}

export type ViewId = "lead" | "qaqc" | "eng" | "cs";

export type Theme = "light" | "dark";

/** Cross-cutting state a view needs beyond the filtered orders. */
export interface ViewCtx {
  /** Static compare-to-prior stub — shows illustrative deltas on the KPI strip. */
  compare: boolean;
  /** QC-queue sort. */
  sortKey: string;
  sortDir: 1 | -1;
  /** Is this panel's "how to read this" prose expanded? */
  infoOpen: (id: string) => boolean;
  /** Export cutoff = "now". */
  cutoff: Date;
}

/** Which slide-over is open, if any. Ephemeral — not in the URL. */
export type DrawerState =
  | { kind: "order"; imageId: string }
  | { kind: "list"; sourceKey: string };
