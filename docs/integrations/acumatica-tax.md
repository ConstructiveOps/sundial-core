# Acumatica sales tax → the Service module (D-083)

**What it is.** Sundial taxes Service estimates and invoices with **Acumatica's own tax setup**:
which tax zone an address is in, which taxes that zone carries, each tax's rate schedule, and
which taxes each tax category includes. Julie's exports never came, so we pull these from
Acumatica directly. Acumatica is the source of truth: Sundial copies it exactly, once a day, and
never corrects it. **A wrong rate is fixed in Acumatica**, and the next morning's refresh brings
the fix over.

## The rule

```
tax(line) = Σ rates of the taxes in BOTH the zone's ApplicableTaxes AND the line's
            category's Details, each as of the invoice date
```

The invoice date is the issue date. An estimate uses today. An invoiced estimate is read at its
invoice's issue date, so the two always agree. The rule is Acumatica's, not a special case for
RETAIL: a category that shares no tax with the zone is 0%. A discount or markup is shared
proportionally before tax, as before (`totals.js`).

## Where the zone comes from: never a guess

| Record | Zone |
|---|---|
| Job | `Tax_Zone_Code__c` / `Tax_Zone_Label__c`, stamped at creation from the customer's `City__c` through `resolveTaxZone`. No match leaves both **blank**, the response says "Tax zone needed", and the office picks a zone on the job page (`POST /service/jobs/{id}/tax-zone`). |
| Estimate with a job | The job's zone. A blank job zone means no tax: the city is **not** re-guessed. |
| Estimate without a job | The customer's `City__c` through the resolver. |
| Invoice issue | Refuses with **400 `TAX_ZONE_REQUIRED`** while the job's zone is blank. A wrong guess is a wrong remittance. |

How the resolver (`lib/tax-zones.js`) matches a city:

1. It normalizes the city: uppercase, punctuation becomes a space, spaces are collapsed (the same `normalizeCity` the Acumatica customer push uses).
2. It looks for an alias in `sundial_tax_zone_aliases`. The CFO's four (2026-10-06) are Sun City → Maricopa County, Sun City West → Maricopa County, Anthem → Phoenix, and Laveen → Phoenix. The other spellings from `lib/acumatica-tax-zones.js` are also aliases.
3. It looks for a retail zone whose `city_key` matches. `city_key` comes from `lib/acumatica-tax-zones.js`, the same map the customer push uses.
4. Otherwise it returns `{ matched: false }`. County-only zones are reached only by an alias or the picker, never by their own name.

## Line categories

`Sundial_Service_Line__c.Tax_Category__c` holds an **explicit** choice. The price-book item's own
`Tax_Category__c` is snapshotted onto the line, like the price. When the field is blank, the line
takes a default (Tim, 2026-10-15):

| Line | Category |
|---|---|
| Labor, Fee | `LABSERV` |
| Material / Product | `RETAIL`, **always** |
| Any line on a job billed to **Internal Warranty** or **Manufacturer** | `WARRANTY`, except a Material line explicitly set `RETAIL` |

- **SOLAR is never a default.** It comes only from a price-book item whose `Tax_Category__c` is SOLAR, or from an explicit choice on the line.
- **The warranty rule applies when tax is computed**, so changing an unbilled job's Bill To re-taxes it.
- **`RESALE`** exists so a line can be marked wholesale by hand; no default ever picks it.
- **`Taxable__c` is read-only and derived**, on lines and price-book items alike: RETAIL = ticked, judged on the record's own category (explicit, else the kind's default). A `taxable` key in a request is rejected. **There is no "untick to exempt"**: exempting a material means choosing SOLAR, WARRANTY or RESALE on the line.
- **On screen**, the portal shows the mark from the *effective* category (after the warranty rule), which the estimate read returns per line in `totals.lineTotals[].taxCategory`.

### Lines from before D-083 (2026-10-16, D-083 amendment 1)

`scripts/backfill-line-tax-categories.mjs` made the old choice explicit. A blank material that was **untaxed** (`Taxable__c` off) became **SOLAR**, on lines and price-book items alike. A taxed one stays blank (RETAIL). ZZ records and archived jobs were not touched.

A **Sent / Viewed / Approved / Invoiced** estimate reads its stored totals (`showsStoredTotals` / `withStoredTotals` in `totals.js`), never a recomputation from today's categories. That covers the office read, the preview, the PDF on (re)send, the costing, and the hosted / pay page, with its stored printed rate.
- **What re-prices it:** only an office **edit** (a line, the estimate, the zone, labor billing), which recomputes and re-stores. Send, approve, Create Job and Recalculate never re-price it.
- **What computes live:** Draft, Declined and Expired estimates, and the invoice issue.
- **The invoice's own documents:** its card, PDF and preview, and the job-report receipt, print the invoice's frozen `Tax_Amount__c`.

The second pass, `--taxed-lines`: before D-083 a ticked material line was taxed only when the estimate had a typed rate. On a non-invoiced estimate that stored **no** tax, a ticked blank material line → SOLAR. One that stored tax stays RETAIL and is printed in a list (stored tax, old typed rate, recomputed tax, zone) for the office to decide.

### Issue freezes the categories

Invoice issue writes each line's **effective** category (after the warranty rule) onto the line.
From then on, the invoiced estimate ignores the job's Bill To. A later Bill To change never
re-taxes an issued invoice: not the invoice, its PDF, nor the locked estimate.

