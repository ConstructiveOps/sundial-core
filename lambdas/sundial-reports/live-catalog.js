// sundial-reports/live-catalog.js — one report type's catalog with its picklist values read live
// from the Salesforce describe (D-089 am. 2; lib/report-live-picklists.js says why and how).
// Used by GET /reports/catalog and the report assistant's per-type prompt block.

import { CATALOG } from "../../lib/report-catalog/index.js";
import { reportType, aliasesOf } from "../../lib/report-types.js";
import { liveCatalog } from "../../lib/report-live-picklists.js";

/** The catalog with live picklist values for every object the type reads. Never throws. */
export async function liveCatalogForType(typeKey) {
  const t = reportType(typeKey);
  if (!t) return CATALOG;
  return liveCatalog([...aliasesOf(t).values()]);
}
