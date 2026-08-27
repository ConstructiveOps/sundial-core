// Sundial access model — the single authority for row and action authorization.
//
// D-064 (docs/access-model.md §1.3, §3). Every Lambda that reads, writes, or acts on a
// record calls into here; NONE re-implement the rules. That is the whole point: the
// system this replaces spread its one authorization decision across a hardcoded rep
// name in sundial-sf-query, a 403 in sundial-list-files, and a rail-id list in the
// browser, and the three disagreed.
//
// ⚠️ NOT WIRED INTO ANY LAMBDA YET. Phase 1 builds and tests this module; Phase 2 wires
// it into sundial-sf-query behind ACCESS_MODEL_MODE=shadow, where it computes an answer
// and logs it without serving it. Nothing here changes what any user sees today.
//
// ---------------------------------------------------------------------------
// EVERY DEFAULT IN THIS FILE IS "DENY", AND THAT IS THE CHANGE
// ---------------------------------------------------------------------------
// The TEMP guard it replaces defaults OPEN: `repRestrictFor()` returns null -- meaning
// no restriction -- for any hierarchy value it does not recognize. Measured consequence
// (Phase 0, scripts/verify-access-matrix.mjs): a Technician sees all 31,638 customers,
// every solar project, roofing, POs and Solar files, because "Technician" is not the one
// string the guard matches on.
//
// So: an unknown access level resolves to `none`. A null level resolves to `none`. A
// sales role with no dealer resolves to `none`. A sales role whose dealer is inactive
// resolves to `none`. An unknown object key is denied. An unknown action key is denied.
// A malformed AccessContext is denied. There is no branch in this file that grants
// access because it did not recognize its input.
//
// Value-safety: pure functions over plain objects. No I/O, no secrets, no logging.

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/** The four row-visibility classes (§1.2). Ordered widest to narrowest. */
export const SCOPES = Object.freeze({
  TENANT: "tenant",
  DEALER: "dealer",
  OWN: "own",
  NONE: "none",
});

/**
 * Access_Level__c -> scope. THE ONLY input to role resolution (§1.1).
 *
 * Hierarchy_Level__c, Roles__c and Parent_User__c are deliberately absent: the first is
 * a derived, unread value after Phase 0 (§10), the second has zero code references in
 * either repo, and the third is superseded by Sundial_User__c.Dealer__c.
 *
 * `Manager` here is an OFFICE manager -- Harmon staff -- not a sales manager. A dealer's
 * sales manager is `Sales Dealer`. That distinction is the difference between seeing the
 * whole tenant and seeing one dealer's book, so it is worth stating where the table is.
 */
export const SCOPE_BY_ACCESS_LEVEL = Object.freeze({
  Executive: SCOPES.TENANT,
  Admin: SCOPES.TENANT,
  Manager: SCOPES.TENANT,
  "Sales Dealer": SCOPES.DEALER,
  "Sales Rep": SCOPES.OWN,
  // Defined in Phase II (Service). Until then a Technician login sees NOTHING -- which
  // is a deliberate narrowing from today, where they see everything. §7's shadow report
  // names every live user this would affect before it takes effect.
  Technician: SCOPES.NONE,
});

/** The scopes that mean "a sales role" -- row-limited rather than tenant-wide. */
export const SALES_SCOPES = Object.freeze(new Set([SCOPES.DEALER, SCOPES.OWN]));

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

/**
 * Per-object row filter columns, and which scopes may reach the object at all (§3.1).
 *
 * `repColumn`/`repField` is the `own` filter; `dealerColumn`/`dealerField` is the
 * `dealer` filter. An object with `salesScopes: false` is denied to BOTH sales scopes
 * outright -- the module gate -- regardless of whether it happens to carry the columns.
 *
 * The cache column names are not chosen here: they are what `sfFieldToColumn()` in
 * sundial-cache-sync produces for those Salesforce fields (a `reference` field becomes
 * its lowercased name plus `_sf_id`). Writing them out again is how a rename in one
 * place fails visibly in the other instead of silently filtering on a column of nulls.
 */