What each line held before is kept in the `invoice_issued` activity row (`details.frozenCategories`).
A **void puts it back**, so the `-2` reissue is taxed by the job as it is then, for example after a
corrected Bill To. If that row cannot be read, the void says so in `warnings` and the office
checks the lines before reissuing.

## Tables (Supabase, service role only, `sql/sundial_tax_zones.sql`)

| Table | One row per | Holds |
|---|---|---|
| `sundial_tax_zones` | zone | code, description, `city_key`, county, `tax_ids`, today's `combined_rate` (display only), components, `is_retail` |
| `sundial_tax_rates` | tax | the **full** rate schedule `[{ start, rate }]` (ten rates change on 2026-11-01) |
| `sundial_tax_categories` | category | `tax_ids` |
| `sundial_tax_zone_aliases` | spelling | city spelling → zone code. The refresh adds the map's spellings and never deletes a row here. |

Every table is keyed by tenant slug. Acumatica is a single-credential integration (D-078), so the
tables belong to the primary tenant. Any other tenant has no tables, so it gets no zones, no tax,
and invoice issue is refused. It never borrows Harmon's.

## The refresh

- **`sundial-cache-sync` with `{ "task": "taxzones" }`.** EventBridge rule `sundial-cache-sync-taxzones`, `cron(0 12 * * ? *)` (5 AM Arizona). Wired by `scripts/wire-tax-zone-refresh.ps1`.
- **What it does.** It pulls TaxZone (+ApplicableTaxes), Tax (+TaxSchedule, Zones) and TaxCategory (+Details) with GET only, then upserts all four tables.
- **Pruning.** It deletes zones, taxes and categories that Acumatica no longer has. It skips this if the pull came back with fewer than half the stored zones, so a partial read never empties the table.
- **Logging.** One `cache_sync_runs` row per run: `object = 'taxzones'`, `mode = 'full'`, `expected_interval_s = 86400`.
- **Drift.** Every run logs the drift report to CloudWatch (`cache-sync taxzones drift:`).
- **The Lambda's role** needs `secretsmanager:GetSecretValue` on `sundial/acumatica/connected-app`.

Check it ran:

```sql
select ok, finished_at, rows_upserted, error from public.cache_sync_runs
where object = 'taxzones' order by started_at desc limit 3;
```

## Drift: what Acumatica holds that will surprise you (fix it in Acumatica)

`node scripts/acumatica-pull-tax.mjs` prints the full report. Its DRIFT section uses the same
check the refresh logs. As of 2026-10-15:

- **The city tax is in no retail category, so it is never charged.** Sierra Vista (1.95), Tombstone (3.5), Coolidge (3.0), Dewey-Humboldt (2.0), GRIC (6.0), SRIC (2.35).
- **A contracting tax sits on a retail zone.** Apache Junction carries `12PNCC` Pinal County **Contracting** instead of `12PNCRT` Pinal County Retail, so it charges 2.4% instead of 9.1%.
- **Retail zones with no city in the map.** These are the reservation zones (CRIR, GRIC, SRIC). They were skipped on purpose and can be picked by hand.

## Scripts

| Script | What it does |
|---|---|
| `node scripts/acumatica-pull-tax.mjs [--offline]` | Read-only pull to `_delivery/acumatica-tax/` (git-ignored) and the report. |
| `node scripts/seed-tax-zones.mjs [--pull] [--apply]` | The first load, using the refresh's own writer. A dry run unless `--apply`. |
| `node scripts/backfill-line-tax-categories.mjs [--apply]` | 2026-10-16: an untaxed blank material line / price-book item → SOLAR (restores the pre-D-083 tax). A dry run by default (counts by estimate status + a sample); `--apply` writes canary first, then batches of 200. Then run a full cache-sync for `serviceline` and `pricebookitem`. |
| `node scripts/backfill-job-tax-zones.mjs [--apply]` | For open jobs (not Closed / Cancelled / Paid) with a blank zone, resolves the service address's city with the same resolver. A dry run by default: the matched count by zone and the unmatched list (job, customer, city, reason), also saved as `_delivery/acumatica-tax/backfill-unmatched.csv`. `--apply` writes **exact matches only**, canary first. |

**Backfill preview (2026-10-15, from the job cache).** Of 892 open jobs, **865 match exactly** and
**27 do not**, after "LAKE HAVASU CITY" was added to the map. The 27 are unincorporated places that
are not an Acumatica zone: Arizona City (6), Waddell (4), Wittmann (4), San Tan Valley (3), New River
(3), Morristown, Gadsden, Lake Montezuma, Sun Lakes, and 3 whose address has no city (ZIP 85301).
Each is either picked by hand or given an alias, and **an alias is the CFO's call** (like her four).

## Routes (`sundial-service-estimate`, action `service.estimate.write`)

| Route | What it does |
|---|---|
| `GET /service/tax-zones[?city=]` | The office's picker: every retail zone (cities and counties) with today's rate. `?city=` also returns what the resolver would pick. `configured: false` when the tenant has no tables. |
| `POST /service/jobs/{id}/tax-zone` `{ zoneCode }` | Sets or corrects the zone. The code must be one of the tenant's retail zones, the label is derived, and `null` clears it. Re-taxes the estimate unless it is invoiced. **The only write path**: `sundial-sf-update` refuses a job PATCH naming either field (`400 TAX_ZONE_READ_ONLY`). |

## Documents

The estimate, invoice and job report print `<Jurisdiction> (<rate>%)` under **Total tax**, as
the HCP sample does. Since D-083 this line appears **even when the tax is $0**, as long as the
zone is known. With no zone and no tax, no tax rows are printed.
