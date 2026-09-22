// address.js — address lookup for the Service module's customer create (2026-09-22,
// Harmon's ask: "help us find the exact address"). Google Places Autocomplete, proxied.
//
//   GET /service/address/suggest?q=…&session=…     → { status, suggestions: [{ placeId, main, secondary, text }] }
//   GET /service/address/place/{placeId}?session=… → { status, address: { street, city, state, postalCode, formatted, lat, lng } }
//
// Why a Lambda route and not Google's JavaScript widget: the same rule Street View lives
// by (D-072 amendment 5) — the Google key is in Secrets Manager `sundial/google-maps`
// and never in the browser. The browser sends what the person typed; this code adds the
// key. Both calls carry the browser's `session` token so Google bills one autocomplete
// session (type… type… pick) instead of one request per keystroke.
//
// Google Places API (New): places:autocomplete (POST) and places/{id} (GET, field mask).
// The legacy Places API is closed to new projects, so the key's project must have
// "Places API (New)" enabled — a Google Cloud console step, in the runbook.
//
// Nothing tenant-specific is in this code. An optional `bias` in the secret
// ({ lat, lng, radiusMeters }) nudges suggestions toward the office's territory; without
// it Google ranks by the text alone, US-only.
//
// Degrades quietly: no secret → { status: "unconfigured", suggestions: [] } and the
// office types the address as before. Google down → 502 with a plain message; the
// browser shows nothing and the typed text stays.

export const PLACES_SECRET = "sundial/google-maps";
export const PLACES_BASE = "https://places.googleapis.com/v1";
export const MIN_QUERY = 3;
export const MAX_SUGGESTIONS = 6;
const PLACE_FIELDS = "id,formattedAddress,addressComponents,location";
const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PLACE_ID_RE = /^[A-Za-z0-9_-]{4,300}$/;

/** One Google prediction → what the picker shows. */
export function suggestionFromPrediction(p) {
  const pred = p?.placePrediction;
  if (!pred?.placeId) return null;
  return {
    placeId: pred.placeId,
    main: pred.structuredFormat?.mainText?.text ?? pred.text?.text ?? "",
    secondary: pred.structuredFormat?.secondaryText?.text ?? "",
    text: pred.text?.text ?? "",
  };
}

/**
 * Google's addressComponents → the four fields the customer form has.
 * Street = number + route as abbreviated (+ the unit, as "#4"); city prefers the postal locality;
 * state is the two-letter code; ZIP drops the +4 (Salesforce holds 5).
 */
export function addressFromPlace(place) {
  const comps = Array.isArray(place?.addressComponents) ? place.addressComponents : [];
  const find = (type, short = false) => {
    const c = comps.find((x) => Array.isArray(x?.types) && x.types.includes(type));
    return c ? String((short ? c.shortText : c.longText) ?? c.longText ?? c.shortText ?? "").trim() : "";
  };
  const number = find("street_number");
  const route = find("route", true); // "Palm Ln", the way the formatted address (and the mail) has it
  const unit = find("subpremise");
  let street = [number, route].filter(Boolean).join(" ");
  if (unit) street = `${street} ${/^\d/.test(unit) ? `#${unit}` : unit}`.trim();
  const city = find("locality") || find("postal_town") || find("sublocality_level_1") || find("sublocality") || find("administrative_area_level_3") || find("neighborhood");
  const state = find("administrative_area_level_1", true);
  const postalCode = find("postal_code");
  const lat = typeof place?.location?.latitude === "number" ? place.location.latitude : null;
  const lng = typeof place?.location?.longitude === "number" ? place.location.longitude : null;
  return { street, city, state, postalCode, formatted: String(place?.formattedAddress ?? "").trim() || null, lat, lng };
}

/** The autocomplete request body: US only, addresses only, the session, the optional bias. */
export function autocompleteBody(input, session, bias = null) {
  const body = { input, includedRegionCodes: ["us"], languageCode: "en" };
  if (session) body.sessionToken = session;
  if (bias && Number.isFinite(bias.lat) && Number.isFinite(bias.lng)) {
    body.locationBias = { circle: { center: { latitude: bias.lat, longitude: bias.lng }, radius: Number.isFinite(bias.radiusMeters) ? bias.radiusMeters : 50000 } };
  }
  return body;
}

export function createAddressHandlers(d, { jsonResponse, bad }) {
  async function keyAndBias() {
    try {
      const s = await d.getSecret(PLACES_SECRET);
      return { apiKey: s?.apiKey || null, bias: s?.bias ?? null };
    } catch (e) {
      if (!/ResourceNotFound/i.test(e?.name || e?.message || "")) console.error("address lookup secret", e?.message);
      return { apiKey: null, bias: null };
    }
  }
  const sessionOf = (query) => (SESSION_RE.test(String(query?.session ?? "")) ? String(query.session) : null);

  return {
    async suggestAddress({ ctx, query }) {
      const { cors } = ctx;
      const q = String(query?.q ?? "").trim().slice(0, 200);
      if (q.length < MIN_QUERY) return jsonResponse(200, cors, { status: "ok", suggestions: [] });
      const { apiKey, bias } = await keyAndBias();
      if (!apiKey) return jsonResponse(200, cors, { status: "unconfigured", suggestions: [] });
      let data;
      try {
        const r = await d.fetchUrl(`${PLACES_BASE}/places:autocomplete`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey },
          body: JSON.stringify(autocompleteBody(q, sessionOf(query), bias)),
        });
        data = await r.json();
        if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
      } catch (e) {
        console.error("address suggest", e?.message);
        return jsonResponse(502, cors, { error: "address_lookup_failed", code: "ADDRESS_LOOKUP_FAILED", message: "Google did not answer." });
      }
      const suggestions = (Array.isArray(data?.suggestions) ? data.suggestions : []).map(suggestionFromPrediction).filter(Boolean).slice(0, MAX_SUGGESTIONS);
      return jsonResponse(200, cors, { status: "ok", suggestions });
    },

    async resolveAddress({ ctx, params, query }) {
      const { cors } = ctx;
      const placeId = String(params[0] ?? "");
      if (!PLACE_ID_RE.test(placeId)) return bad(cors, "INVALID_PLACE", "That is not a place id.");
      const { apiKey } = await keyAndBias();
      if (!apiKey) return jsonResponse(200, cors, { status: "unconfigured", address: null });
      let place;
      try {
        const session = sessionOf(query);
        const url = `${PLACES_BASE}/places/${encodeURIComponent(placeId)}${session ? `?sessionToken=${encodeURIComponent(session)}` : ""}`;
        const r = await d.fetchUrl(url, { headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": PLACE_FIELDS } });
        place = await r.json();
        if (!r.ok) throw new Error(place?.error?.message || `HTTP ${r.status}`);
      } catch (e) {
        console.error("address place", e?.message);
        return jsonResponse(502, cors, { error: "address_lookup_failed", code: "ADDRESS_LOOKUP_FAILED", message: "Google did not answer." });
      }
      return jsonResponse(200, cors, { status: "ok", address: addressFromPlace(place) });
    },
  };
}
