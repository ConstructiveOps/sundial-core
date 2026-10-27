# Acumatica — Service money mapping (notes for the push, not built)

The Service module does not push to Acumatica yet. The existing Acumatica integrations
(the budget push, commission POs, attributes, tax tables) each have their own runbook in
this folder: `acumatica-budget-push.md`, `acumatica-commission-po-runbook.md`,
`acumatica-attribute-sync-runbook.md`, `acumatica-tax.md`.

This page records how Service money rows are meant to map when the invoice / payment
push is built, so the rows written today are the right shape for it.

## Deposits before the invoice (D-072 amendment 16, 2026-10-27)

- A `Sundial_Service_Payment__c` row with `Type__c = Deposit` and **no `Invoice__c`** is
  money received on the job before it was billed — a card deposit (Stripe) or a check /
  ACH the office recorded through `POST /service/jobs/{id}/payments`.
- **It maps to an AR Prepayment on the customer** — the payer's
  `Acumatica_Customer_ID__c` (D-081: the job's Bill To customer, else the homeowner).
- **The invoice push applies it.** When the invoice is issued, Sundial back-fills the row's
  `Invoice__c`; the AR Invoice push then applies the prepayment to the new AR invoice
  rather than recording the money a second time.
- A void unhooks the row (`Invoice__c` back to blank) and keeps it on the job — in
  Acumatica the application is reversed and the prepayment stays open for the reissue.
- No code yet. Idempotency for the push: the payment row's Salesforce Id (or, for card
  rows, `Stripe_Payment_Intent_Id__c`).
