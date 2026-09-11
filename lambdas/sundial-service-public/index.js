// sundial-service-public — the CUSTOMER-facing estimate page's backend (D-072.7).
//
//   GET  /public/estimates/{token}            the rendered document + status (marks Viewed)
//   POST /public/estimates/{token}/accept     { name }   → Approved (method Online)
//   POST /public/estimates/{token}/decline    { reason } → Declined
//
// NO PORTAL LOGIN. The only credential is the token in the URL — 24 random bytes
// (base64url) issued once per estimate by the estimate Lambda's Send, stored in
// Sundial_Estimate__c.Public_Token__c (External ID) with Public_Token_Expires_At__c.
// That is the whole authorization model, so the rules are strict and few:
//   - the token resolves to exactly one estimate or the request is 404 (never "expired"
//     vs "wrong" — both are 404 so the URL space cannot be probed for shape);
//   - an expired token is 410 GONE with a short message (the customer had a real link);
//   - nothing here takes a record id, a tenant id, or a field name from the caller;
//   - the tenant is READ FROM THE ESTIMATE (Client__c) and stamped onto the activity row;
//   - accept/decline are idempotent: a second accept of an approved estimate is a 200
//     that says so, never a second approval.
// The document is rendered by lib/estimate-document.js in "customer" mode — the same
// renderer the office previews with, so the two can never differ.
//
// Card capture (Stripe SetupIntent / deposit) attaches to the accept step when Harmon's
// Stripe keys arrive; the page ships with Approve first (D-065.6 / D-072.7).
//
// Dependencies are injectable (createHandler) so test.js drives the real router.

import {
  sfQuery as realSfQuery,
  sfUpdateRecord as realSfUpdateRecord,
  soqlEscapeString,
} from "../../lib/salesforce.js";
import { getSupabaseClient as realGetSupabaseClient } from "../../lib/supabase.js";
import { corsHeaders, normalizeHeaders, jsonResponse, parseJsonBody, httpMethod } from "../../lib/http.js";
import { renderEstimateDocument, DEFAULT_BRAND } from "../../lib/estimate-document.js";
import { EVENTS, recordActivity } from "../../lib/service-activity.js";
import { computeTotals, lineFromRecord, estimateFromRecord } from "../sundial-service-estimate/totals.js";
import { LINE_SELECT, LINE_SF_OBJECT } from "../sundial-service-estimate/pricebook.js";
import { ESTIMATE_SELECT, ESTIMATE_SF_OBJECT } from "../sundial-service-estimate/fields.js";

const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

const ROUTES = [
  ["GET", /^\/public\/estimates\/([^/]+)\/?$/, "view"],
  ["POST", /^\/public\/estimates\/([^/]+)\/accept\/?$/, "accept"],
  ["POST", /^\/public\/estimates\/([^/]+)\/decline\/?$/, "decline"],
];

export function matchRoute(method, path) {
  const p = (path || "").replace(/^\/[^/]+(?=\/public\/)/, "");
  for (const [m, re, name] of ROUTES) {
    if (m !== method) continue;
    const hit = p.match(re);
    if (hit) return { name, token: decodeURIComponent(hit[1]) };
  }
  return null;
}

function notFound(cors) {
  return jsonResponse(404, cors, { error: "not_found", code: "ESTIMATE_NOT_FOUND" });
}

/** The parts of the estimate the customer page may see (never the internal fields). */
function publicSummary(est, totals) {
  return {
    number: est.Name ?? null,
    status: est.Status__c ?? null,
    version: Number(est.Version__c) || 0,
    total: totals.total,
    depositAmount: totals.depositAmount,
    depositRequired: est.Deposit_Required__c === true,
    validUntil: est.Valid_Until__c ?? null,
    approvedAt: est.Approved_At__c ?? null,
    approvedByName: est.Approved_By_Name__c ?? null,
    customerName: est.Customer_Name_at_Creation__c ?? null,
  };
}

