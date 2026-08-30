import { applyFilters, applyRange, emptyFilters, facetOptions, isFilterActive } from "./filters";
import { processingFailures, wipByStage } from "./metrics";
import { parseOrders } from "./parse";
import { exportCutoff, orderSlack, stageP80s, type StageP80 } from "./slack";
import type {
  DrawerState,
  Filters,
  Order,
  RangeId,
  Theme,
  ViewCtx,
  ViewId,
} from "./types";
import { renderDrawer } from "./ui/drawer";
import { days, esc } from "./ui/render";
import { renderCs } from "./views/cs";
import { renderEng } from "./views/eng";
import { renderLead } from "./views/lead";
import { renderQaQc } from "./views/qaqc";

const VIEWS: { id: ViewId; label: string; title: string; render: (o: Order[], c: ViewCtx) => string }[] = [
  { id: "lead", label: "IPR Lead", title: "What needs a decision today", render: renderLead },
  { id: "qaqc", label: "QC", title: "The queue, in the order to work it", render: renderQaQc },
  { id: "eng", label: "Engineering", title: "Where the pipeline is losing time", render: renderEng },
  { id: "cs", label: "Customer Success", title: "Who to call before they call you", render: renderCs },
];

const RANGE_LABEL: Record<RangeId, string> = {
  all: "all of the sample",
  "7d": "last 7 days",
  "14d": "last 14 days",
  "30d": "last 30 days",
};

const THEME_KEY = "ipr-theme";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
};

// ---------------------------------------------------------------------------
// URL <-> filter state
// ---------------------------------------------------------------------------

function readState(cutoff: Date): { view: ViewId; filters: Filters } {
  const q = new URLSearchParams(location.search);
  const view = (VIEWS.find((v) => v.id === q.get("view"))?.id ?? "lead") as ViewId;
  const f = emptyFilters();
  const fill = (key: string, target: Set<string>): void => {
    const raw = q.get(key);
    if (raw) for (const v of raw.split(",").filter(Boolean)) target.add(v);
  };
  fill("sat", f.satellites as Set<string>);
  fill("band", f.bandsets);
  fill("pri", f.priorities as Set<string>);
  fill("cust", f.customers);
  fill("queue", f.queues);
  const range = (q.get("range") ?? "all") as RangeId;
  applyRange(f, RANGE_LABEL[range] ? range : "all", cutoff);
  return { view, filters: f };
}

