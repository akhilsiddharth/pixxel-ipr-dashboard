// String-templating component vocabulary. Data is our own trusted CSV, but
// esc() is applied to every interpolated value anyway.
//
// Visual language follows the design iteration (IPR Dashboard.dc.html):
// mono numerals, tiny uppercase captions, 8px meter tracks, tone strips on
// cards. Exact spacing/colour lives in styles.css; this file only emits the
// class hooks and the data-* attributes the delegated click handler reads.

export function esc(v: unknown): string {
  return String(v).replace(
    /[&<>"']/g,
    (c) =>
      (({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }) as Record<string, string>)[c] ?? c,
  );
}

export type Tone = "" | "bad" | "warn" | "good" | "accent" | "muted";

const toneCls = (t: Tone): string => (t ? ` t-${t}` : "");

// ---- number formatting -----------------------------------------------------

export function pct1(v: number): string {
  return `${v.toFixed(v < 10 && v > 0 ? 1 : 0)}%`;
}

export function round(v: number | null, digits = 0): string {
  if (v === null || !Number.isFinite(v)) return "–";
  return v.toFixed(digits);
}

/** Signed hours, e.g. 685 -> "685h", -673 -> "-673h". */
export function hrs(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "–";
  const r = Math.round(v);
  return `${r < 0 ? "-" : ""}${Math.abs(r)}h`;
}

/** Whole days from hours, e.g. 685 -> "29d". */
export function days(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "–";
  return `${Math.round(v / 24)}d`;
}

/** Compact priority label for narrow table columns. */
export function shortPri(p: string): string {
  return p === "Standard" ? "Std" : p === "Unknown" ? "—" : p;
}

// ---- click plumbing ------------------------------------------------------

export interface Click {
  /** Opens the list drawer for this selector key. */
  list?: string;
  /** Opens the order drawer for this image id. */
  order?: string;
}

function clickAttrs(c: Click | undefined): string {
  if (!c) return "";
  if (c.order) return ` class="hit" role="button" tabindex="0" data-open-order="${esc(c.order)}"`;
  if (c.list) return ` class="hit" role="button" tabindex="0" data-open-list="${esc(c.list)}"`;
  return "";
}

// ---- meter track ---------------------------------------------------------

export function track(frac: number, tone: Tone = "accent"): string {
  const w = Math.max(0, Math.min(100, frac * 100)).toFixed(1);
  return `<span class="track"><span class="fill${toneCls(tone)}" style="width:${w}%"></span></span>`;
}

// ---- card --------------------------------------------------------------

export interface CardOpts {
  /** Tiny uppercase mono caption. */
  caption: string;
  body: string;
  /** Larger semibold title, used on action-first panels. Overrides caption slot. */
  title?: string;
  /** Tone strip along one edge. */
  tone?: Tone;
  edge?: "top" | "left";
  /** Small right-aligned text in the header. */
  note?: string;
  /** Collapsible "how to read this" prose. */
  info?: { id: string; text: string; open: boolean };
  /** Amber "sample" pill — panel waits on data the pipeline does not emit yet. */
  sample?: boolean;
  /** Grid span. */
  span?: 1 | 2;
}

export function card(o: CardOpts): string {
  const cls = [
    "card",
    o.tone ? `edge-${o.edge ?? "top"} t-${o.tone}` : "",
    o.span === 2 ? "span2" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const left = o.title
    ? `<div class="card-title">${esc(o.title)}</div>`
    : `<div class="card-cap">${esc(o.caption)}</div>`;

  const right = [
    o.note ? `<span class="card-note">${esc(o.note)}</span>` : "",
    o.sample ? `<span class="pill-sample">sample</span>` : "",
    o.info ? infoBtn(o.info.id, o.info.open) : "",
  ]
    .filter(Boolean)
    .join("");

  const head =
    left || right
      ? `<div class="card-head">${left}<div class="card-head-r">${right}</div></div>`
      : "";
  const info = o.info && o.info.open ? infoBox(o.info.text) : "";

  return `<section class="${cls}">${head}${info}${o.body}</section>`;
}

export function infoBtn(id: string, open: boolean): string {
  return `<button type="button" class="info-btn${open ? " on" : ""}" data-info="${esc(id)}" aria-expanded="${open}" aria-label="How to read this">i</button>`;
}

export function infoBox(text: string): string {
  return `<div class="info-box">${esc(text)}</div>`;
}

// ---- KPI strip -------------------------------------------------------------

export interface KpiCell {
  label: string;
  value: string | number;
  note: string;
  tone: Tone;
  /** Shown only in compare mode. */
  delta?: string;
  deltaTone?: Tone;
  listKey?: string;
}

export function kpiStrip(cells: KpiCell[]): string {
  const body = cells
    .map(
      (k) => `<div class="kpi${toneCls(k.tone)}"${
        k.listKey ? ` role="button" tabindex="0" data-open-list="${esc(k.listKey)}"` : ""
      }>
      <div class="kpi-label">${esc(k.label)}</div>
      <div class="kpi-value-row">
        <span class="kpi-value">${esc(k.value)}</span>
        ${k.delta ? `<span class="kpi-delta${toneCls(k.deltaTone ?? "")}">${esc(k.delta)}</span>` : ""}
      </div>
      <div class="kpi-note">${esc(k.note)}</div>
    </div>`,
    )
    .join("");
  return `<div class="kpi-strip">${body}</div>`;
}

// ---- meter rows ---------------------------------------------------------

export interface BarMeterRow {
  label: string;
  value: string;
  frac: number;
  tone?: Tone;
  /** e.g. the funnel drop "-6". */
  trailing?: string;
  click?: Click;
}

/** Funnel-style row: label · count · meter · drop. */
export function barMeterRows(rows: BarMeterRow[]): string {
  return rows
    .map(
      (r) => `<div class="mrow"${clickAttrs(r.click)}>
      <span class="mrow-label">${esc(r.label)}</span>
      <span class="mrow-n">${esc(r.value)}</span>
      ${track(r.frac, r.tone ?? "accent")}
      <span class="mrow-trail">${esc(r.trailing ?? "")}</span>
    </div>`,
    )
    .join("");
}

export interface PctRow {
  label: string;
  frac: number;
  pct: string;
  frac_label?: string;
  tone?: Tone;
  flag?: string;
  click?: Click;
}

/** on-time-by-priority / delivery-by-customer style: label · meter · % · (n/n) · flag. */
export function pctRows(rows: PctRow[], opts: { labelWidth?: string } = {}): string {
  const body = rows
    .map(
      (r) => `<div class="prow"${clickAttrs(r.click)}>
      <span class="prow-label">${esc(r.label)}</span>
      ${track(r.frac, r.tone ?? "accent")}
      <span class="prow-pct${toneCls(r.tone ?? "")}">${esc(r.pct)}</span>
      <span class="prow-frac">${esc(r.frac_label ?? "")}</span>
      <span class="prow-flag">${esc(r.flag ?? "")}</span>
    </div>`,
    )
    .join("");
  return `<div class="prows" style="--plabel:${opts.labelWidth ?? "56px"}">${body}</div>`;
}

export interface EdgeRow {
  label: string;
  value: string;
  note?: string;
  tone?: Tone;
  click?: Click;
}

/** Left-tone-strip row: label · value · note. WIP / reprocess / buckets. */
export function edgeRows(rows: EdgeRow[]): string {
  return rows
    .map(
      (r) => `<div class="erow t-${r.tone ?? "muted"}"${clickAttrs(r.click)}>
      <span class="erow-label">${esc(r.label)}</span>
      <span class="erow-value">${esc(r.value)}</span>
      <span class="erow-note">${esc(r.note ?? "")}</span>
    </div>`,
    )
    .join("");
}

export interface DriverRow {
  label: string;
  note: string;
  value: string;
  tone?: Tone;
  click?: Click;
}

/** Stacked label+note on the left, big value on the right. */
export function driverRows(rows: DriverRow[]): string {
  return rows
    .map(
      (r) => `<div class="drow t-${r.tone ?? "muted"}"${clickAttrs(r.click)}>
      <div class="drow-main">
        <div class="drow-label">${esc(r.label)}</div>
        <div class="drow-note">${esc(r.note)}</div>
      </div>
      <div class="drow-value">${esc(r.value)}</div>
    </div>`,
    )
    .join("");
}

// ---- stat cards -------------------------------------------------------------

export interface StatCard {
  value: string;
  label: string;
  tone?: Tone;
  click?: Click;
}

export function statGrid(cards: StatCard[], cols = 2): string {
  const body = cards
    .map(
      (c) => `<div class="stat"${clickAttrs(c.click)}>
      <div class="stat-v${toneCls(c.tone ?? "")}">${esc(c.value)}</div>
      <div class="stat-l">${esc(c.label)}</div>
    </div>`,
    )
    .join("");
  return `<div class="stat-grid cols-${cols}">${body}</div>`;
}

// ---- data table -------------------------------------------------------------

export interface TableCol {
  key: string;
  label: string;
  align?: "left" | "right" | "center";
  /** Enables the sort affordance for this column. */
  sortable?: boolean;
  /** Explicit grid width, e.g. "76px". Ignored when `grow` is set. */
  width?: string;
  /** The one flexible column. */
  grow?: boolean;
}

export interface TableRow {
  cells: string[];
  tone?: Tone;
  click?: Click;
}

export interface TableSort {
  key: string;
  dir: 1 | -1;
}

export function dataTable(
  cols: TableCol[],
  rows: TableRow[],
  sort?: TableSort,
): string {
  const template = cols
    .map((c) => (c.grow ? "minmax(0,1fr)" : (c.width ?? "auto")))
    .join(" ");
  const gridVar = `--tgrid:${template}`;
  const head = cols
    .map((c) => {
      const active = !!c.sortable && !!sort && sort.key === c.key;
      const arrow = active ? (sort!.dir > 0 ? " ↑" : " ↓") : "";
      const attrs = c.sortable ? ` role="button" tabindex="0" data-sort="${esc(c.key)}"` : "";
      return `<div class="th al-${c.align ?? "left"}${active ? " on" : ""}${
        c.sortable ? " sortable" : ""
      }"${attrs}>${esc(c.label)}${arrow}</div>`;
    })
    .join("");
  const body = rows
    .map((r) => {
      const tds = r.cells
        .map(
          (v, i) => `<div class="td al-${cols[i]?.align ?? "left"}">${v}</div>`,
        )
        .join("");
      return `<div class="tr${toneCls(r.tone ?? "")}"${clickAttrs(r.click)}>${tds}</div>`;
    })
    .join("");
  return `<div class="dtable" style="${gridVar}"><div class="thead">${head}</div><div class="tbody">${body}</div></div>`;
}

/** Small inline pill used inside table cells (state / action). */
export function cellPill(text: string, tone: Tone): string {
  return `<span class="cpill${toneCls(tone)}">${esc(text)}</span>`;
}

// ---- misc -------------------------------------------------------------------

export function sectionRule(label: string): string {
  return `<div class="srule"><span>${esc(label)}</span><i></i></div>`;
}

export function grid2(a: string, b: string): string {
  return `<div class="g2">${a}${b}</div>`;
}

export function stack(...parts: string[]): string {
  return `<div class="vstack">${parts.join("")}</div>`;
}

export function view(...parts: string[]): string {
  return `<div class="vwrap">${parts.join("")}</div>`;
}
