// pricebook.js — pure helpers for Sundial_Price_Book_Item__c versioning and the
// item -> line snapshot (D-072.4; docs/service-data-model.md §4).
//
// Rules this encodes:
//   - A line snapshots price / split / cost / description / taxable from the item
//     VERSION it was added from, and records whether the price was overridden.
//   - "Update" = a clone with the same Item_Code__c, Version__c + 1, Is_Active__c
//     true; the old version becomes inactive with Superseded_By__c set.
//   - In-place edit is allowed only while nothing references the version; the
//     Lambda checks the line count and calls `inPlaceEditable`.

export const ITEM_SF_OBJECT = "Sundial_Price_Book_Item__c";
export const LINE_SF_OBJECT = "Sundial_Service_Line__c";

/** Every item field the portal may set on create / edit / new-version. */
export const ITEM_WRITABLE = Object.freeze({
  name: "Name",
  itemCode: "Item_Code__c",
  kind: "Kind__c",
  category: "Category__c",
  description: "Description__c",
  internalNotes: "Internal_Notes__c",
  unitOfMeasure: "Unit_of_Measure__c",
  defaultQuantity: "Default_Quantity__c",
  estimatedHours: "Estimated_Hours__c",
  laborCost: "Labor_Cost__c",
  materialCost: "Material_Cost__c",
  laborPrice: "Labor_Price__c",
  materialPrice: "Material_Price__c",
  taxable: "Taxable__c",
});

export const ITEM_SELECT =
  "Id, Name, Item_Code__c, Version__c, Is_Active__c, Superseded_By__c, Kind__c, Category__c, " +
  "Description__c, Internal_Notes__c, Unit_of_Measure__c, Default_Quantity__c, Estimated_Hours__c, " +
  "Labor_Cost__c, Material_Cost__c, Labor_Price__c, Material_Price__c, Price__c, Taxable__c, Client__c";

export const LINE_SELECT =
  "Id, Estimate__c, Price_Book_Item__c, Kind__c, Description__c, Quantity__c, Unit_of_Measure__c, " +
  "Unit_Price__c, Unit_Labor_Price__c, Unit_Material_Price__c, Unit_Labor_Cost__c, Unit_Material_Cost__c, " +
  "Price_Overridden__c, Line_Total__c, Taxable__c, Stage__c, Sort_Order__c, Show_Unit_Price__c, Source__c, " +
  "Added_By_Service_Call__c, Client__c";

const KINDS = new Set(["Labor", "Material", "Product", "Fee"]);

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Translate a portal item body into Salesforce fields. Unknown keys are refused
 * (returned in `rejected`) so a client cannot smuggle a field the popup never shows.
 * Kind decides which price halves are meaningful: Labor keeps Labor_Price only,
 * Material keeps Material_Price only, Product needs both, Fee uses Labor_Price as the
 * single price (fees are not labor for discount purposes — Kind__c says Fee).
 */
export function itemFieldsFromBody(body, { requireAll = false } = {}) {
  const src = body && typeof body === "object" ? body : {};
  const fields = {};
  const rejected = [];
  const problems = [];
  for (const [k, v] of Object.entries(src)) {
    const api = ITEM_WRITABLE[k];
    if (!api) {
      rejected.push(k);
      continue;
    }
    if (v === undefined) continue;
    if (["defaultQuantity", "estimatedHours", "laborCost", "materialCost", "laborPrice", "materialPrice"].includes(k)) {
      const n = num(v);
      if (v !== null && n === null) problems.push(`${k} must be a number`);
      fields[api] = n;
    } else if (k === "taxable") {
      fields[api] = v === true;
    } else {
      fields[api] = v == null ? null : String(v).trim();
    }
  }
  if (fields.Kind__c && !KINDS.has(fields.Kind__c)) problems.push(`kind must be one of ${[...KINDS].join(", ")}`);
  if (requireAll) {
    if (!fields.Name) problems.push("name is required");
    if (!fields.Item_Code__c) problems.push("itemCode is required");
    if (!fields.Kind__c) problems.push("kind is required");
    const hasPrice = num(fields.Labor_Price__c) != null || num(fields.Material_Price__c) != null;
    if (!hasPrice) problems.push("laborPrice or materialPrice is required");
  }
  if (fields.Item_Code__c) fields.Item_Code__c = fields.Item_Code__c.toUpperCase().replace(/\s+/g, "-");
  return { fields, rejected, problems };
}

