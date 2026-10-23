// Sandbox proof for the commission-PO update fix (runbook "2026-10-23", step B; Step 10).
//
// THE QUESTION. In October every amount update the engine sent to an Open, Hold = false
// PO came back 200 and the PO kept its old amount; the only update ever proven to stick
// was on an On Hold PO. Is that Acumatica discarding detail edits to an Open PO? This
// script answers it on ONE sandbox PO, in four steps, re-reading after each:
//
//   1. the engine's exact update PUT to the Open PO      → expect: amount UNCHANGED
//   2. PUT { id, Hold: true }                            → expect: status On Hold
//   3. the same update PUT (a second amount)             → expect: amount CHANGED
//   4. PUT { id, Hold: false }                           → expect: status Open
//                                                          (Pending Approval = the release
//                                                          re-entered approval)
//
// Hold is a FIELD: Default/25.200.001 has no PurchaseOrder hold / release action (its
// swagger lists PutOnHold / ReleaseFromHold for Subcontract only). Step 0 re-reads the
// sandbox endpoint's swagger and prints the PurchaseOrder action routes, so the answer
// is checked on the tenant being tested, not assumed.
//
// SANDBOX ONLY. `sundial/acumatica/connected-app` points at LIVE and is never changed for
// this. Point the script at a separate sandbox secret (same five keys: base_url, client_id,
// client_secret, username, password) and name the tenant you expect:
//
//   SUNDIAL_ACUMATICA_SECRET_NAME=sundial/acumatica/sandbox \
//     node scripts/probe-po-hold-update.mjs --tenant "BizRun Tenant" --po 012345
//   ...add --apply to send the four PUTs (without it: reads, checks, prints the plan).
//
// It refuses unless the override is set, the credential's tenant (D-058: the client_id
// suffix) equals --tenant, AND that tenant differs from the one the deployed pointer holds.
// The PO must be Open, Hold = false, one line, nothing received. It is left at the step-3
// amount and Open — a sandbox PO, but pick one nobody minds.
import {
  ACUMATICA_SECRET_NAME, acumaticaSecretName, acumaticaTenant, getAcumaticaEntity, putAcumaticaEntity,
} from "../lib/acumatica.js";
import { getSecret } from "../lib/secrets.js";
import { readPurchaseOrder, frozenReason, HOLD_FIELD } from "../lambdas/sundial-acumatica-commission-po/index.js";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const apply = args.includes("--apply");
const expectTenant = opt("--tenant");
const orderNbr = opt("--po");
const die = (msg) => { console.error(`\nREFUSED: ${msg}\n`); process.exit(1); };

// --- Which tenant, proven from the credential ------------------------------------
const secretName = acumaticaSecretName();
if (secretName === ACUMATICA_SECRET_NAME) {
  die(`SUNDIAL_ACUMATICA_SECRET_NAME is not set (or names the pointer itself), so this would read "${ACUMATICA_SECRET_NAME}" — the deployed pointer, which holds LIVE. Set it to the sandbox secret's name.`);
}
if (!expectTenant) die('name the tenant you expect, e.g. --tenant "BizRun Tenant"');
if (!orderNbr) die("give the sandbox PO to test: --po <OrderNbr> (Open, Hold = false, one line)");

const tenant = await acumaticaTenant();
let pointerTenant = null;
try {
  const p = await getSecret(ACUMATICA_SECRET_NAME);
  pointerTenant = String(p?.client_id ?? "").includes("@") ? String(p.client_id).split("@").pop() : null;
} catch { /* unreadable pointer: the --tenant check still stands */ }
console.log(`secret: ${secretName}\ntenant (from client_id): ${tenant}\ndeployed pointer's tenant: ${pointerTenant ?? "(unreadable)"}`);
if (tenant !== expectTenant) die(`the credential is scoped to "${tenant}", not "${expectTenant}".`);
if (pointerTenant && tenant === pointerTenant) die(`"${tenant}" is the tenant the deployed pointer holds — that is not a sandbox for this purpose.`);

