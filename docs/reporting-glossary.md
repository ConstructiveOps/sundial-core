# Reporting glossary — what Sundial's words mean in its fields

> **DRAFT for Tim's review (2026-11-10, D-092).** The report assistant (R4) reads this whole file on
> every turn, as part of its cached instructions. It is the business meaning of words people use
> when they ask for a report, written as the exact field and values a report definition uses.
>
> **Editing this file changes the assistant only after a redeploy.** The Lambda carries a copy:
> run `node scripts/generate-report-glossary.mjs` (it rewrites `lib/report-glossary.js`), then
> `.\deploy.ps1 sundial-reports`. `npm test` fails while the two differ.
>
> Fields are written `<alias>.<column>`, the way a report definition names them. The alias is the
> report type's (for example `rep.name` is the Sales rep joined to a solar project). The
> **terminal solar stage list** below is checked against `lib/stage-rules.js` by a test: change it
> there first.

## Dates and periods

- **All dates are Arizona dates** (America/Phoenix, UTC-07:00 all year, no daylight saving). A
  date/time filter on a period means whole Arizona days.
- **Relative periods** are resolved by the server when the report runs, so a saved report rolls
  forward. Use them instead of typed dates whenever the request names a period:
  `today`, `this_week`, `last_week`, `this_month`, `last_month`, `this_quarter`, `last_quarter`,
  `this_year`, `last_year`, `ytd` (January 1 to today), `last_n_days:N` (N days ending today,
  today included).
- **Weeks start on Monday.** Quarters and years are calendar quarters and years (Q4 = October to
  December). There is no fiscal year.
- "This quarter" = `this_quarter`. "Last 30 days" = `last_n_days:30`. "Since January" in the
  current year = `ytd`. A named month ("in March") is a typed range `["2026-03-01", "2026-03-31"]`.
- **Grouping by period** ("per week", "by month") is `groupBy: [{ field, dateTrunc }]` with
  `day | week | month | quarter | year`. Only ONE group level exists: "per tech per week" cannot be
  built; offer "per tech" for the period, or "per week" for everyone, and ask which.