function writeState(view: ViewId, f: Filters): void {
  const q = new URLSearchParams();
  if (view !== "lead") q.set("view", view);
  if (f.range !== "all") q.set("range", f.range);
  const put = (key: string, s: Set<string>): void => {
    if (s.size) q.set(key, [...s].join(","));
  };
  put("sat", f.satellites as Set<string>);
  put("band", f.bandsets);
  put("pri", f.priorities as Set<string>);
  put("cust", f.customers);
  put("queue", f.queues);
  const qs = q.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

// ---------------------------------------------------------------------------
// per-render summary (drives tab pills + ledes)
// ---------------------------------------------------------------------------

interface Summary {
  actionCount: number;
  breaching: number;
  procFail: number;
  watching: number;
  watchLate: number;
  p0Late: number;
  p0Open: number;
  staleN: number;
  oldestDays: string;
}

function summarize(filtered: Order[], p80: StageP80, cutoff: Date): Summary {
  const inflight = filtered.filter((o) => o.censored);
  const slackOf = (o: Order): number => orderSlack(o, p80, cutoff).slackH;
  const p0Open = inflight.filter((o) => o.priority === "P0");
  const p0Late = p0Open.filter((o) => slackOf(o) <= 0).length;
  const wip = wipByStage(filtered);
  const watch = inflight.filter((o) => o.priority === "P0" || o.priority === "P1");
  const oldest = inflight.length ? Math.max(...inflight.map((o) => o.ageH ?? 0)) : 0;
  return {
    actionCount: inflight.filter((o) => o.priority === "P0" || slackOf(o) <= 0 || o.stale).length,
    breaching: inflight.filter((o) => slackOf(o) <= 0).length,
    procFail: processingFailures(filtered).failed,
    watching: watch.length,
    watchLate: watch.filter((o) => slackOf(o) <= 0).length,
    p0Late,
    p0Open: p0Open.length,
    staleN: wip.staleTotal,
    oldestDays: days(oldest),
  };
}

function ledeFor(view: ViewId, s: Summary): string {
  switch (view) {
    case "lead":
      return `${s.p0Late} of the ${s.p0Open} open top-priority orders are already past the date we gave, and ${s.staleN} orders have not moved in twice the time we promised. The table below is the morning, in order.`;
    case "qaqc":
      return `Top priority first, then whatever has least time left. The oldest order in the queue has been waiting ${s.oldestDays}.`;
    case "eng":
      return "Outright failures are rare. The time goes to waiting before processing, and to work we chose to do twice.";
    case "cs":
      return `${s.watchLate} high-priority orders are past the date we gave. Every date here is worked out from how long the remaining steps actually take, not the status the customer sees.`;
  }
}

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

function main(orders: Order[]): void {
  const CUTOFF = exportCutoff(orders);
  const P80 = stageP80s(orders);
  const facets = facetOptions(orders);

  const boot = readState(CUTOFF);
  let view: ViewId = boot.view;
  let filters: Filters = boot.filters;
  let theme: Theme = readTheme();
  let compare = false;
  let drawer: DrawerState | null = null;
  let sortKey = "rank";
  let sortDir: 1 | -1 = 1;
  const infoOpen = new Set<string>();
  let slackMathOpen = false;
  let rawOpen = false;

  document.documentElement.dataset.theme = theme;

  const appEl = $("#app");
  const sidebarEl = $("#sidebar");
  const headEl = $("#head");
  const barEl = $("#filterbar");
  const viewEl = $("#view");
  const drawerEl = $("#drawer");

  const asOf = `${CUTOFF.toISOString().slice(0, 10)} ${CUTOFF.toISOString().slice(11, 16)} UTC`;

  const ctx = (): ViewCtx => ({
    compare,
    sortKey,
    sortDir,
    infoOpen: (id) => infoOpen.has(id),
    cutoff: CUTOFF,
  });

  function render(): void {
    writeState(view, filters);
    const filtered = applyFilters(orders, filters);
    const s = summarize(filtered, P80, CUTOFF);
    const active = isFilterActive(filters);

    document.documentElement.dataset.theme = theme;
    sidebarEl.innerHTML = sidebarHtml(s);
    headEl.innerHTML = headHtml(filtered.length, orders.length, active, s);
    barEl.innerHTML = barHtml();
    viewEl.innerHTML = VIEWS.find((v) => v.id === view)!.render(filtered, ctx());

    const drawerHtml = renderDrawer(drawer, orders, filtered, { cutoff: CUTOFF, p80: P80 }, {
      slackMathOpen,
      rawOpen,
    });
    drawerEl.innerHTML = drawerHtml;
    drawerEl.hidden = drawer === null;
    appEl.classList.toggle("drawer-open", drawer !== null);
  }

  // ---- sidebar ----
  function sidebarHtml(s: Summary): string {
    const pill: Record<ViewId, { text: string; bad: boolean }> = {
      lead: { text: `${s.actionCount} need a decision`, bad: s.actionCount > 0 },
      qaqc: { text: `${s.breaching} late`, bad: s.breaching > 0 },
      eng: { text: `${s.procFail} failed`, bad: false },
      cs: { text: `${s.watching} waiting`, bad: false },
    };
    const tabs = VIEWS.map((v) => {
      const on = v.id === view;
      const p = pill[v.id];
      return `<button type="button" class="tab${on ? " on" : ""}" data-view="${v.id}" ${
        on ? 'aria-current="page"' : ""
      }>
        <span class="tab-label">${esc(v.label)}</span>
        <span class="tab-pill${p.bad ? " bad" : ""}">${esc(p.text)}</span>
      </button>`;
    }).join("");

    return `<div class="brand">
      <div class="brand-name">IPR Operations</div>
      <div class="brand-as-of mono">${esc(asOf)}</div>
    </div>
    <nav class="tabs">
      <div class="tabs-cap mono">Your desk</div>
      ${tabs}
    </nav>
    <div class="side-foot">
      <button type="button" class="side-info${infoOpen.has("model") ? " on" : ""}" data-info="model">
        <span class="i-dot">i</span> How to read this
      </button>
      ${
        infoOpen.has("model")
          ? `<div class="info-box">Every panel answers to the filters above, and every number opens the orders behind it — matched across steps by image ID, so a count here and a list there always agree. Panels marked "sample" wait on two fields the pipeline does not emit yet: a reason for each QC decision, and a timestamp at every step.</div>`
          : ""
      }
      <button type="button" class="side-toggle${compare ? " on" : ""}" data-compare-toggle>
        Compare to prior period <span class="dim">(illustrative)</span>
      </button>
      <div class="theme-switch">
        <button type="button" class="${theme === "dark" ? "on" : ""}" data-theme-set="dark">dark</button>
        <button type="button" class="${theme === "light" ? "on" : ""}" data-theme-set="light">light</button>
      </div>
      <a class="deck-link" id="deck-link" href="deck.html" target="_blank" rel="noreferrer">Deck ↗</a>
    </div>`;
  }

  // ---- header ----
  function headHtml(shown: number, total: number, active: boolean, s: Summary): string {
    const def = VIEWS.find((v) => v.id === view)!;
    const summary = active
      ? `<b>${shown}</b> of ${total} orders${compare ? ", compared to the period before" : ""}`
      : `all <b>${total}</b> orders${compare ? ", compared to the period before" : ""}`;
    return `<div class="head-title">${esc(def.title)}</div>
      <div class="head-lede">${esc(ledeFor(view, s))}</div>
      <div class="head-scope mono">${summary}</div>`;
  }

  // ---- filter bar ----
  function barHtml(): string {
    const sel = (
      name: string,
      opts: { v: string; label: string }[],
      current: string,
    ): string =>
      `<select class="fsel" data-select="${name}">${opts
        .map(
          (o) =>
            `<option value="${esc(o.v)}"${o.v === current ? " selected" : ""}>${esc(o.label)}</option>`,
        )
        .join("")}</select>`;

    const chips = (name: string, opts: string[], selected: Set<string>): string =>
      `<div class="chipset"><span class="chipset-cap mono">${esc(name)}</span>${opts
        .map(
          (o) =>
            `<button type="button" class="chip" data-chip="${name}:${esc(o)}" aria-pressed="${selected.has(
              o,
            )}">${esc(o)}</button>`,
        )
        .join("")}</div>`;

    const rangeSel = sel(
      "range",
      (["all", "7d", "14d", "30d"] as RangeId[]).map((r) => ({ v: r, label: RANGE_LABEL[r] })),
      filters.range,
    );
    const bandSel = sel(
      "band",
      [{ v: "", label: "all bandsets" }, ...facets.bandsets.map((b) => ({ v: b, label: b }))],
      [...filters.bandsets][0] ?? "",
    );
    const custSel = sel(
      "cust",
      [{ v: "", label: "all customers" }, ...facets.customers.map((c) => ({ v: c, label: c }))],
      [...filters.customers][0] ?? "",
    );
    const queueSel = sel(
      "queue",
      [{ v: "", label: "any queue" }, ...facets.queues.map((c) => ({ v: c, label: c }))],
      [...filters.queues][0] ?? "",
    );

    const clear = isFilterActive(filters)
      ? `<button type="button" class="fclear" data-clear>clear</button>`
      : "";

    return `${rangeSel}
      ${chips("sat", facets.satellites, filters.satellites as Set<string>)}
      ${bandSel}
      ${chips("pri", facets.priorities, filters.priorities as Set<string>)}
      ${custSel}
      ${queueSel}
      <span class="fspacer"></span>
      ${clear}`;
  }

  // ---- events ----
  function openDrawer(d: DrawerState): void {
    drawer = d;
    slackMathOpen = false;
    rawOpen = false;
    render();
  }
  function closeDrawer(): void {
    if (!drawer) return;
    drawer = null;
    render();
  }

  appEl.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const hit = (sel: string): HTMLElement | null => t.closest(sel);

    const close = hit("[data-drawer-close]");
    if (close) return closeDrawer();

    const order = hit("[data-open-order]");
    if (order) return openDrawer({ kind: "order", imageId: order.dataset.openOrder! });

    const list = hit("[data-open-list]");
    if (list) return openDrawer({ kind: "list", sourceKey: list.dataset.openList! });

    const detail = hit("[data-detail]");
    if (detail) {
      if (detail.dataset.detail === "slackMath") slackMathOpen = !slackMathOpen;
      else rawOpen = !rawOpen;
      return render();
    }

    const info = hit("[data-info]");
    if (info) {
      const id = info.dataset.info!;
      infoOpen.has(id) ? infoOpen.delete(id) : infoOpen.add(id);
      return render();
    }

    const sort = hit("[data-sort]");
    if (sort) {
      const k = sort.dataset.sort!;
      if (sortKey === k) sortDir = (sortDir * -1) as 1 | -1;
      else {
        sortKey = k;
        sortDir = 1;
      }
      return render();
    }

    const goto = hit("[data-goto]");
    if (goto) {
      view = goto.dataset.goto as ViewId;
      drawer = null;
      return render();
    }

    const tab = hit("[data-view]");
    if (tab) {
      view = tab.dataset.view as ViewId;
      drawer = null;
      return render();
    }

    const chip = hit("[data-chip]");
    if (chip) {
      const [name, val] = chip.dataset.chip!.split(":") as [string, string];
      const set =
        name === "sat"
          ? (filters.satellites as Set<string>)
          : (filters.priorities as Set<string>);
      set.has(val) ? set.delete(val) : set.add(val);
      return render();
    }

    const themeBtn = hit("[data-theme-set]");
    if (themeBtn) {
      theme = themeBtn.dataset.themeSet as Theme;
      writeTheme(theme);
      return render();
    }

    if (hit("[data-compare-toggle]")) {
      compare = !compare;
      return render();
    }

    if (hit("[data-clear]")) {
      filters = emptyFilters();
      applyRange(filters, "all", CUTOFF);
      return render();
    }
  });

  appEl.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if ((e.key === "Enter" || e.key === " ") && t.matches('[role="button"]')) {
      e.preventDefault();
      t.click();
    }
  });

  appEl.addEventListener("change", (e) => {
    const t = e.target as HTMLElement;
    const s = t.closest<HTMLSelectElement>("[data-select]");
    if (!s) return;
    const name = s.dataset.select!;
    const val = s.value;
    if (name === "range") applyRange(filters, val as RangeId, CUTOFF);
    else {
      const set =
        name === "band"
          ? filters.bandsets
          : name === "cust"
            ? filters.customers
            : filters.queues;
      set.clear();
      if (val) set.add(val);
    }
    render();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });

  render();
}

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "dark" || v === "light") return v;
  } catch {
    /* private mode */
  }
  return "light";
}
function writeTheme(t: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

const csvUrl = `${import.meta.env.BASE_URL}orders.csv`;
fetch(csvUrl)
  .then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.text();
  })
  .then((text) => main(parseOrders(text)))
  .catch((err: unknown) => {
    $("#view").innerHTML = `<section class="card"><div class="card-cap">Could not load orders.csv</div>
      <p class="card-lede">${esc(String(err))} — tried <code>${esc(csvUrl)}</code></p></section>`;
  });
