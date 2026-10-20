# WhatsApp Purchasing

Production buys ingredients and supplies from outside suppliers. Every purchasing
conversation goes through **one authorized Production WhatsApp Business number**
on the official **WhatsApp Business Platform (Cloud API)**. The Mountain Bakes app
is the control center and WhatsApp is the channel. A supplier never needs a
Mountain Bakes account: they get a demand-specific link to a mobile web page.

Branch WhatsApp (the Twilio closing summaries in `src/services/messaging/`) is a
separate path and is unchanged.

```
Production                       Supplier (WhatsApp + /supplier-portal)      Finance
──────────                       ─────────────────────────────────────      ───────
New demand → Verify → Send ───►  template message + link
                                 confirms qty / rates / substitutes
                       ◄───────  quotation v1, v2 … (each a new version)
Approve ONE version
(or request changes / reject) ►  "approved, send your bill" + link
                       ◄───────  supplier bill (a claim, not a payment)
Approve bill (differences must
be accepted with a reason)
Delivery: Bykea / inDrive / Yango / Other / Self Pickup (manual reference)
Goods receipt → ingredient stock
Record payment / request credit ───────────────────────────────────────► approve → PV posted
```

## The rules the schema holds

A demand is not a purchase. An approved quotation is not a delivery. A supplier
bill is not a payment, and a recorded payment is not a receipt. Each one has its
own table and status, and stock or money moves only at the step that owns it:

| Step | Table | What it changes |
|---|---|---|
| Demand | `purchase_demands`, `purchase_demand_items` | nothing financial |
| Quotation | `purchase_quotations` (+ items), versioned | nothing; a new version supersedes the approval of the old one |
| Bill | `purchase_bills` (+ items) | nothing until approved; a rejected bill creates no payable |
| Delivery | `purchase_deliveries` | delivery status only, separate from payment |
| Receipt | `purchase_receipts` (+ items) | `ingredient_stock` via `ingredient_stock_movements`, one movement per receipt line (unique) |
| Payment | `supplier_payments` | Finance ledger **only when Finance approves** (`post_finance_ledger_entry`, source `vendor_payment`); a reversal is a second opposite entry |
| Credit | `supplier_credits` | a liability only once Finance approves it; repayments are payments against it |

Other tables: `suppliers`, `purchase_items` (ingredient catalog), `purchase_demand_events`
(audit trail of every transition, with actor, reason and versions), `supplier_access_tokens`
(SHA-256 of the link token only), `whatsapp_business_numbers`, `whatsapp_conversations`,
`whatsapp_messages`, `whatsapp_outbox`, `whatsapp_webhook_events` (deduplication).

A bill is settled two ways, and together they never exceed it. *Direct* payments
(pending or posted) plus *credit* (requested amount while it waits, approved amount
once approved) is at most the bill total. A *repayment* is a payment against one
credit and may not exceed that credit. A payment cannot be dated in the future or
before its demand was raised. Received goods go only into a stock item measured in
the billed unit, and into the catalog item the demand named, if it named one.

Money is `numeric(14,2)` rupees and quantities `numeric(14,3)`. Totals are computed
in Postgres, never added up as floats on a client.

Every state change is one database function that locks the demand row (`for update`)
and re-checks its state, so a stale screen, a double click, an old link or a replayed
webhook is refused with a 409 and a sentence. Money, stock and message endpoints also
take an `Idempotency-Key` (or `clientRequestId`).

### Statuses

Demand `status`: `draft → verified → awaiting_supplier → quotation_received`
(`→ changes_requested →` back to `quotation_received`, or `→ rejected`)
`→ awaiting_supplier_bill → bill_submitted → awaiting_delivery → partially_received → received`.
`cancelled` is reachable until a bill is approved. An edit after Verify returns the demand to `draft`.

`payment_status` (`unpaid | partially_paid | paid`) and `delivery_status`
(`not_booked | booked | dispatched | delivered`) are separate columns. The prompt's
`approved` is `awaiting_supplier_bill` here, `bill_approved` is `awaiting_delivery`,
and `partially_paid`/`paid` live in `payment_status`.

## How messages are sent

No network call runs inside a database transaction. A function that needs a
message sent writes a `whatsapp_messages` row (`queued`) and a `whatsapp_outbox` row
**in the same transaction as the business change**. The worker in
`src/services/whatsapp/outbox.ts` (started by `server.ts`, every 5 s, leases rows with
`for update skip locked`) sends them after commit:

