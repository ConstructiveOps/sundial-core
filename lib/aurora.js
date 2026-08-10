// lib/aurora.js — shared client for Aurora Solar's REST API (inbound retrieval).
//
// Endpoint shapes, response fields, and the rules encoded here come from
// docs/integrations/aurora-api-reference.md. Read that first; this file is the
// executable half of it.
//
// THE 403 RULE: Aurora returns 403 when an endpoint is not PROVISIONED for our API
// key ("contact your Aurora account team") — it is not an auth bug on our side and
// not something a retry will fix. Every call here surfaces that distinctly
// (AuroraError.notProvisioned) so callers can dead-letter loudly instead of
// retrying forever.
//
// Value-safety: the api_key is never logged, returned, or included in an error.

import { getSecret } from "./secrets.js";

// Aurora API credentials/config. Shape: { base_url, tenant_id, api_key }.
// (The same secret also carries webhook_token for the inbound doorbell.)
export const AURORA_SECRET_NAME = "sundial/aurora/api";

/**
 * An Aurora API failure. `notProvisioned` is true for a 403 — the "your key can't
 * use this endpoint" case, which is permanent until Aurora changes it.
 */
export class AuroraError extends Error {
  constructor(message, { status, body, notProvisioned = false, endpoint } = {}) {
    super(message);
    this.name = "AuroraError";
    this.status = status ?? null;
    this.body = body ?? null;
    this.notProvisioned = notProvisioned;
    this.endpoint = endpoint ?? null;
  }
}

let configCache = null;
export async function getAuroraConfig() {
  if (configCache) return configCache;
  const secret = await getSecret(AURORA_SECRET_NAME);
  const baseUrl = String(secret?.base_url ?? "").trim();
  const tenantId = String(secret?.tenant_id ?? "").trim(); // AURORA tenant UUID
  const apiKey = String(secret?.api_key ?? "").trim();
  const missing = [];
  if (!baseUrl) missing.push("base_url");
  if (!tenantId) missing.push("tenant_id");
  if (!apiKey) missing.push("api_key");
  if (missing.length > 0) {
    throw new Error(
      `Secret "${AURORA_SECRET_NAME}" is missing field(s): ${missing.join(", ")}.`
    );
  }
  configCache = { baseUrl: baseUrl.replace(/\/+$/, ""), tenantId, apiKey };
  return configCache;
}

/** Test seam: drop the cached config (also used to re-read a rotated secret). */
export function resetAuroraConfigCache() {
  configCache = null;
}

// Aurora's error body is { errors: [ { message } ] } on 4xx/422. Pull the messages
// out for logs/emails; fall back to raw text so nothing is swallowed.
function summarizeError(parsed, raw) {
  const messages = Array.isArray(parsed?.errors)
    ? parsed.errors.map((e) => e?.message).filter(Boolean)
    : [];
  return messages.length > 0 ? messages.join("; ") : raw || "";
}

/**
 * One Aurora API call, relative to /tenants/{tenant_id}. Returns the parsed JSON
 * body. Throws AuroraError on any non-2xx (with notProvisioned set for 403).
 *
 * @param {"GET"|"POST"} method
 * @param {string} path - e.g. `/agreements/${id}` (tenant prefix added here)
 */
export async function auroraRequest(method, path, { body } = {}) {
  const cfg = await getAuroraConfig();
  const url = `${cfg.baseUrl}/tenants/${cfg.tenantId}${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await resp.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body — keep the raw text for the error path */
  }

  if (!resp.ok) {
    const notProvisioned = resp.status === 403;
    const detail = summarizeError(parsed, text);
    throw new AuroraError(
      notProvisioned
        ? `Aurora endpoint not provisioned for our API key (403): ${path}. ` +
          `This needs Aurora's account team, not a retry.${detail ? ` — ${detail}` : ""}`
        : `Aurora ${method} ${path} failed (${resp.status})${detail ? `: ${detail}` : ""}`,
      { status: resp.status, body: parsed ?? text, notProvisioned, endpoint: path }
    );
  }
  return parsed;
}

// --- Retrieval endpoints ----------------------------------------------------
// Each returns the inner object (Aurora wraps everything one level deep).

/** GET /agreements/{id} -> agreement { id, status, signing_provider, ... } */
export async function getAgreement(agreementId) {
  const data = await auroraRequest("GET", `/agreements/${encodeURIComponent(agreementId)}`);
  return data?.agreement ?? null;
}

/**
 * GET /projects/{id} -> project.
 *
 * Verified against Aurora's public reference 2026-08-07. Fields we rely on:
 *   customer_salutation / customer_first_name / customer_last_name /
 *   customer_email / customer_phone / mailing_address
 *   id, name, external_provider_id, status, tags[], project_type
 *   owner_id (UUID, the user who owns the project)
 *   team_id (UUID), partner_id (UUID, the PARTNER = external business group;
 *     this is Aurora's third-party-dealer concept)
 *   location.property_address, location.latitude, location.longitude,
 *   location.property_address_components.{ street_address, city, region,
 *     postal_code, country }        <-- NOTE: nested under `location`
 *   created_at ("YYYY-MM-DD HH:MM:SS UTC"), created_from_lead_id, order_id, ahj_id
 *   preferred_solar_modules[]
 */
export async function getProject(projectId) {
  const data = await auroraRequest("GET", `/projects/${encodeURIComponent(projectId)}`);
  return data?.project ?? null;
}

