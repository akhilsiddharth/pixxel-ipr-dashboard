import { describe, expect, it } from "vitest";
import { parseWithStated } from "../src/parse";
import { csvText } from "./fixture";

// The dashboard re-derives delivered / censored / stale / ambiguousSuccess /
// firstPassSuccess / metSla from primitive columns instead of trusting the
// cleaned CSV's own values. This fences those definitions: if a future data
// drop breaks a derivation, this fails instead of the dashboard drifting.

const rows = parseWithStated(csvText);

describe("flag derivations match the cleaned CSV, row by row", () => {
  it("parses 95 orders", () => {
    expect(rows).toHaveLength(95);
  });

  for (const { order, stated } of rows) {
    it(`${order.imageId}`, () => {
      expect(order.delivered, "delivered").toBe(stated.delivered);
      expect(order.censored, "censored").toBe(stated.censored);
      expect(order.stale, "stale").toBe(stated.stale);
      expect(order.ambiguousSuccess, "ambiguousSuccess").toBe(stated.ambiguousSuccess);
      expect(order.firstPassSuccess, "firstPassSuccess").toBe(stated.firstPassSuccess);
      expect(order.metSla, "metSla").toBe(stated.metSla);
    });
  }
});