- **Inside 24 hours** of the supplier's last message it sends free text. **Outside** that window
  it sends the approved template. If Meta says the window closed (131047), it falls back to the template.
- Rate limits and transient errors back off and retry. Hard failures are marked `failed` with
  Meta's code and text, and "Retry" on the page resends the same message. A retry never creates a second demand.
  If Meta accepted a message and reported the failure later, and that message carried a supplier link, the link
  is already masked. Retry is then refused with a pointer to **Resend link**, which issues a new link.
- A 200 from Meta is recorded as **`accepted`**, not as sent. Only webhook status events move a
  message to `sent`, `delivered`, `read` or `failed`, and they only move it forward.
- A token-bearing link is masked (`#t=•••`) in every stored copy once the message is accepted.

Inbound messages are matched by sender number to a supplier and, when it has exactly
one open demand, to that demand. Anything else goes to the **Unmatched** queue for a
person to assign or dismiss. No text from WhatsApp ever approves, bills or pays anything.

## API

| Mount | Who | File |
|---|---|---|
| `/api/purchasing/*` | `production_user`, `super_admin` | `src/routes/purchasing.routes.ts` |
| `/api/supplier-portal/*` | link holders (`X-Supplier-Token` header), 120 req / 15 min per IP | `src/routes/supplier-portal.routes.ts` |
| `/api/finance/supplier-payments/*` | Finance (`view` to list, `approve` to decide) | `src/routes/finance-supplier-payments.routes.ts` |
| `/api/whatsapp/webhook` | Meta (GET handshake, POST signed events) | `src/routes/whatsapp-webhook.routes.ts` |

The supplier's link is `${SUPPLIER_PORTAL_URL}/supplier-portal/#t=<token>`. The token
sits in the URL fragment, so it never appears in a request line or a server log. It is
256 random bits, expires after `SUPPLIER_LINK_TTL_DAYS`, and is revoked by a newer
link or when the demand closes. Only its hash is stored.

There is no row-level security in this schema, and none exists elsewhere since the
move off Supabase: the API is the database's only client, and it connects as
`mb_api`. Authorization is the routers' role checks plus the database functions'
state checks. Browsers and phones never hold a database or WhatsApp credential.

## Environment

All variables are server-side, in `backend/.env` locally and in the Railway service
variables in production. `.env.example` documents each one under "WhatsApp Purchasing".
Required for live sending: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
`WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`,
`SUPPLIER_PORTAL_URL`. Optional: `WHATSAPP_PROVIDER`, `WHATSAPP_API_VERSION` (default
`v26.0`, the current Graph API version as of 2026-10), `WHATSAPP_DISPLAY_NUMBER`,
`WHATSAPP_TEMPLATE_DEMAND`, `WHATSAPP_TEMPLATE_UPDATE`, `WHATSAPP_TEMPLATE_LANGUAGE`,
`WHATSAPP_PRODUCTION_ALERT_TO`, `WHATSAPP_OUTBOX_INTERVAL_MS`, `SUPPLIER_LINK_TTL_DAYS`.

Until the five Meta credentials are set, the **mock provider** runs: everything works
end to end, messages show as `accepted` by provider `mock`, nothing reaches a phone,
and the page's connection panel says so.

## Going live: what a person with Meta Business access must do

None of this can be done from code, and none of it has been done yet. Live sending
has **not** been tested against Meta.

1. **The number.** Decide which number is the Production purchasing number.
   - If it is a **new number** (or one not on any WhatsApp app), add it to a WhatsApp Business Account in
     Meta Business Suite → WhatsApp Manager and verify it by SMS or voice.
   - If it is **already used in the WhatsApp Business app**, do not delete or deregister it. Meta's
     *coexistence* onboarding ("Onboarding WhatsApp Business app users") connects an existing Business app
     number to the Cloud API through Embedded Signup and keeps the app working. It requires a recent
     Business app version, a supported country code and admin access to the Meta business portfolio.
     Check Meta's current page for the exact conditions before starting.
   - If the number is registered with **another provider** (e.g. it is the Twilio WhatsApp sender in
     `TWILIO_WHATSAPP_FROM`), it cannot be on both. Use a different number, or migrate it deliberately
     following Meta's number-migration process. **Never migrate the existing number silently.**
2. **Business verification and display name.** Complete Meta business verification and get the display
   name approved, or the number stays limited.
