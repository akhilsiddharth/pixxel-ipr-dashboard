// Smoke test: every persona view renders against the real data, in every
// filter/compare permutation we ship, without leaking undefined / NaN /
// [object Object] into the HTML.

import { describe, expect, it } from "vitest";
import { applyFilters, emptyFilters } from "../src/filters";
import { parseOrders } from "../src/parse";
import { resolveList } from "../src/selectors";
import { exportCutoff, stageP80s } from "../src/slack";
import type { ViewCtx } from "../src/types";
import { renderDrawer } from "../src/ui/drawer";
import { renderCs } from "../src/views/cs";
import { renderEng } from "../src/views/eng";
import { renderLead } from "../src/views/lead";
import { renderQaQc } from "../src/views/qaqc";
import { csvText } from "./fixture";

const orders = parseOrders(csvText);
const cutoff = exportCutoff(orders);
const p80 = stageP80s(orders);

const baseCtx: ViewCtx = {
  compare: false,
  sortKey: "rank",
  sortDir: 1,
  infoOpen: () => false,
  cutoff,
};

const VIEWS = [
  ["lead", renderLead],
  ["qaqc", renderQaQc],
  ["eng", renderEng],
  ["cs", renderCs],
] as const;

const clean = (html: string): void => {
  expect(html.length).toBeGreaterThan(400);
  expect(html).not.toContain("undefined");
  expect(html).not.toContain("NaN");
  expect(html).not.toContain("[object Object]");
  expect(html).not.toMatch(/>\s*null\s*</);
};

describe("views render clean", () => {
  for (const [name, render] of VIEWS) {
    it(`${name} — unfiltered`, () => clean(render(orders, baseCtx)));

    it(`${name} — compare + all info open`, () => {
      clean(render(orders, { ...baseCtx, compare: true, infoOpen: () => true }));
    });

    it(`${name} — filtered to FF02 / P0`, () => {
      const f = emptyFilters();
      f.satellites.add("FF02");
      f.priorities.add("P0");
      const sub = applyFilters(orders, f);
      clean(render(sub, baseCtx));
    });

    it(`${name} — empty subset does not throw`, () => {
      const f = emptyFilters();
      f.customers.add("__nobody__");
      const sub = applyFilters(orders, f);
      expect(() => render(sub, baseCtx)).not.toThrow();
    });
  }

  it("qaqc respects every sortable column", () => {
    for (const key of ["slack", "pri", "age", "sla", "bandset", "id"]) {
      for (const dir of [1, -1] as const) {
        clean(renderQaQc(orders, { ...baseCtx, sortKey: key, sortDir: dir }));
      }
    }
  });
});

describe("drawer renders clean", () => {
  const dctx = { cutoff, p80 };

  it("order drawer for the first in-flight order", () => {
    const first = orders.find((o) => o.censored)!;
    const html = renderDrawer(
      { kind: "order", imageId: first.imageId },
      orders,
      orders,
      dctx,
      { slackMathOpen: true, rawOpen: true },
    );
    clean(html);
    expect(html).toContain("Where it has been");
  });

  it("order drawer for the first delivered order", () => {
    const first = orders.find((o) => o.delivered)!;
    clean(
      renderDrawer({ kind: "order", imageId: first.imageId }, orders, orders, dctx, {
        slackMathOpen: false,
        rawOpen: false,
      }),
    );
  });

  it("list drawer for every selector key used in the views", () => {
    const keys = [
      "p0-late",
      "stale",
      "in-qc",
      "untrusted",
      "wip:waiting_to_process",
      "wip:in_processing",
      "wip:waiting_for_qc",
      "wip:in_qc",
      "driver:reprocess",
      "driver:untrusted",
      "driver:ff02-bbr",
      "funnel:acquired",
      "funnel:processed",
      "funnel:qc-decision",
      "funnel:qc-passed",
      "funnel:delivered",
      "funnel:on-time",
      "ontime:P0",
      "ontime:P1",
      "ontime:P2",
      "ontime:Standard",
      "bucket:breach",
      "bucket:at-risk",
      "bucket:safe",
      "qc-outcome:pass",
      "qc-outcome:note",
      "qc-outcome:fail",
      "qc-outcome:reprocess",
      "reproc:ran",
      "reproc:ok",
      "reproc:a1pass",
      "dq:ooo",
      "dq:noupload",
      "dq:stale",
    ];
    for (const key of keys) {
      const src = resolveList(key, orders, dctx);
      expect(src, key).not.toBeNull();
      clean(
        renderDrawer({ kind: "list", sourceKey: key }, orders, orders, dctx, {
          slackMathOpen: false,
          rawOpen: false,
        }),
      );
    }
  });
});