// --- Step 0: what the endpoint offers ---------------------------------------------
const sw = await getAcumaticaEntity("swagger.json");
if (sw.ok && sw.data?.paths) {
  const routes = Object.keys(sw.data.paths).filter((p) => p.startsWith("/PurchaseOrder/") && !/[{$]/.test(p.split("/")[2] ?? "{"));
  console.log(`\nstep 0  PurchaseOrder named actions on this endpoint: ${routes.length ? routes.join(", ") : "NONE (Hold is set as a field)"}`);
} else {
  console.log(`\nstep 0  swagger read failed (${sw.status}) — carrying on with Hold as a field`);
}

// --- The PO ------------------------------------------------------------------------
const show = (label, po) => console.log(
  `${label.padEnd(44)} status=${po?.status} hold=${po?.hold} unitCost=${po?.lines?.[0]?.unitCost} ` +
    `qtyOnReceipts=${po?.lines?.[0]?.qtyOnReceipts} completed=${po?.lines?.[0]?.completed}`
);
const before = await readPurchaseOrder(orderNbr);
if (!before) die(`no PO ${orderNbr} on ${tenant}`);
show(`\nPO ${orderNbr} as found`, before);
if (before.status !== "Open" || before.hold !== false) die(`PO ${orderNbr} is ${before.status} / Hold ${before.hold} — the test needs Open and Hold = false.`);
if (before.lines.length !== 1) die(`PO ${orderNbr} has ${before.lines.length} lines — the engine's POs have one.`);
if (frozenReason(before)) die(`PO ${orderNbr} ${frozenReason(before)} — not a fair test.`);

const original = Number(before.lines[0].unitCost);
const amount1 = Math.round((original + 1) * 100) / 100;
const amount2 = Math.round((original + 2) * 100) / 100;
// The engine's update body, byte for byte (updateCommissionPo, no dates).
const amountBody = (amount) => ({ id: before.id, Details: [{ id: before.lines[0].id, UnitCost: { value: amount }, OrderQty: { value: 1 } }] });

if (!apply) {
  console.log(`\nDRY RUN — nothing sent. With --apply:\n  1. amount ${original} → ${amount1} on the Open PO\n  2. Hold = true\n  3. amount → ${amount2}\n  4. Hold = false`);
  process.exit(0);
}

async function put(step, body) {
  const r = await putAcumaticaEntity("PurchaseOrder", body, { $expand: "Details" });
  const echo = r.data?.Details?.[0];
  console.log(`step ${step}  PUT ${r.status}  echo: unitCost=${echo?.UnitCost?.value ?? "(no line)"} status=${r.data?.Status?.value} hold=${r.data?.Hold?.value}` +
    (r.ok ? "" : `  error=${JSON.stringify(String(r.text || "").slice(0, 300))}`));
  return r;
}

console.log("");
await put(1, amountBody(amount1));
const s1 = await readPurchaseOrder(orderNbr); show("step 1  after the plain update (expect UNCHANGED)", s1);
await put(2, { id: before.id, [HOLD_FIELD]: { value: true } });
const s2 = await readPurchaseOrder(orderNbr); show("step 2  after Hold = true (expect On Hold)", s2);
await put(3, amountBody(amount2));
const s3 = await readPurchaseOrder(orderNbr); show("step 3  after the update On Hold (expect CHANGED)", s3);
await put(4, { id: before.id, [HOLD_FIELD]: { value: false } });
const s4 = await readPurchaseOrder(orderNbr); show("step 4  after Hold = false (expect Open)", s4);

// --- Verdict -------------------------------------------------------------------------
const cost = (po) => Number(po?.lines?.[0]?.unitCost);
const plainIgnored = cost(s1) === original;
const heldOk = s2?.status === "On Hold";
const heldApplied = cost(s3) === amount2;
const released = s4?.status === "Open";
console.log(`
VERDICT
  1. plain PUT to an Open PO ignored:   ${plainIgnored ? "YES" : `NO — it went to ${cost(s1)}`}
  2. Hold = true honoured:              ${heldOk ? "YES" : `NO — status ${s2?.status}`}
  3. PUT applied while On Hold:         ${heldApplied ? "YES" : `NO — ${cost(s3)}`}
  4. Hold = false back to Open:         ${released ? "YES" : `NO — status ${s4?.status}`}${s4?.status === "Pending Approval" ? "  ← the release RE-ENTERED APPROVAL" : ""}
  amount still ${amount2} after release: ${cost(s4) === amount2 ? "YES" : `NO — ${cost(s4)}`}

${plainIgnored && heldOk && heldApplied && released && cost(s4) === amount2
    ? "Hypothesis (a) CONFIRMED and the hold path works. Paste this output into the runbook (Step 10) and open HOLD_UPDATE_GATE."
    : !plainIgnored
      ? "Hypothesis (a) is WRONG — a plain PUT to an Open PO sticks here. Do NOT open HOLD_UPDATE_GATE; the October cause is elsewhere ((c) id pairing, or a sandbox/live difference)."
      : "The hold path did not behave as needed. Do NOT open HOLD_UPDATE_GATE — paste this output back for a decision."}
PO ${orderNbr} is left at ${cost(s4)} / ${s4?.status}.`);