3. **Meta app.** In developers.facebook.com, create (or reuse) a Business app, add the WhatsApp product
   and link the WABA. Copy the **App secret** → `WHATSAPP_APP_SECRET`.
4. **Token.** Business Settings → System users: create a system user, assign the app and the WABA, and generate
   a **permanent** token with `whatsapp_business_messaging` and `whatsapp_business_management` →
   `WHATSAPP_ACCESS_TOKEN`. Copy the **Phone number ID** and **WABA ID** from WhatsApp Manager → API setup.
5. **Templates** (WhatsApp Manager → Message templates, category **Utility**, language English `en`).
   The variable count and order must match exactly:

   `mb_purchase_demand` (6 variables)
   ```
   Assalam o Alaikum {{1}}, Mountain Bakes has a purchase demand for you.
   Demand: {{2}}
   Priority: {{3}}
   Required by: {{4}}
   Items: {{5}}
   Please confirm what you have, your rates and delivery here: {{6}}
   You can change quantities or offer a substitute on that page.
   ```
   Sample values: `Ali Traders`, `MB-WA-20261020-0001`, `URGENT`, `22 Oct 2026`,
   `Flour 10 kg, Butter 5 kg`, `https://<web host>/supplier-portal/#t=sample`.

   `mb_purchase_update` (2 variables)
   ```
   Mountain Bakes, purchase {{1}}: {{2}}
   Reply to this message if you have any questions.
   ```
   Sample values: `MB-WA-20261020-0001`, `Your quotation (version 1, Rs. 7,500.00) is approved. Please send your final bill here: https://<web host>/supplier-portal/#t=sample`.

   Wait until both show **Approved**. If Meta changes the wording or the category, keep the variable order
   and set `WHATSAPP_TEMPLATE_*` if the names differ.
6. **Server variables.** Set the variables above in Railway, plus `SUPPLIER_PORTAL_URL` = the public web origin
   (the Firebase Hosting URL). Generate the verify token with `openssl rand -hex 32`. Redeploy.
7. **Webhook.** In the Meta app → WhatsApp → Configuration: Callback URL
   `https://<public API host>/api/whatsapp/webhook`, Verify token = `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, then
   **Verify and save**, and subscribe to the **`messages`** field (it carries both inbound messages and
   delivery statuses). Make sure the app is subscribed to the WABA (WhatsApp Manager shows it, or
   `POST /<WABA_ID>/subscribed_apps` with the token).
8. **Check.** The WhatsApp Purchasing page's connection panel goes from *Configuration required* to
   *Awaiting webhook*, and to *Connected* after the first signed delivery for the authorized number.
   Register a test supplier (a staff phone), record their opt-in, then send a demand. Confirm that the
   message reaches the phone, the status moves to delivered/read, the link opens the supplier page, a
   reply appears in Conversations, and a quotation shows up on the demand.
9. **Opt-in.** Register a supplier only after they have agreed to receive WhatsApp messages from Mountain
   Bakes. The form requires recording when and how they agreed.

## Deploying

The live API is on Railway and auto-deploys from the backend branch `intigration/railway`.
This work is on branch `whatsapp-purchasing` and is not merged or deployed.

1. **Back up** (`pnpm backup:manual`), then apply the migration as the database administrator:
   ```
   (cd backend && DIRECT_DATABASE_URL="$RAILWAY_DB_URL" pnpm exec prisma migrate deploy)
   ```
   It is additive: new tables, functions, counters, enum values and one ledger head (`EXP-RAW-MATERIALS`,
   inserted only if missing). It changes no existing table. To undo it before any real data exists, drop the
   new tables and functions it lists. Once real purchases are posted, roll forward rather than drop.
2. Refresh the introspected schema: `(cd backend && pnpm prisma:pull)`. `src/db/catalog.generated.json` is already
   regenerated and checked by the integration test.
3. Merge and push the backend so Railway deploys it. Then deploy the web app (`(cd frontend && pnpm run deploy)`),
   because the supplier page is served from there, and ship the Android build.
4. Set the variables and do "Going live" above. Until then the feature runs in test mode.

## Tests

```
(cd backend && npx tsx --test src/services/__tests__/whatsapp-purchasing.integration.test.ts)
```
This runs the whole production schema and this migration in pglite and drives the real routers with the
mock provider and Meta-signed webhooks. It covers demands, the portal, quotation versions, bills,
receipts, payments, credit, webhooks, the outbox and the flour + butter end-to-end case.