/**
 * GET /partners -> partners[] { id, name }.
 *
 * Aurora "partners" are external business user groups — users assigned to a
 * partner can only see that partner's projects. That is exactly Harmon's
 * third-party dealer, so a project's partner_id resolved through here is the
 * dealer name. There is NO single-partner GET in the spec, so callers list and
 * match by id (the list is small; cache it).
 */
export async function listPartners() {
  const data = await auroraRequest("GET", `/partners`);
  return Array.isArray(data?.partners) ? data.partners : [];
}

/**
 * GET /users/{id} -> user { id, first_name, last_name, email, account_status,
 * phone, title, job_function, external_provider_id, role_id, team_ids[],
 * partner_ids[], locale, ... }. Used to resolve a project's owner_id to a person
 * when there is no partner_id.
 */
export async function getUser(userId) {
  const data = await auroraRequest("GET", `/users/${encodeURIComponent(userId)}`);
  return data?.user ?? null;
}

/** GET /designs/{id}/summary -> design { system_size_stc (W), bill_of_materials[], energy_production, ... } */
export async function getDesignSummary(designId) {
  const data = await auroraRequest("GET", `/designs/${encodeURIComponent(designId)}/summary`);
  return data?.design ?? null;
}

/** GET /designs/{id}/proposals/default -> proposal { id, proposal_link, ... } */
export async function getDefaultProposal(designId) {
  const data = await auroraRequest(
    "GET",
    `/designs/${encodeURIComponent(designId)}/proposals/default`
  );
  return data?.proposal ?? null;
}

/**
 * GET /designs/{designId}/financings/{financingId} -> financing.
 * NOTE THE PATH: financing is DESIGN-scoped, so both ids are required. The caller
 * must skip this entirely when the webhook's FINANCING_ID is empty (no financing
 * option was selected on the design).
 */
export async function getFinancing(designId, financingId) {
  const data = await auroraRequest(
    "GET",
    `/designs/${encodeURIComponent(designId)}/financings/${encodeURIComponent(financingId)}`
  );
  return data?.financing ?? null;
}

// --- Signed-agreement PDF (async job) ---------------------------------------

/**
 * POST /agreements/{id}/download_url/run — starts generation of the signed-PDF
 * download URL. Docusign-only, and the agreement must already be `signed`.
 * Returns the job object (status in-progress|succeeded|failed).
 */
export async function startAgreementDownload(agreementId) {
  const data = await auroraRequest(
    "POST",
    `/agreements/${encodeURIComponent(agreementId)}/download_url/run`
  );
  return data?.agreement_download_url_job ?? null;
}

/** GET /agreements/{id}/download_url/status?job_id=... -> the same job object. */
export async function getAgreementDownloadStatus(agreementId, jobId) {
  const data = await auroraRequest(
    "GET",
    `/agreements/${encodeURIComponent(agreementId)}/download_url/status` +
      `?job_id=${encodeURIComponent(jobId)}`
  );
  return data?.agreement_download_url_job ?? null;
}

/**
 * Start the download job and poll until it succeeds, then return `file_url`.
 *
 * ⚠️ file_url EXPIRES 15 MINUTES after generation, so the caller must fetch the
 * bytes immediately — never persist this URL or hand it to a user. Jobs typically
 * complete in seconds, so polling beats subscribing to the completion webhook.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=10] - poll attempts after the initial start
 * @param {number} [opts.intervalMs=1500]
 * @param {(ms:number)=>Promise<void>} [opts.sleep] - injectable for tests
 * @returns {Promise<{ fileUrl: string, jobId: string }>}
 */
export async function fetchSignedAgreementUrl(agreementId, opts = {}) {
  const {
    maxAttempts = 10,
    intervalMs = 1500,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  const started = await startAgreementDownload(agreementId);
  const jobId = started?.job_id;
  if (!jobId) {
    throw new AuroraError("Aurora download job returned no job_id.", {
      endpoint: `/agreements/${agreementId}/download_url/run`,
    });
  }
  // The job can already be done on the first response.
  let job = started;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (job?.status === "succeeded" && job?.file_url) {
      return { fileUrl: job.file_url, jobId };
    }
    if (job?.status === "failed") {
      throw new AuroraError(
        `Aurora download job failed: ${job?.error || "no error detail"}`,
        { endpoint: `/agreements/${agreementId}/download_url/status` }
      );
    }
    await sleep(intervalMs);
    job = await getAgreementDownloadStatus(agreementId, jobId);
  }
  throw new AuroraError(
    `Aurora download job did not complete after ${maxAttempts} polls (last status: ${job?.status ?? "unknown"}).`,
    { endpoint: `/agreements/${agreementId}/download_url/status` }
  );
}

/**
 * Download the signed PDF bytes from a job's file_url.
 *
 * The URL is pre-signed and short-lived, so this deliberately does NOT retry on
 * 403/404 — an expired link must be recovered by re-running the job, not by
 * hammering a dead URL. `expired` is set so the caller can decide.
 */
export async function downloadSignedAgreement(fileUrl) {
  const resp = await fetch(fileUrl);
  if (!resp.ok) {
    const expired = resp.status === 403 || resp.status === 404;
    throw new AuroraError(
      `Signed-agreement download failed (${resp.status})${
        expired ? " — the 15-minute file_url has most likely expired; re-run the job." : ""
      }`,
      { status: resp.status, endpoint: "file_url", notProvisioned: false }
    );
  }
  return Buffer.from(await resp.arrayBuffer());
}
