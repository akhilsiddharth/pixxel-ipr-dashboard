import { PRIORITY_ORDER } from "./metrics";
import type { Filters, Order, Priority, RangeId, Satellite } from "./types";

export function emptyFilters(): Filters {
  return {
    range: "all",
    dateFrom: null,
    dateTo: null,
    satellites: new Set(),
    bandsets: new Set(),
    priorities: new Set(),
    customers: new Set(),
    queues: new Set(),
  };
}

const RANGE_DAYS: Record<RangeId, number | null> = {
  all: null,
  "7d": 7,
  "14d": 14,
  "30d": 30,
};

/** Resolve a rolling range into `dateFrom` (from the export cutoff). */
export function applyRange(f: Filters, range: RangeId, cutoff: Date): void {
  f.range = range;
  const days = RANGE_DAYS[range];
  f.dateFrom = days === null ? null : new Date(cutoff.getTime() - days * 86_400_000);
  f.dateTo = null;
}

/** An empty Set on a facet means "no constraint". */
export function applyFilters(orders: Order[], f: Filters): Order[] {
  return orders.filter((o) => {
    if (f.dateFrom && (o.tAcq === null || o.tAcq < f.dateFrom)) return false;
    if (f.dateTo && (o.tAcq === null || o.tAcq > f.dateTo)) return false;
    if (f.satellites.size && !f.satellites.has(o.satellite)) return false;
    if (f.bandsets.size && !f.bandsets.has(o.bandset)) return false;
    if (f.priorities.size && !f.priorities.has(o.priority)) return false;
    if (f.customers.size && !f.customers.has(o.customer)) return false;
    if (f.queues.size && !f.queues.has(o.queue)) return false;
    return true;
  });
}

export interface FacetOptions {
  satellites: Satellite[];
  bandsets: string[];
  priorities: Priority[];
  customers: string[];
  queues: string[];
  dateMin: Date | null;
  dateMax: Date | null;
}

export function facetOptions(orders: Order[]): FacetOptions {
  const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
  const acqTimes = orders
    .map((o) => o.tAcq)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());

  return {
    satellites: uniq(orders.map((o) => o.satellite)).sort() as Satellite[],
    bandsets: uniq(orders.map((o) => o.bandset)).sort(),
    priorities: PRIORITY_ORDER.filter((p) => orders.some((o) => o.priority === p)),
    customers: uniq(orders.map((o) => o.customer)).sort(),
    queues: uniq(orders.map((o) => o.queue)).sort(),
    dateMin: acqTimes[0] ?? null,
    dateMax: acqTimes[acqTimes.length - 1] ?? null,
  };
}

export function isFilterActive(f: Filters): boolean {
  return (
    f.range !== "all" ||
    f.satellites.size > 0 ||
    f.bandsets.size > 0 ||
    f.priorities.size > 0 ||
    f.customers.size > 0 ||
    f.queues.size > 0
  );
}