/** The clone that "Update" creates. `edits` are already-translated SF fields. */
export function newVersionFields(current, edits, tenantId) {
  const base = {};
  for (const api of Object.values(ITEM_WRITABLE)) {
    if (current[api] !== undefined && current[api] !== null) base[api] = current[api];
  }
  return {
    ...base,
    ...edits,
    Item_Code__c: current.Item_Code__c, // never changes across versions
    Version__c: (Number(current.Version__c) || 1) + 1,
    Is_Active__c: true,
    Client__c: tenantId,
  };
}

/** What the old version gets when superseded. */
export function supersededFields(newId) {
  return { Is_Active__c: false, Superseded_By__c: newId };
}

/** True when the version has never been referenced by a line → in-place edit OK. */
export function inPlaceEditable(referencingLineCount) {
  return Number(referencingLineCount) === 0;
}

/**
 * Build the Sundial_Service_Line__c fields for "add from price book".
 * `overrides` may carry quantity, unitPrice, description, showUnitPrice, sortOrder,
 * source, addedByServiceCallId. Price_Overridden__c is set when the unit price differs
 * from the item's Price__c at add time.
 */
export function lineFromItem(item, overrides = {}, { estimateId, tenantId }) {
  const itemPrice = num(item.Price__c) ?? (num(item.Labor_Price__c) ?? 0) + (num(item.Material_Price__c) ?? 0);
  const unitPrice = num(overrides.unitPrice) ?? itemPrice;
  const qty = num(overrides.quantity) ?? num(item.Default_Quantity__c) ?? 1;
  const f = {
    Estimate__c: estimateId,
    Price_Book_Item__c: item.Id,
    Client__c: tenantId,
    Kind__c: item.Kind__c || "Labor",
    Description__c: (overrides.description ?? item.Description__c ?? item.Name ?? "").toString().slice(0, 255),
    Quantity__c: qty,
    Unit_of_Measure__c: item.Unit_of_Measure__c || "Each",
    Unit_Price__c: unitPrice,
    Unit_Labor_Price__c: num(item.Labor_Price__c),
    Unit_Material_Price__c: num(item.Material_Price__c),
    Unit_Labor_Cost__c: num(item.Labor_Cost__c),
    Unit_Material_Cost__c: num(item.Material_Cost__c),
    Price_Overridden__c: Math.abs(unitPrice - itemPrice) > 0.004,
    Taxable__c: item.Taxable__c === true,
    Stage__c: overrides.stage || "Proposed",
    Show_Unit_Price__c: overrides.showUnitPrice !== false,
    Source__c: overrides.source || "Price Book",
  };
  if (overrides.sortOrder != null) f.Sort_Order__c = num(overrides.sortOrder);
  if (overrides.addedByServiceCallId) f.Added_By_Service_Call__c = String(overrides.addedByServiceCallId);
  return f;
}

/** Build an AD-HOC line (no catalog item). description, kind, unitPrice required. */
export function adHocLine(body, { estimateId, tenantId }) {
  const problems = [];
  const description = (body?.description ?? "").toString().trim();
  const kind = body?.kind || "Labor";
  const unitPrice = num(body?.unitPrice);
  if (!description) problems.push("description is required for an ad-hoc line");
  if (!KINDS.has(kind)) problems.push(`kind must be one of ${[...KINDS].join(", ")}`);
  if (unitPrice === null) problems.push("unitPrice is required for an ad-hoc line");
  if (problems.length) return { problems };
  const f = {
    Estimate__c: estimateId,
    Client__c: tenantId,
    Kind__c: kind,
    Description__c: description.slice(0, 255),
    Quantity__c: num(body?.quantity) ?? 1,
    Unit_of_Measure__c: body?.unitOfMeasure || "Each",
    Unit_Price__c: unitPrice,
    Unit_Labor_Price__c: num(body?.unitLaborPrice),
    Unit_Material_Price__c: num(body?.unitMaterialPrice),
    Price_Overridden__c: false,
    Taxable__c: body?.taxable === true,
    Stage__c: body?.stage || "Proposed",
    Show_Unit_Price__c: body?.showUnitPrice !== false,
    Source__c: body?.source || "Ad hoc",
  };
  if (body?.sortOrder != null) f.Sort_Order__c = num(body.sortOrder);
  if (body?.addedByServiceCallId) f.Added_By_Service_Call__c = String(body.addedByServiceCallId);
  for (const k of Object.keys(f)) if (f[k] === null) delete f[k];
  return { fields: f };
}