export const OBJECT_ACCESS = Object.freeze({
  customer: Object.freeze({
    sfObject: "Sundial_Customer__c",
    cacheTable: "sundial_customer_cache",
    salesScopes: true,
    repField: "Sales_Rep__c",
    repColumn: "sales_rep_sf_id",
    dealerField: "Dealer__c",
    dealerColumn: "dealer_sf_id",
  }),
  solar: Object.freeze({
    sfObject: "Sundial_Solar__c",
    cacheTable: "sundial_solar_cache",
    salesScopes: true,
    repField: "Sales_Rep__c",
    repColumn: "sales_rep_sf_id",
    dealerField: "Dealer__c",
    dealerColumn: "dealer_sf_id",
  }),
  // Roofing CARRIES both columns and is still denied to sales roles. The module gate is
  // a separate decision from whether the data model could support a filter, and
  // conflating them is how "we added the column, so it must be open" happens.
  roofing: Object.freeze({
    sfObject: "Sundial_Roofing__c",
    cacheTable: "sundial_roofing_cache",
    salesScopes: false,
    repField: "Sales_Rep__c",
    repColumn: "sales_rep_sf_id",
    dealerField: "Dealer__c",
    dealerColumn: "dealer_sf_id",
  }),
  commercial: Object.freeze({
    sfObject: "Sundial_Commercial__c",
    cacheTable: "sundial_commercial_cache",
    salesScopes: false,
  }),
  po: Object.freeze({
    sfObject: "Sundial_PO__c",
    cacheTable: "sundial_po_cache",
    salesScopes: false,
  }),
  po_credit: Object.freeze({
    sfObject: "Sundial_PO_Credit__c",
    cacheTable: "sundial_po_credit_cache",
    salesScopes: false,
  }),
  // `user` is reachable by sales scopes but NOT by a row filter of this shape -- §3.5
  // returns "your own dealer's people plus Harmon staff", a union, not an equality.
  // rowFilter() therefore refuses it explicitly rather than returning something that
  // looks like an answer. Phase 3 builds userFilter() beside this.
  user: Object.freeze({
    sfObject: "Sundial_User__c",
    cacheTable: "sundial_user_cache",
    salesScopes: true,
    unionFilter: true,
  }),
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Action key -> the scopes allowed to perform it (§3.6). One table, so a Lambda's only
 * job is `canAction("budget.recalc", access)`.
 *
 * Only ONE action is open to sales roles: `aurora.design_request`. Tim's call
 * (§12.2) -- a rep sending a design request is the job, and the dealer's name and the
 * stamped rep flow into the Aurora project. It is still gated on the record being
 * visible, which `canAction` cannot know: the caller must ALSO call
 * assertVisibleRecord(). An action key that is allowed is not a record that is visible.
 */
export const ACTION_SCOPES = Object.freeze({
  "customer.create": Object.freeze([SCOPES.TENANT, SCOPES.DEALER, SCOPES.OWN]),
  "aurora.design_request": Object.freeze([SCOPES.TENANT, SCOPES.DEALER, SCOPES.OWN]),

  "files.customer.list": Object.freeze([SCOPES.TENANT, SCOPES.DEALER, SCOPES.OWN]),
  "files.customer.download": Object.freeze([SCOPES.TENANT, SCOPES.DEALER, SCOPES.OWN]),
  "files.customer.upload": Object.freeze([SCOPES.TENANT, SCOPES.DEALER, SCOPES.OWN]),
  "files.customer.delete": Object.freeze([SCOPES.TENANT]),

  // All four Solar file routes, including list-related-files, which is ungated today.
  "files.solar.list": Object.freeze([SCOPES.TENANT]),
  "files.solar.related": Object.freeze([SCOPES.TENANT]),
  "files.solar.upload": Object.freeze([SCOPES.TENANT]),
  "files.solar.delete": Object.freeze([SCOPES.TENANT]),
  "files.copy_to_solar": Object.freeze([SCOPES.TENANT]),

  "project.create": Object.freeze([SCOPES.TENANT]),
  "budget.recalc": Object.freeze([SCOPES.TENANT]),
  "budget.push": Object.freeze([SCOPES.TENANT]),
  "budget.attributes_sync": Object.freeze([SCOPES.TENANT]),
  "acumatica.sync": Object.freeze([SCOPES.TENANT]),
  "commission.po": Object.freeze([SCOPES.TENANT]),
});

/** Denial codes, so callers do not invent their own spellings (§3.1, §3.4). */
export const DENY = Object.freeze({
  MODULE_FORBIDDEN: "MODULE_FORBIDDEN",
  ACTION_FORBIDDEN: "ACTION_FORBIDDEN",
  RECORD_NOT_FOUND: "RECORD_NOT_FOUND",
  FIELD_FORBIDDEN: "FIELD_FORBIDDEN",
});

// ---------------------------------------------------------------------------
// resolveScope
// ---------------------------------------------------------------------------

const nonEmpty = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/**
 * Turn a resolved Sundial_User__c identity into the AccessContext every helper takes.
 *
 * @param {object} user - the `user` half of resolveIdentity()'s return, plus `dealer`
 *   (the Dealer__r sub-object) when one is present.
 * @param {string|null} tenantId - the Client__c record id (the isolation key).
 * @returns {{level, scope, userId, dealerId, tenantId, dealerActive, dealerInternal}}
 *
 * The four ways this returns `none`, and why each is a rule rather than an accident:
 *
 *   1. NO ACCESS LEVEL. A user record with a blank Access_Level__c has never been given
 *      a role. Granting one by default is how the TEMP guard ended up showing a
 *      Technician the whole org.
 *   2. UNKNOWN ACCESS LEVEL. A picklist value nobody has mapped -- a new role added in
 *      Salesforce before the code knows about it. The safe reading of "a role I do not
 *      recognize" is "no access", and the loud failure that follows is the point.
 *   3. SALES ROLE, NO DEALER. §1.2: a null Dealer__c resolves to `none`, NOT to "all
 *      dealers". This is the one people get wrong, because a null foreign key reads as
 *      "unfiltered" in SQL. A rep with no dealer is a rep nobody has attributed yet.
 *   4. SALES ROLE, INACTIVE DEALER. §2.1. Deactivating a dealer is how their access is
 *      switched off; if that only stopped NEW users, it would not be an off switch.
 *
 * Tenant-wide roles never read the dealer at all, so Harmon staff with a null Dealer__c
 * are correctly unaffected by 3 and 4.
 */
export function resolveScope(user, tenantId = null) {
  const level = nonEmpty(user?.accessLevel);
  const userId = nonEmpty(user?.id);
  const dealer = user?.dealer ?? null;
  const dealerId = nonEmpty(dealer?.id ?? user?.dealerId);
  const dealerActive = dealer ? dealer.active === true : null;
  const dealerInternal = dealer ? dealer.isInternal === true : null;

  const base = {
    level,
    userId,
    dealerId,
    tenantId: nonEmpty(tenantId),
    dealerActive,
    dealerInternal,
  };

  const mapped = level === null ? undefined : own(SCOPE_BY_ACCESS_LEVEL, level);
  if (mapped === undefined) return { ...base, scope: SCOPES.NONE };

  if (SALES_SCOPES.has(mapped)) {
    // A sales role with nothing to scope BY is a sales role with no scope.
    if (dealerId === null) return { ...base, scope: SCOPES.NONE };
    // `dealerActive === null` means the identity query returned a Dealer__c id but no
    // Dealer__r sub-object -- the caller did not select Dealer__r.Active__c. Treat that
    // as "cannot confirm the dealer is active" and deny, rather than assuming. A missing
    // field in a SELECT list must never read as a permission.
    if (dealerActive !== true) return { ...base, scope: SCOPES.NONE };
    // An `own`-scope user filters on their own id, so a missing one is unfilterable.
    if (mapped === SCOPES.OWN && userId === null) return { ...base, scope: SCOPES.NONE };
  }

  return { ...base, scope: mapped };
}

// ---------------------------------------------------------------------------
// canReadObject / canAction
// ---------------------------------------------------------------------------

/**
 * Own-property lookup on a frozen table.
 *
 * ⚠️ NOT a stylistic preference. `OBJECT_ACCESS["__proto__"]` returns Object.prototype,
 * which is truthy — so a plain `table[key]` check made `canReadObject("__proto__", …)`
 * return TRUE for tenant scope. Found by the fail-closed test below, not by reading the
 * code. Every inherited key on Object.prototype (`constructor`, `toString`, …) is the
 * same hazard, and object keys reach these functions straight from a URL path segment.
 */
function own(table, key) {
  if (typeof key !== "string") return undefined;
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** Normalize whatever a caller passes as an AccessContext. Anything unusable -> none. */
function ctx(access) {
  const scope = access?.scope;
  if (scope !== SCOPES.TENANT && scope !== SCOPES.DEALER && scope !== SCOPES.OWN) {
    // Covers `none`, undefined, null, a typo, and a whole missing object.
    return { scope: SCOPES.NONE, userId: null, dealerId: null, tenantId: null };
  }
  return {
    scope,
    userId: nonEmpty(access.userId),
    dealerId: nonEmpty(access.dealerId),
    tenantId: nonEmpty(access.tenantId),
  };
}

/**
 * The module gate (§3.1): may this scope reach this object AT ALL?
 *
 * An unknown object key is denied. sundial-sf-query has its own OBJECT_ALLOWLIST and
 * would 404 first, but this function is called by other Lambdas too and must not depend
 * on somebody else having checked.
 */
export function canReadObject(objectKey, access) {
  const a = ctx(access);
  if (a.scope === SCOPES.NONE) return false;
  const def = own(OBJECT_ACCESS, objectKey);
  if (!def) return false;
  if (a.scope === SCOPES.TENANT) return true;
  return def.salesScopes === true;
}

/**
 * May this scope perform this action (§3.6)?
 *
 * ⚠️ THIS IS NOT A RECORD CHECK. `canAction("aurora.design_request", repAccess)` is true
 * for every rep; whether THIS rep may act on THAT customer is assertVisibleRecord()'s
 * question, and the caller must ask both. Conflating them would let a rep fire a design
 * request at any customer id in the tenant.
 *
 * An unknown action key is denied, so a typo in a Lambda fails closed rather than
 * silently authorizing.
 */
export function canAction(actionKey, access) {
  const a = ctx(access);
  if (a.scope === SCOPES.NONE) return false;
  const allowed = own(ACTION_SCOPES, actionKey);
  if (!allowed) return false;
  return allowed.includes(a.scope);
}

/** Every object key this scope may read -- for the `access.modules` block on /auth/me. */
export function modulesFor(access) {
  return Object.keys(OBJECT_ACCESS).filter((k) => canReadObject(k, access));
}

/** Every action key this scope may perform -- for `access.actions` on /auth/me. */
export function actionsFor(access) {
  return Object.keys(ACTION_SCOPES).filter((k) => canAction(k, access));
}

// ---------------------------------------------------------------------------
// rowFilter
// ---------------------------------------------------------------------------

/**
 * The row filter, in both dialects (§3.2).
 *
 * @returns {{deny: true, code: string} | {deny: false, cache: Array<{column,value}>, soql: string, soqlParams: object}}
 *
 * `cache` is a list of column/value equalities for the PostgREST query; `soql` is the
 * same predicate as a WHERE fragment with values ALREADY ESCAPED via soqlEscapeString-
 * equivalent quoting (see escapeSoqlValue below).
 *
 * ⚠️ THE TENANT CLAUSE IS ALWAYS PRESENT, in every branch including `tenant` scope. The
 * row filter and the tenant filter are the same object here on purpose: making the
 * caller remember to AND `client_sf_id` separately is how a refactor drops it. A context
 * with no tenantId is DENIED rather than filtered on the rep alone -- an unscoped query
 * that happens to be rep-filtered is still a cross-tenant query the day a second tenant
 * exists.
 *
 * ⚠️ THIS IS APPLIED FIRST AND EVERY CALLER FILTER IS ANDed AFTER IT (§1.3). No request
 * input -- `?q=`, `?parentId=`, `field/value` -- can widen it, because none of them can
 * reach inside a conjunction.
 */
export function rowFilter(objectKey, access) {
  const a = ctx(access);
  if (!canReadObject(objectKey, a)) {
    return { deny: true, code: DENY.MODULE_FORBIDDEN };
  }
  const def = own(OBJECT_ACCESS, objectKey);

  if (a.tenantId === null) {
    // No isolation key = no query. Never fall back to "just the rep clause".
    return { deny: true, code: DENY.MODULE_FORBIDDEN };
  }

  const cache = [{ column: "client_sf_id", value: a.tenantId }];
  const soql = [`Client__c = '${escapeSoqlValue(a.tenantId)}'`];

  if (a.scope === SCOPES.DEALER || a.scope === SCOPES.OWN) {
    if (def.unionFilter) {
      // `user` is a union, not an equality (§3.5). Refuse rather than return a filter
      // that would be wrong in a way the caller cannot see.
      return { deny: true, code: DENY.MODULE_FORBIDDEN };
    }
    const column = a.scope === SCOPES.OWN ? def.repColumn : def.dealerColumn;
    const field = a.scope === SCOPES.OWN ? def.repField : def.dealerField;
    const value = a.scope === SCOPES.OWN ? a.userId : a.dealerId;

    // The column must EXIST for the filter to mean anything. §3.3: until the cache
    // column is there the endpoint must DENY, not fall back to unfiltered -- the
    // opposite of the `created_date` "column absent -> stable order" tolerance, because
    // here absence means the filter cannot be applied at all.
    if (!column || !field || value === null) {
      return { deny: true, code: DENY.MODULE_FORBIDDEN };
    }
    cache.push({ column, value });
    soql.push(`${field} = '${escapeSoqlValue(value)}'`);
  }

  return { deny: false, cache, soql: soql.join(" AND ") };
}

/**
 * SOQL string-literal escaping, identical in behaviour to lib/salesforce.js's
 * soqlEscapeString. Duplicated deliberately: lib/access.js is a PURE module with no
 * imports, so it can be unit-tested and reasoned about without a Salesforce client, and
 * an authorization predicate should not depend on a module that does network I/O.
 * The two are four lines each and pinned by a test that asserts they agree.
 */
export function escapeSoqlValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ---------------------------------------------------------------------------
// assertVisibleRecord
// ---------------------------------------------------------------------------

/**
 * "May this context see this specific record?" -- as a SOQL existence check.
 *
 * Returns the SOQL to run, or a denial. The caller runs it and treats zero rows as
 * 404 RECORD_NOT_FOUND. This module does no I/O, so it builds the query rather than
 * executing it; that keeps the authorization logic unit-testable without a Salesforce
 * client and keeps every caller asking the same question the same way.
 *
 * @returns {{deny:true, code:string} | {deny:false, soql:string}}
 *
 * ⚠️ A DENIAL AND A MISS BOTH BECOME 404, NEVER 403. A record you may not see must be
 * indistinguishable from one that does not exist -- exactly as cross-tenant reads behave
 * today. A 403 on a record id confirms the record exists, which turns any detail
 * endpoint into an enumeration oracle for a rep who wants to know how big the tenant is.
 * (List and CREATE denials are 403 MODULE_FORBIDDEN, because "this module is closed to
 * you" leaks nothing about any particular record. §3.1.)
 */
export function assertVisibleRecord(objectKey, recordId, access) {
  const id = nonEmpty(recordId);
  if (id === null) return { deny: true, code: DENY.RECORD_NOT_FOUND };

  const filter = rowFilter(objectKey, access);
  if (filter.deny) return { deny: true, code: DENY.RECORD_NOT_FOUND };

  const def = own(OBJECT_ACCESS, objectKey);
  return {
    deny: false,
    soql:
      `SELECT Id FROM ${def.sfObject} ` +
      `WHERE Id = '${escapeSoqlValue(id)}' AND ${filter.soql} LIMIT 1`,
  };
}

/**
 * Does a CACHE ROW satisfy the row filter? The in-memory equivalent of rowFilter, for
 * the single-read cache shortcut (§3.2, "Single read (cache shortcut)").
 *
 * The TEMP guard SKIPS the cache shortcut for a restricted rep, because the field it
 * filtered on was not cached. Once `sales_rep_sf_id` and `dealer_sf_id` are columns, the
 * shortcut can check the row it already has -- which is what removes the live-SOQL
 * bypass and, with it, the 2000-row OFFSET cap that truncates deep pages today.
 *
 * A row missing the filter column returns FALSE, not true: an un-backfilled row is not
 * a visible row.
 */
export function rowMatchesFilter(objectKey, access, row) {
  const filter = rowFilter(objectKey, access);
  if (filter.deny) return false;
  if (!row || typeof row !== "object") return false;
  return filter.cache.every((c) => row[c.column] === c.value);
}

// ---------------------------------------------------------------------------
// The /auth/me access block
// ---------------------------------------------------------------------------

/**
 * The `access` object returned by GET /auth/me (§1.3) and mirrored into the
 * server-owned columns on public.profiles.
 *
 * The client REFLECTS this and never decides from it (§4.5): it hides navigation and
 * buttons the server would refuse anyway, so a rep does not meet a 403 in normal use.
 * A stale client is therefore safe -- it can only render a subset of what the server
 * already agreed to send. That is why this block is safe to ship before the enforcement
 * that backs it, and why Phase 1 ships it while Phase 2/3 do the enforcing.
 */
export function accessBlock(scopeCtx) {
  const a = ctx(scopeCtx);
  return {
    level: scopeCtx?.level ?? null,
    scope: a.scope,
    userId: a.userId,
    dealerId: a.dealerId,
    tenantId: a.tenantId,
    dealerActive: scopeCtx?.dealerActive ?? null,
    dealerInternal: scopeCtx?.dealerInternal ?? null,
    modules: modulesFor(a),
    actions: actionsFor(a),
  };
}

/** The three server-owned scope columns on public.profiles (§5.2). */
export function profileScopeColumns(scopeCtx) {
  const a = ctx(scopeCtx);
  return {
    access_scope: a.scope,
    access_level: scopeCtx?.level ?? null,
    dealer_sf_id: a.dealerId,
  };
}