export function createHandler(deps = {}) {
  const d = {
    sfQuery: realSfQuery,
    sfUpdateRecord: realSfUpdateRecord,
    getSupabaseClient: realGetSupabaseClient,
    now: () => new Date(),
    ...deps,
  };

  async function loadByToken(token) {
    if (!TOKEN_RE.test(token || "")) return null;
    const rows = await d.sfQuery(
      `SELECT ${ESTIMATE_SELECT} FROM ${ESTIMATE_SF_OBJECT} WHERE Public_Token__c = '${soqlEscapeString(token)}' LIMIT 2`
    );
    // Exactly one, or nothing: a token that somehow matched twice is a data problem,
    // and answering with either record would be guessing.
    return rows && rows.length === 1 ? rows[0] : null;
  }
  async function loadLines(est) {
    return (
      (await d.sfQuery(
        `SELECT ${LINE_SELECT} FROM ${LINE_SF_OBJECT} WHERE Estimate__c = '${soqlEscapeString(est.Id)}' ` +
          `AND Client__c = '${soqlEscapeString(est.Client__c)}' ORDER BY Sort_Order__c NULLS LAST, CreatedDate`
      )) || []
    );
  }
  function expired(est) {
    const exp = est.Public_Token_Expires_At__c ? new Date(est.Public_Token_Expires_At__c).getTime() : 0;
    return exp > 0 && exp < d.now().getTime();
  }
  async function act(est, event, details, actorName) {
    return recordActivity(d.getSupabaseClient, {
      tenantId: est.Client__c,
      event,
      recordType: "estimate",
      recordSfId: est.Id,
      estimateSfId: est.Id,
      jobSfId: est.Service_Job__c ?? null,
      actor: { id: null, name: actorName },
      details,
      at: d.now().toISOString(),
    });
  }
  const canAccept = (est) => ["Sent", "Viewed", "Draft"].includes(est.Status__c) && Number(est.Version__c) > 0;

  const H = {
    async view({ cors, token }) {
      const est = await loadByToken(token);
      if (!est || est.Is_Template__c === true) return notFound(cors);
      if (expired(est)) return jsonResponse(410, cors, { error: "expired", code: "LINK_EXPIRED", message: "This estimate link has expired. Please contact us for a fresh one." });
      const lines = await loadLines(est);
      const totals = computeTotals(lines.map(lineFromRecord), estimateFromRecord(est));
      // First open of a Sent estimate = Viewed. Best-effort; the page renders regardless.
      if (est.Status__c === "Sent" || !est.Last_Viewed_At__c) {
        try {
          const fields = { Last_Viewed_At__c: d.now().toISOString() };
          if (est.Status__c === "Sent") fields.Status__c = "Viewed";
          await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.Id, fields);
          if (est.Status__c === "Sent") {
            est.Status__c = "Viewed";
            await act(est, EVENTS.ESTIMATE_UPDATED, { viewed: true, version: Number(est.Version__c) || 0 }, "Customer");
          }
        } catch (e) {
          console.error("public view stamp failed:", e?.message || e);
        }
      }
      const brand = { ...DEFAULT_BRAND, companyName: deps.brandName || "" };
      const { html, title } = renderEstimateDocument({ estimate: est, lines, totals, brand, options: { mode: "customer" } });
      return jsonResponse(200, cors, { html, title, ...publicSummary(est, totals), canAccept: canAccept(est) });
    },

    async accept({ cors, token, body }) {
      const est = await loadByToken(token);
      if (!est || est.Is_Template__c === true) return notFound(cors);
      if (expired(est)) return jsonResponse(410, cors, { error: "expired", code: "LINK_EXPIRED" });
      const name = String(body?.name ?? "").trim().slice(0, 120);
      if (!name) return jsonResponse(400, cors, { error: "bad_request", code: "NAME_REQUIRED", message: "Please type your name to approve." });
      const lines = await loadLines(est);
      const totals = computeTotals(lines.map(lineFromRecord), estimateFromRecord(est));
      if (est.Status__c === "Approved") {
        return jsonResponse(200, cors, { success: true, alreadyApproved: true, ...publicSummary(est, totals) });
      }
      if (!canAccept(est)) {
        return jsonResponse(409, cors, { error: "not_acceptable", code: "ESTIMATE_NOT_OPEN", status: est.Status__c, message: "This estimate can no longer be approved online. Please contact us." });
      }
      const fields = {
        Status__c: "Approved",
        Approved_At__c: d.now().toISOString(),
        Approved_Version__c: Number(est.Version__c) || 0,
        Approved_Amount__c: totals.total,
        Approval_Method__c: "Online",
        Approved_By_Name__c: name,
      };
      try {
        await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.Id, fields);
        for (const l of lines) {
          if (l.Stage__c === "Proposed") await d.sfUpdateRecord(LINE_SF_OBJECT, l.Id, { Stage__c: "Approved" });
        }
      } catch (e) {
        console.error("public accept failed:", e?.sfBody || e?.message || e);
        return jsonResponse(502, cors, { error: "salesforce_error", code: "SALESFORCE_ERROR", message: "We couldn't record your approval. Please try again or contact us." });
      }
      Object.assign(est, fields);
      await act(est, EVENTS.ESTIMATE_APPROVED, { method: "Online", approvedBy: name, version: fields.Approved_Version__c, amount: totals.total }, `Customer: ${name}`);
      return jsonResponse(200, cors, { success: true, ...publicSummary(est, totals) });
    },

    async decline({ cors, token, body }) {
      const est = await loadByToken(token);
      if (!est || est.Is_Template__c === true) return notFound(cors);
      if (expired(est)) return jsonResponse(410, cors, { error: "expired", code: "LINK_EXPIRED" });
      if (est.Status__c === "Approved" || est.Status__c === "Invoiced") {
        return jsonResponse(409, cors, { error: "not_declinable", code: "ESTIMATE_NOT_OPEN", status: est.Status__c });
      }
      const reason = String(body?.reason ?? "").trim().slice(0, 255) || null;
      try {
        await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.Id, { Status__c: "Declined", Declined_Reason__c: reason });
      } catch (e) {
        console.error("public decline failed:", e?.sfBody || e?.message || e);
        return jsonResponse(502, cors, { error: "salesforce_error", code: "SALESFORCE_ERROR" });
      }
      est.Status__c = "Declined";
      await act(est, EVENTS.ESTIMATE_DECLINED, { reason, online: true }, "Customer");
      return jsonResponse(200, cors, { success: true, status: "Declined" });
    },
  };

  return async function handler(event) {
    const method = httpMethod(event);
    const headers = normalizeHeaders(event?.headers);
    const cors = corsHeaders(headers["origin"]);
    if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
    const route = matchRoute(method, event?.rawPath || event?.path || "");
    if (!route) return jsonResponse(404, cors, { error: "not_found", code: "ROUTE_NOT_FOUND" });
    let body = {};
    if (method === "POST") {
      const parsed = parseJsonBody(event);
      body = parsed.ok ? parsed.data : {};
    }
    try {
      return await H[route.name]({ cors, token: route.token, body });
    } catch (err) {
      console.error(`service-public ${route.name} error:`, err?.sfBody || err?.message || err);
      return jsonResponse(500, cors, { error: "server_error" });
    }
  };
}

export const handler = createHandler({ brandName: process.env.SERVICE_BRAND_NAME || "" });
