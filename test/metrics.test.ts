import { describe, expect, it } from "vitest";
import {
  bbrByBandset,
  bbrBySatellite,
  bbrOverall,
  bySatellite,
  cloudyCount,
  deliverySignalIntegrity,
  endToEndTat,
  firstPassYield,
  funnel,
  nonProcessable,
  onTimeByPriority,
  processable,
  processingFailures,
  reprocessing,
  wipByStage,
} from "../src/metrics";
import { parseOrders } from "../src/parse";
import { exportCutoff, qcQueueRanked, slackBuckets, stageP80s } from "../src/slack";
import { csvText } from "./fixture";

// Every assertion below traces to a row in submission/00-figures.md.
// "The number sweep" — if the live computation and the source-of-truth
// disagree, the build fails.

const all = parseOrders(csvText);
const fn = (label: string) => funnel(all).find((s) => s.label === label)?.count;
const row = (p: string) => onTimeByPriority(all).rows.find((r) => r.priority === p);

describe("headline", () => {
  it("95 orders, 89 processable, 6 non-processable", () => {
    expect(all).toHaveLength(95);
    expect(processable(all)).toHaveLength(89);
    expect(nonProcessable(all).count).toBe(6);
  });

  it("delivered 61 / 89, on-time 51 / 89", () => {
    expect(fn("Delivered")).toBe(61);
    expect(fn("On time")).toBe(51);
  });

  it("no order excluded for cloud; exactly 1 Cloudy", () => {
    expect(cloudyCount(all)).toBe(1);
  });
});

describe("funnel (processable)", () => {
  it("89 / 83 / 77 / 69 / 61 / 51", () => {
    expect(fn("Acquired")).toBe(89);
    expect(fn("Processed")).toBe(83);
    expect(fn("QC decision")).toBe(77);
    expect(fn("QC passed")).toBe(69);
    expect(fn("Delivered")).toBe(61);
    expect(fn("On time")).toBe(51);
  });
});

describe("on-time by priority", () => {
  it("P0 11 orders, 5 delivered, 0 on time — 0% on any basis", () => {
    const p0 = row("P0");
    expect(p0).toMatchObject({ orders: 11, delivered: 5, onTime: 0 });
    expect(p0?.onTimePctOrders).toBe(0);
    expect(p0?.onTimePctDelivered).toBe(0);
  });

  it("P1 21/14/12, P2 15/10/7, Standard 35/25/25, Unknown 7/7/7", () => {
    expect(row("P1")).toMatchObject({ orders: 21, delivered: 14, onTime: 12 });
    expect(row("P2")).toMatchObject({ orders: 15, delivered: 10, onTime: 7 });
    expect(row("Standard")).toMatchObject({ orders: 35, delivered: 25, onTime: 25 });
    expect(row("Unknown")).toMatchObject({ orders: 7, delivered: 7, onTime: 7 });
  });

  it("blended on-time is 57% of orders", () => {
    expect(Math.round(onTimeByPriority(all).blendedPctOrders)).toBe(57);
  });
});

describe("WIP / backlog", () => {
  const wip = wipByStage(all);
  it("22 in-flight, all past QA-assignment", () => {
    expect(wip.inFlight).toBe(22);
    expect(wip.stages.find((s) => s.id === "in_qc")?.count).toBe(22);
    expect(wip.stages.find((s) => s.id === "waiting_to_process")?.count).toBe(0);
    expect(wip.stages.find((s) => s.id === "in_processing")?.count).toBe(0);
    expect(wip.stages.find((s) => s.id === "waiting_for_qc")?.count).toBe(0);
  });

  it("20 stale — P0 5 · P1 5 · P2 3 · Standard 7", () => {
    expect(wip.staleTotal).toBe(20);
    expect(wip.staleByPriority.P0).toBe(5);
    expect(wip.staleByPriority.P1).toBe(5);
    expect(wip.staleByPriority.P2).toBe(3);
    expect(wip.staleByPriority.Standard).toBe(7);
  });

  it("oldest in-flight order age ~685h", () => {
    expect(Math.round(wip.oldestAgeH ?? 0)).toBe(685);
  });
});

