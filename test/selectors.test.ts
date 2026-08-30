// The drill-down invariant: a count shown in a panel and the list behind it
// must be the same set. These lock the selector keys to their source metric.

import { describe, expect, it } from "vitest";
import { funnel, reprocessing, wipByStage } from "../src/metrics";
import { parseOrders } from "../src/parse";
import { orderDetail, resolveList } from "../src/selectors";
import { exportCutoff, qcQueueRanked, slackBuckets, stageP80s } from "../src/slack";
import { csvText } from "./fixture";

const orders = parseOrders(csvText);
const cutoff = exportCutoff(orders);
const p80 = stageP80s(orders);
const ctx = { cutoff, p80 };
const count = (key: string): number => resolveList(key, orders, ctx)!.orders.length;

describe("list selectors match their source metric", () => {
  const fn = funnel(orders);
  const step = (label: string): number => fn.find((s) => s.label === label)!.count;

  it("funnel steps", () => {
    expect(count("funnel:acquired")).toBe(step("Acquired"));
    expect(count("funnel:processed")).toBe(step("Processed"));
    expect(count("funnel:qc-decision")).toBe(step("QC decision"));
    expect(count("funnel:qc-passed")).toBe(step("QC passed"));
    expect(count("funnel:delivered")).toBe(step("Delivered"));
    expect(count("funnel:on-time")).toBe(step("On time"));
  });

  it("WIP stages + stale", () => {
    const wip = wipByStage(orders);
    expect(count("in-qc")).toBe(wip.stages.find((s) => s.id === "in_qc")!.count);
    expect(count("wip:in_processing")).toBe(
      wip.stages.find((s) => s.id === "in_processing")!.count,
    );
    expect(count("stale")).toBe(wip.staleTotal);
  });

  it("reprocessing buckets", () => {
    const r = reprocessing(orders);
    expect(count("reproc:ran")).toBe(r.reprocessed);
    expect(count("reproc:ok")).toBe(r.successNum);
    expect(count("reproc:a1pass")).toBe(r.passedAttempt1);
  });

  it("slack buckets", () => {
    const ranked = qcQueueRanked(orders, p80, cutoff);
    const b = slackBuckets(ranked);
    expect(count("bucket:breach")).toBe(b.breach);
    expect(count("bucket:at-risk")).toBe(b.atRisk);
    expect(count("bucket:safe")).toBe(b.safe);
    expect(count("bucket:breach") + count("bucket:at-risk") + count("bucket:safe")).toBe(
      ranked.length,
    );
  });

  it("unknown key resolves to null", () => {
    expect(resolveList("does-not-exist", orders, ctx)).toBeNull();
    expect(resolveList("funnel:bogus", orders, ctx)).toBeNull();
  });
});

describe("order detail", () => {
  it("in-flight order: 5-step timeline, 3 stats, time-left stat", () => {
    const o = orders.find((x) => x.censored)!;
    const d = orderDetail(o, ctx);
    expect(d.timeline).toHaveLength(5);
    expect(d.stats).toHaveLength(3);
    expect(d.stats[2]!.label).toBe("time left");
    expect(d.qcHistory.length).toBeGreaterThanOrEqual(1);
    expect(d.rawRow).toContain(o.imageId);
  });

  it("delivered order: deadline stat instead of time-left", () => {
    const o = orders.find((x) => x.delivered)!;
    const d = orderDetail(o, ctx);
    expect(d.stats[2]!.label).toBe("deadline");
    expect(d.inFlight).toBe(false);
  });
});
