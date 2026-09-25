// lib/brand.js — the tenant's identity on every customer document (2026-09-24).
//
// The estimate, the invoice and the job report (hosted page and PDF alike) print a brand
// block: the logo (else the company name), the tagline / address / phone / license line,
// and a footer with the terms-and-conditions link and the Service Club link, each with a
// line of copy. None of it is Harmon-specific in code (CLAUDE.md multi-client rule): it
// is read from Secrets Manager **`sundial/brand`**, keyed by tenant slug —
//
//   {
//     "default": { "accentColor": "#0f2140" },
//     "harmon":  { "companyName": "Harmon Service", "logoUrl": "https://…/HarmonService_Primary_Blue.png",
//                  "tagline": "…", "addressLine": "…", "phone": "…", "email": "…", "licenseLine": "ROC #…",
//                  "termsUrl": "https://…/terms", "termsBlurb": "…",
//                  "clubUrl": "https://…/", "clubBlurb": "…", "footerNote": "" }
//   }
//
// merged DEFAULT_BRAND ← default ← the tenant's block ← SERVICE_BRAND_NAME (the old env
// var, still honoured for companyName when the secret has none). Cached in the Lambda for
// five minutes; the logo bytes (for the PDFs) are fetched once per URL and kept for a day.
// A missing secret, a bad URL or a failed fetch never fails a document — the PDF prints
// the company name instead of the logo, the footer prints whatever links exist.

import { DEFAULT_BRAND } from "./estimate-document.js";

export const BRAND_SECRET = "sundial/brand";
const CONFIG_TTL_MS = 5 * 60 * 1000;
const LOGO_TTL_MS = 24 * 60 * 60 * 1000;
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/** The keys a tenant's block may carry; anything else is dropped. */
export const BRAND_KEYS = Object.freeze([
  "companyName", "tagline", "addressLine", "phone", "email", "licenseLine",
  "logoUrl", "termsUrl", "termsBlurb", "clubUrl", "clubBlurb", "footerNote", "accentColor",
]);

const str = (v) => (v == null ? "" : String(v).trim());
const httpsUrl = (v) => (/^https:\/\/[^\s"'<>]+$/i.test(str(v)) ? str(v) : "");

/** One tenant's block, sanitised: strings only, URLs https only, colour a hex. */
export function sanitizeBrand(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of BRAND_KEYS) {
    if (raw[k] == null) continue;
    if (k === "logoUrl" || k === "termsUrl" || k === "clubUrl") {
      const u = httpsUrl(raw[k]);
      if (u) out[k] = u;
    } else if (k === "accentColor") {
      const c = str(raw[k]);
      if (/^#[0-9a-f]{6}$/i.test(c)) out[k] = c;
    } else {
      const s = str(raw[k]).slice(0, 500);
      if (s) out[k] = s;
    }
  }
  return out;
}

/** DEFAULT_BRAND ← secret.default ← secret[slug] ← env fallback for the name. */
export function mergeBrand({ secret, tenantSlug, env = {} }) {
  const base = sanitizeBrand(secret?.default);
  const mine = tenantSlug ? sanitizeBrand(secret?.[tenantSlug]) : {};
  const merged = { ...DEFAULT_BRAND, ...base, ...mine };
  if (!merged.companyName) merged.companyName = str(env.SERVICE_BRAND_NAME);
  return merged;
}

/** png | jpg from the bytes, or null — the PDF embeds nothing it cannot name. */
export function imageKind(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length > 7 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  return null;
}

/**
 * @param {object} deps  { getSecret, fetchUrl, env, now }
 * @returns {{ brandFor, cached, clear }}
 *   brandFor({ tenantSlug }, { withLogo }) → the merged brand (+ `logoBytes`, `logoKind` when asked and fetched)
 *   cached(tenantSlug) → the last merged brand for that slug (sync), or null
 */
export function createBrandLoader({ getSecret, fetchUrl = (u, i) => fetch(u, i), env = process.env, now = () => Date.now() } = {}) {
  let config = null; // { at, secret }
  const brands = new Map(); // slug → merged brand (with logo when fetched)
  const logos = new Map(); // url → { at, bytes, kind }

  async function loadSecret() {
    if (config && now() - config.at < CONFIG_TTL_MS) return config.secret;
    let secret = null;
    try {
      secret = getSecret ? await getSecret(BRAND_SECRET) : null;
    } catch (e) {
      if (!/ResourceNotFound/i.test(e?.name || e?.message || "")) console.error("brand secret:", e?.message || e);
      secret = null;
    }
    config = { at: now(), secret: secret && typeof secret === "object" ? secret : null };
    return config.secret;
  }

  async function loadLogo(url) {
    const hit = logos.get(url);
    if (hit && now() - hit.at < LOGO_TTL_MS) return hit;
    let entry = { at: now(), bytes: null, kind: null };
    try {
      const r = await fetchUrl(url);
      if (r && r.ok) {
        const buf = new Uint8Array(await r.arrayBuffer());
        const kind = imageKind(buf);
        if (kind && buf.byteLength <= LOGO_MAX_BYTES) entry = { at: now(), bytes: buf, kind };
        else console.error(`brand logo: not a PNG/JPG under ${LOGO_MAX_BYTES} bytes (${buf.byteLength})`);
      } else console.error(`brand logo: HTTP ${r?.status ?? "?"}`);
    } catch (e) {
      console.error("brand logo fetch:", e?.message || e);
    }
    logos.set(url, entry);
    return entry;
  }

  return {
    async brandFor({ tenantSlug = null } = {}, { withLogo = false } = {}) {
      const secret = await loadSecret();
      const brand = mergeBrand({ secret, tenantSlug, env });
      if (withLogo && brand.logoUrl) {
        const logo = await loadLogo(brand.logoUrl);
        if (logo.bytes) {
          brand.logoBytes = logo.bytes;
          brand.logoKind = logo.kind;
        }
      }
      brands.set(tenantSlug || "", brand);
      return brand;
    },
    cached(tenantSlug) {
      return brands.get(tenantSlug || "") ?? null;
    },
    clear() {
      config = null;
      brands.clear();
      logos.clear();
    },
  };
}