/** Editable line fields on PATCH, translated. Unknown keys rejected. */
export function linePatchFields(body) {
  const map = {
    description: (v) => ["Description__c", v == null ? null : String(v).slice(0, 255)],
    quantity: (v) => ["Quantity__c", num(v)],
    unitPrice: (v) => ["Unit_Price__c", num(v)],
    stage: (v) => ["Stage__c", v],
    sortOrder: (v) => ["Sort_Order__c", num(v)],
    showUnitPrice: (v) => ["Show_Unit_Price__c", v === true],
    taxable: (v) => ["Taxable__c", v === true],
    kind: (v) => ["Kind__c", v],
  };
  const fields = {};
  const rejected = [];
  for (const [k, v] of Object.entries(body || {})) {
    if (!map[k]) {
      rejected.push(k);
      continue;
    }
    const [api, val] = map[k](v);
    fields[api] = val;
  }
  if (fields.Kind__c && !KINDS.has(fields.Kind__c)) return { fields: {}, rejected, problems: ["invalid kind"] };
  if (fields.Stage__c && !["Proposed", "Approved", "Completed", "Removed"].includes(fields.Stage__c)) {
    return { fields: {}, rejected, problems: ["invalid stage"] };
  }
  return { fields, rejected, problems: [] };
}

/**
 * Link an existing line to a catalog item ("save this ad-hoc line to the price book",
 * or re-point a line at an item). The LINE keeps its description, quantity and unit
 * price — it is the thing the office already priced — and adopts the item's identity:
 * kind, taxability, unit of measure, and the labor/material price + cost split the
 * reports need. Price_Overridden__c is recomputed against the item's Price__c so a
 * line saved at the item's own price is not flagged.
 */
export function linkLineToItem(line, item) {
  const itemPrice = num(item.Price__c) ?? (num(item.Labor_Price__c) ?? 0) + (num(item.Material_Price__c) ?? 0);
  const unitPrice = num(line.Unit_Price__c) ?? itemPrice;
  return {
    Price_Book_Item__c: item.Id,
    Source__c: "Price Book",
    Kind__c: item.Kind__c || line.Kind__c || "Labor",
    Unit_of_Measure__c: item.Unit_of_Measure__c || line.Unit_of_Measure__c || "Each",
    Unit_Labor_Price__c: num(item.Labor_Price__c),
    Unit_Material_Price__c: num(item.Material_Price__c),
    Unit_Labor_Cost__c: num(item.Labor_Cost__c),
    Unit_Material_Cost__c: num(item.Material_Cost__c),
    Taxable__c: item.Taxable__c === true,
    Price_Overridden__c: Math.abs(unitPrice - itemPrice) > 0.004,
  };
}

/** Clone a template's lines onto a working estimate (re-snapshotting is the caller's job). */
export function cloneLineFields(line, { estimateId, tenantId, sortOffset = 0 }) {
  const f = {
    Estimate__c: estimateId,
    Client__c: tenantId,
    Price_Book_Item__c: line.Price_Book_Item__c ?? null,
    Kind__c: line.Kind__c,
    Description__c: line.Description__c,
    Quantity__c: line.Quantity__c,
    Unit_of_Measure__c: line.Unit_of_Measure__c,
    Unit_Price__c: line.Unit_Price__c,
    Unit_Labor_Price__c: line.Unit_Labor_Price__c,
    Unit_Material_Price__c: line.Unit_Material_Price__c,
    Unit_Labor_Cost__c: line.Unit_Labor_Cost__c,
    Unit_Material_Cost__c: line.Unit_Material_Cost__c,
    Price_Overridden__c: line.Price_Overridden__c === true,
    Taxable__c: line.Taxable__c === true,
    Stage__c: "Proposed",
    Sort_Order__c: (Number(line.Sort_Order__c) || 0) + sortOffset,
    Show_Unit_Price__c: line.Show_Unit_Price__c !== false,
    Source__c: "Template",
  };
  for (const k of Object.keys(f)) if (f[k] === null || f[k] === undefined) delete f[k];
  return f;
}