describe("reprocessing", () => {
  const r = reprocessing(all);
  it("26 / 89 = 29%, success 22 / 26, passed attempt 1: 19", () => {
    expect(r.reprocessed).toBe(26);
    expect(r.base).toBe(89);
    expect(Math.round(r.ratePct)).toBe(29);
    expect(r.successNum).toBe(22);
    expect(r.passedAttempt1).toBe(19);
  });
});

describe("first-pass QC yield", () => {
  it("47 / 77 = 61% (not 47 / 89)", () => {
    const y = firstPassYield(all);
    expect(y.num).toBe(47);
    expect(y.den).toBe(77);
    expect(Math.round(y.pct)).toBe(61);
  });
});

describe("delivery-signal integrity", () => {
  const s = deliverySignalIntegrity(all);
  it("33 ambiguous total, split 18 signal-mismatch / 15 outcome-ambiguity", () => {
    expect(s.ambiguousTotal).toBe(33);
    expect(s.signalMismatch).toBe(18);
    expect(s.outcomeAmbiguity).toBe(15);
  });
  it("integrity rate ~58/89 ~= 65%", () => {
    expect(s.cleanNum).toBe(58);
    expect(s.base).toBe(89);
    expect(Math.round(s.integrityPct)).toBe(65);
  });
});

describe("processing failures", () => {
  it("6 / 89", () => {
    expect(processingFailures(all)).toEqual({ failed: 6, base: 89 });
  });
});

describe("BBR (directional, small n)", () => {
  it("overall 13 / 89", () => {
    expect(bbrOverall(all)).toMatchObject({ num: 13, den: 89 });
  });
  it("by satellite: FF01 4/33 · FF02 6/25 · FF03 3/31", () => {
    const bs = bbrBySatellite(all);
    expect(bs.find((c) => c.key === "FF01")).toMatchObject({ num: 4, den: 33 });
    expect(bs.find((c) => c.key === "FF02")).toMatchObject({ num: 6, den: 25 });
    expect(bs.find((c) => c.key === "FF03")).toMatchObject({ num: 3, den: 31 });
  });
  it("Standard_RGB is the lowest-BBR bandset (~5%)", () => {
    const rgb = bbrByBandset(all).find((c) => c.key === "Standard_RGB");
    expect(rgb).toMatchObject({ num: 1, den: 19 });
  });
});

describe("on-time / delivery by satellite", () => {
  it("FF02 48% vs FF03 68% of orders", () => {
    const bs = bySatellite(all);
    expect(bs.find((r) => r.satellite === "FF02")).toMatchObject({ orders: 25, delivered: 17 });
    expect(bs.find((r) => r.satellite === "FF03")).toMatchObject({ orders: 31, delivered: 21 });
    expect(Math.round(bs.find((r) => r.satellite === "FF02")?.onTimePctOrders ?? 0)).toBe(48);
    expect(Math.round(bs.find((r) => r.satellite === "FF03")?.onTimePctOrders ?? 0)).toBe(68);
  });
});

describe("end-to-end TAT (delivered)", () => {
  it("p50 around 12h, p90 in the mid-30s", () => {
    const t = endToEndTat(all);
    expect(t.p50 ?? 0).toBeGreaterThan(9);
    expect(t.p50 ?? 0).toBeLessThan(16);
    expect(t.p90 ?? 0).toBeGreaterThan(28);
    expect(t.p90 ?? 0).toBeLessThan(40);
  });
});

describe("SLA slack queue ranking", () => {
  const p80 = stageP80s(all);
  const cutoff = exportCutoff(all);
  const ranked = qcQueueRanked(all, p80, cutoff);

  it("ranks every in-flight order", () => {
    expect(ranked).toHaveLength(22);
  });

  it("P0 orders sit at the top", () => {
    const firstNonP0 = ranked.findIndex((r) => r.order.priority !== "P0");
    const p0Count = ranked.filter((r) => r.order.priority === "P0").length;
    expect(firstNonP0).toBe(p0Count);
  });

  it("the whole current pile is past deadline (slack <= 0)", () => {
    expect(slackBuckets(ranked).breach).toBe(22);
  });

  it("p80 end-to-end is around 31h", () => {
    const sum = p80.queue + p80.processing + p80.qcQueue + p80.manualQc;
    expect(sum).toBeGreaterThan(20);
    expect(sum).toBeLessThan(45);
  });
});
