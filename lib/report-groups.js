// lib/report-groups.js — the groups of a summary report (D-093, 2026-11-11). PURE: no I/O.
//
// sundial_report_run answers a summary run (showDetails) with its detail rows sorted by the
// group value, and `groups`: one entry per group ON THE PAGE, { key, first, shown, count,
// aggregates } — `first` / `shown` say which rows of the page are the group's (one unbroken
// run), `count` / `aggregates` cover ALL the group's rows. This file is what the screen
// response, the CSV (lib/report-csv.js) and the scheduled email (lib/report-email.js) share:
//   groupLabel   the words a group is shown with ("November 2026", "Q4 2026", "(blank)")
//   labelGroups  the function's groups + their labels
//   sameKey      two group keys are the same group (keys are JSON values; a blank is null)
//   sections     a page's rows cut into [{ group, rows, records }] by first / shown

import { REPORT_UTC_OFFSET } from "./report-def.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const BLANK_GROUP_LABEL = "(blank)";

const OFFSET_MS = (() => {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(REPORT_UTC_OFFSET);
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
})();

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const shortDate = (y, m, d) => `${MONTHS[m - 1]} ${d}, ${y}`;

/**
 * The label of one group. `group` is normalizeDefinition()'s `group` output column
 * ({ type, dateTrunc? }). A period (dateTrunc) is named by its period: "Nov 3, 2026",
 * "Week of Nov 2, 2026", "November 2026", "Q4 2026", "2026".
 */
export function groupLabel(key, group) {
  if (key === null || key === undefined || key === "") return BLANK_GROUP_LABEL;
  const s = String(key);
  const ymd = YMD.exec(s);
  if (group?.dateTrunc && ymd) {
    const [y, m, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
    switch (group.dateTrunc) {
      case "day": return shortDate(y, m, d);
      case "week": return `Week of ${shortDate(y, m, d)}`;
      case "month": return `${MONTH_NAMES[m - 1]} ${y}`;
      case "quarter": return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
      case "year": return String(y);
    }
  }
  switch (group?.type) {
    case "boolean":
      return key === true || key === "true" ? "Yes" : key === false || key === "false" ? "No" : s;
    case "date":
      return ymd ? shortDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3])) : s;
    case "datetime": {
      const ms = Date.parse(s);
      if (!Number.isFinite(ms)) return s;
      return new Date(ms + OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
    }
    default:
      return s;
  }
}

/** The function's groups with their labels: [{ key, label, count, aggregates, first, shown }]. */
export function labelGroups(groups, group) {
  return (Array.isArray(groups) ? groups : []).map((g) => ({
    key: g.key ?? null,
    label: groupLabel(g.key, group),
    count: Number(g.count ?? 0),
    aggregates: g.aggregates ?? {},
    first: Number(g.first ?? 0),
    shown: Number(g.shown ?? 0),
  }));
}

/** Are two group keys the same group? (JSON values: "Ann", 5, true, "2026-11-01", null.) */
export function sameKey(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** A page's rows cut into its groups, in page order: [{ group, rows, records }]. */
export function sections(rows, groups, records = null) {
  return (Array.isArray(groups) ? groups : []).map((g) => ({
    group: g,
    rows: rows.slice(g.first, g.first + g.shown),
    records: records ? records.slice(g.first, g.first + g.shown) : null,
  }));
}