- **With the details / under each group** ("show each project under its rep", "jobs grouped by
  status with the details", "list them by month") is a summary report: the same one `groupBy`,
  plus `showDetails: true` and the record columns to list. Each group's records are shown under
  it with the group's subtotals, then a grand total. "By rep" alone, with no request to see the
  records, is a plain grouped report (no details). The groups stay in order of the group value.

## Solar projects (report type `solar`; `customers_solar` for a customer with their newest project)

- **Sold** = the Contract Signed Date (`solar.contract_date`) is set.
  **"Sold in <period>"** = `solar.contract_date` `between` that period (for example `this_quarter`).
  "Sold" with no period = `solar.contract_date` `after` "2000-01-01" (date fields have no
  "not blank" operator). `solar.sold_date` is a different, older field — never use it for "sold".
- **Contract total / contract value / sales** (solar) = `solar.contract_amount` (sum it).
- **Active / in progress / open (solar)** = the stage is set and is not a terminal stage:
  `solar.stage` `not_in` the terminal list below, plus `solar.stage` `not_blank`.
  Terminal solar stages: PTO Approval Granted; Request to Archive; Archive; Cancelled - Awaiting Sales to Resell; Cancelled
- "Inspection Completed", "Go Back Items Complete" and "Billing Complete - Pending Closeout" are
  ACTIVE stages (D-092), even though they contain the word "complete".
- **Finished / closed (solar)** = `solar.stage` `in` the terminal list. **Cancelled** = `in`
  [Cancelled, Cancelled - Awaiting Sales to Resell]. **Archived** = `in` [Archive, Request to Archive].
- **Installed / PTO** = `solar.pto_approved_date` (a date: filter it by period).
- **Stage families (solar.stage):**
  - Sold, waiting to start: Sold - Pending Review
  - Survey & design: Audit, Site survey scheduled, Audit Photos Received, Design Ordered, Utility Input, Design Received, PM Review, Re-Roof Needed, Sent HO Design, HOA Pending
  - Permitting & utility: Permitting, Permit Submitted, Permitting Received, Interconnection, Interconnection Submitted
  - Install: Scheduling, Install Scheduled
  - Post-install & inspection: Post Installation, Post Install/Pending MPU, Post Install/Pending BUS/MSA, Inspection Scheduled, Inspection Completed, Green Tagged, Go Back Items Needed, Go Back Items Complete, Awaiting Bird Blocking
  - Billing: Billing, Billing Complete - Pending Closeout
  - Finished: PTO Approval Granted, Request to Archive, Archive, Cancelled - Awaiting Sales to Resell, Cancelled
  - Paused: Hold
- **Sales rep** of a project = `rep.name` (the user joined on the project's rep). **Dealer** =
  `dealer.name`. **Project manager** (solar) = `solar.project_manager` (a list of names, not a user).
- **System size** = `solar.system_size` (kW DC).

## Customers (report type `customers`)

- A customer is the hub record: lead, opportunity and customer in one. **Status**
  (`customer.status`): Lead, Opportunity, Customer, Past Customer.
- **Sales pipeline stage** (`customer.stage`). Families:
  - Working the lead: New, Contact Attempt Made, Follow Up, Appointment Set, Proposal Pending, Proposal Complete, Reschedule Needed, Rescheduled Appointment, Verbal Yes, 10 Day Revive, Reset, Hold
  - Paperwork: Waiting On Documents, Processing Documents
  - Sold: Sold - Pending Review, Sold - Final Review, Sold, Sold - Installed, Sold - Archived
  - Lost / closed: Not Interested, DNQ, Wants for Free, Closed Lost, Cancelled
- **Closed (customer)** = `customer.stage` `in` [Closed Lost, Sold - Archived, Cancelled].
- **No dealer** = `customer.dealer_sf_id` `is_blank`. **No rep** = `customer.sales_rep_sf_id` `is_blank`.
- **Service customers** = `customer.customer_type` `contains` "Service" (a multi-select: Solar,
  Roofing, Commercial, Service). **Service stage** (`customer.service_stage`): New, Contact Attempt
  Made, In Progress, Waiting on Customer, Waiting on Other Department, Estimate Created, On Hold,
  Resolved, Closed; "open service request" = `not_in` [Resolved, Closed] and `not_blank`.
- **Archived customers**: `customer.archived` `eq` true; "not archived" = `eq` false.

## Service jobs (report type `service_jobs`)

- **Open job** = `job.status` `not_in` [Paid, Closed] AND `job.archived` `eq` false.
- **Job status** (`job.status`), in order: New, Triaging, Remote Investigation, Ready to Schedule,
  Scheduled, In Progress, Awaiting Parts, Awaiting Office Review, Ready to Bill, Invoiced, Paid, Closed.
- "Waiting to be billed" = `job.status` `eq` Ready to Bill. "Scheduled" = `eq` Scheduled.
- **Oldest first** = sort on `job.created_date` `asc`.
- A job's invoice in this type is its newest non-void invoice (`invoice.*`); its payments are a
  rollup by job (`payments.amount_paid`, `payments.deposits_paid`, `payments.last_paid_at`).
- **Job payment status** (`job.payment_status`): None, Deposit Paid, Partially Paid, Paid, Refunded.

## Invoices and payments (report types `invoices_payments`, `payments`)

- **Unpaid invoice / money owed / open balance** = `invoice.balance` `gt` 0 AND `invoice.status`
  `not_in` [Void, Draft]. **Amount owed** = sum of `invoice.balance`.
- **Paid invoice** = `invoice.status` `eq` Paid.
- **Invoice status** (`invoice.status`): Draft, Issued, Sent, Partially Paid, Paid, Void. Void
  invoices are never money; leave them out unless asked.
- **Invoiced in <period>** = `invoice.issued_at` in that period.
- **Collected / payments received** = report type `payments`, `payment.status` `eq` Succeeded, sum
  `payment.amount`, by `payment.received_at`. A Refund row is stored positive: for net collected,
  filter `payment.type` `not_in` [Refund] and report refunds separately, or use
  `payments.amount_paid` (net of refunds) on `invoices_payments` / `service_jobs`.
- **Payment status**: Pending, Succeeded, Failed, Refunded. Only Succeeded is money received.
  **Payment type**: Deposit, Payment, Refund, Adjustment.

## Estimates (report types `estimates`, `estimate_lines`)

- **Estimate status** (`estimate.status`): Draft, Sent, Viewed, Approved, Declined, Expired,
  Invoiced, Template. Templates are not estimates: leave `Template` out unless asked.
- **Approved / won** = `estimate.status` `in` [Approved, Invoiced]. **Approved in <period>** =
  `estimate.approved_at` in that period. **Open estimate** = `in` [Draft, Sent, Viewed].
- **Estimate value** = `estimate.total`. **Sold by** = `sold_by.name`.

## Service calls (report type `service_calls`)

- A call is one technician on one appointment. **Technician** = `tech.name`.
- **Calls in <period>** = `call.scheduled_start` in that period.
- **Completed calls** = `call.status` `eq` Complete. Status: Unscheduled, Scheduled, En Route, In
  Progress, Complete, Cancelled, No-Show. Leave Cancelled out of "calls" unless asked.
- **Events** (`call.visit_type` `eq` Event) have no job or customer.
- **Time on site** = `call.duration_minutes`.

## Words that need a question

- **Revenue** is ambiguous unless the request makes it clear. ASK which one they mean:
  solar contract amount (`solar.contract_amount`, by contract date), service invoice totals
  (`invoice.total`, by issue date), or payments collected (`payment.amount`, Succeeded, by received date).
- **"Big", "top", "best", "recent", "slow"** without a number or a period: ask for the measure or period.
- A **person's or company's name** is matched with `contains` on the name field (for example
  `rep.name` `contains` "Dennis"), never guessed as an exact value.
