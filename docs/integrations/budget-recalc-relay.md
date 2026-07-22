# Budget Recalc — Field-Change Trigger & Platform-Event Relay

> How a field edit on `Sundial_Solar__c` reaches the `sundial-budget` Lambda.
> Flow metadata: `salesforce/flows/Sundial_Budget_Recalc_Trigger.flow-meta.xml`.

## Chain

`Sundial_Solar__c` edit → **after-save record-triggered Flow** → set
`Budget_Calc_Status__c = 'Pending'` + publish **`Sundial_Budget_Recalc__e`**
(`Record_Id__c`, `Source__c='FieldTrigger'`) → Platform Event relay →
`sundial-budget` Lambda → recalc → writeback.

The Lambda's event path already parses **both** the EventBridge shape
(`event.detail.payload`) and the SQS-wrapped shape (`event.Records[].body`, which may
itself wrap an EventBridge envelope), so either relay works without code changes.

## The Flow (`Sundial_Budget_Recalc_Trigger`)

- **Trigger:** after-save (`RecordAfterSave`), Create and Update.
- **Entry (decision `Should Recalc?`):** `fGuardNotWriteback AND (fInputChangedA OR fInputChangedB)`.
  - `fInputChangedA` / `fInputChangedB` — `OR(ISCHANGED(...))` over the 73 budget
    **input** fields (the handler's `INPUT_FIELDS` minus `Name`/`Panel_Type__c`).
    **Split into two formulas on purpose:** 73 `ISCHANGED` terms = ~4,090 chars, over
    Salesforce's ~3,900-char single-formula limit. Each half is ~1,900 chars.
  - `fGuardNotWriteback` = `NOT(ISCHANGED(Budget_Last_Calculated__c))` — the **loop
    guard**: the Lambda's own writeback stamps `Budget_Last_Calculated__c`, so its
    re-save fails this guard and does not re-publish. (Setting `Budget_Calc_Status__c
    = 'Pending'` also re-saves, but Status is not an input field, so the OR is false —
    no loop either way.)
- **Actions:** Update Records (`$Record.Budget_Calc_Status__c = 'Pending'`) → Create
  Records (`Sundial_Budget_Recalc__e`).
- **Status:** shipped as `Draft`. **Before go-live:** (1) append Harmon's milestone
  trigger fields (Audit Completed, Design Review Finalized, …) as a third formula
  `fInputChangedC` and add it to the decision OR; (2) Activate.

### Manual-build fallback (if metadata deploy is impractical)

In Flow Builder: New → Record-Triggered Flow on `Sundial_Solar__c`, After Save,
Created and Updated → add the three formula resources above → Decision with logic
`1 AND (2 OR 3)` → Update Records ($Record, Status = Pending) → Create Records
(`Sundial_Budget_Recalc__e`, `Record_Id__c = {!$Record.Id}`, `Source__c = FieldTrigger`)
→ Activate.

## Platform-Event → Lambda relay

The design references "the existing Platform Event → EventBridge relay." **Confirm
which mechanism is actually live** before relying on it — as of this work the repo has
no deployed Salesforce→AWS relay (api-endpoints.md lists `sundial-cache-invalidator`
as Phase 2+, not built). Two supported options; the Lambda handles both:

1. **Salesforce Event Relay → Amazon EventBridge** (native): create a Named Credential
   + Event Relay config in Salesforce pointing `Sundial_Budget_Recalc__e` at an
   EventBridge partner event bus, then an EventBridge rule targeting `sundial-budget`.
   Event arrives as `event.detail.payload`.
2. **Platform Event → (middleware) → SQS → Lambda**: an SQS event-source mapping on
   `sundial-budget`. Event arrives as `event.Records[].body`.

Either way the payload carries `Record_Id__c` + `Source__c`. **TODO(confirm infra):**
tell me which relay to wire and I'll add the EventBridge rule / SQS mapping + the
Lambda invoke permission.
