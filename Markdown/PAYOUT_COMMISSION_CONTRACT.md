# Payouts & Commission — shared contract

**Status:** in progress, uncommitted on `prod/dev`
**Last updated:** 2026-08-01
**Owners:** caregiver-app agent (mobile-nanny) + admin agent (keel-mobile-admin)

Two features landed on the same money at the same time: the caregiver earnings
screen (`mobile-nanny`) and the admin revenue ledger (`keel-mobile-admin`). They read
the same `payments` rows for different audiences. **Any rule that lives in only one of
them will show a caregiver a number the admin ledger contradicts.**

This document is the agreement between them. If you change payout or commission
behaviour, change it here first.

---

## 1. The one rule that matters

> Every rule about *which rows count*, *who they belong to*, *what the pre-tax base is*,
> and *what the take rate is* lives in shared code. Neither side reimplements it.

| Concern | Single source | Do **not** |
|---|---|---|
| Which statuses are earnings | `EARNING_STATUSES` in `src/common/payout-policy.ts` | filter on `captured` alone |
| Which rows carry a caregiver share | `CAREGIVER_SHARE_ONLY` | assume every collected payment splits |
| Who a payment belongs to | `caregiverEarningsWhere(nannyId)` | filter on `payments.nanny_id` |
| Pre-tax base | `preTaxServiceFee(payment)` | use `payments.amount` |
| Take rate | `PricingEngineService.getCommissionConfig()` | read env, or hardcode a % in an app |

`src/common/payout-policy.ts` is small and heavily commented. Read it before touching
either service.

---

## 2. Where the commission rate lives

**`system_settings.platform_commission_percent`**, shape `{"percent": 5}`.

- Resolved *only* by `PricingEngineService.getCommissionConfig()` →
  `{ percent, configured }`.
- `RevenueService.getCommissionPercent()` delegates to it. So does
  `PaymentsService.getNannyEarningsAnalytics()`.
- Admins change it at `POST /admin/revenue/commission` (audited,
  `UPDATE_COMMISSION_RATE`). Both apps move on the next request — no release needed.
- Unset or malformed → `{ percent: 0, configured: false }`. **Never a guessed default.**
  Inventing a rate would take money off a caregiver's payout that no admin ever set.
- `configured: false` is what drives the admin "No commission rate set" callout.
  A deliberate 0% and an unset rate are *not* the same thing; don't test `percent === 0`.

Seeded to **5** by migration `20260801130000_seed_commission_and_backfill_payout_nanny`
(`ON CONFLICT DO NOTHING` — an admin-set rate always wins).

There was briefly a `NANNY_COMMISSION_PERCENT` env var. **It is gone.** If you see it
referenced anywhere, that code is stale.

---

## 3. Payment row taxonomy

| Shape | `provider` | snapshot? | Caregiver share? | Platform keeps |
|---|---|---|---|---|
| Normal charge | `razorpay` | yes | yes | take rate |
| Completion placeholder | `manual_pending` | no | yes (owed, uncollected) | nothing — never collected |
| Cancellation fee | `razorpay` | **no** | **no** | 100% |
| Abandoned checkout (`created`) | — | — | no | — |
| `failed` / `refunded` | — | — | no | — |

A cancellation fee is identified as *no price snapshot AND not `manual_pending`* — the
same rule `getParentTransactions` already used to label rows.

> ⚠️ **Open business decision.** "A cancellation fee carries no caregiver share" is a
> policy call, not a derived fact — nobody worked, so there's no service fee to split.
> If the business decides caregivers *are* compensated for a late cancellation, change
> `CAREGIVER_SHARE_ONLY` and both sides move together. Do not special-case it in one app.

---

## 4. Money definitions

```
gross         = payments.amount                    -- what the parent was charged, GST included
gst           = Σ price_snapshots.gst_amount       -- frozen at charge time
net           = gross − gst                        -- the pre-tax service fee; the only base for any split
commission    = net × rate   (splittable rows)
              + net × 100%   (cancellation fees)   -- the platform's revenue
caregiver     = net × (1 − rate)                   -- the payout obligation
```

GST is stripped before *anything* is split — it is collected for the government and is
nobody's income. Because `gst_amount` is frozen per snapshot, flipping `GST_ENABLED`
later never re-states a historical payout.

Commission has **no per-payment column**: the rate applies at read time, so changing it
re-states historical margin. That is deliberate — the platform bills one rate-card price
and the split is internal accounting.

---

## 5. Payout lifecycle

```
captured ──(booking completes)──▶ pending_release ──(admin releases)──▶ pending_release + released_at
```

- Completion flips `captured → pending_release` (`booking.listeners.ts`). **Filtering on
  `captured` alone makes a caregiver's earnings vanish the moment she finishes the job.**
- If a booking completes with no payment attached, a `manual_pending` placeholder is
  written. It records an obligation, not a charge — the parent never paid.
- `released_at` / `released_by` (migration `20260801120000_add_payout_release`) mark a
  payout as settled. Set by `RevenueService.releasePayout` /
  `releasePayoutsForNanny`, audited as `RELEASE_PAYOUT` / `RELEASE_PAYOUT_BATCH`.

The caregiver app splits on `released_at` (`paidOut` vs `outstanding`). Without that it
would keep showing money already in her bank as still owed.

---

## 6. Endpoint contracts

### `GET /payments/nanny/earnings/analytics?period=week|month` (role: NANNY)

```jsonc
{
  "totalEarned": 12000,        // pre-tax service fee, lifetime
  "commissionPercent": 5,      // rate in force — clients MUST display this, never their own
  "commissionAmount": 600,
  "netPayout": 11400,          // totalEarned − commissionAmount
  "paidOut": 4000,             // share of netPayout already released
  "outstanding": 7400,         // netPayout − paidOut
  "jobsCompleted": 24,
  "jobsThisPeriod": 3,
  "periodTotal": 1800,
  "periodChange": 12,          // % vs previous window, null when no baseline
  "trend": [{ "date": "2026-07-25", "amount": 600, "projection": 0 }]
}
```

### `GET /admin/revenue/summary?from&to`

Adds `commissionConfigured: boolean` alongside `commissionPercent`. `payouts.accrued`
excludes cancellation fees; `platform.commission` includes them at 100%.

Other admin routes: `/admin/revenue/trend`, `/admin/revenue/payouts`,
`/admin/revenue/payouts/:paymentId/release`,
`/admin/revenue/payouts/nanny/:nannyId/release`, `GET|POST /admin/revenue/commission`.

### Windowing

Both sides window on **`payments.created_at`**. Previously the caregiver side used
`updated_at`, which put the same booking on a different day in each app — a caregiver
disputing a day's earnings could not be reconciled against the admin ledger.

---

## 7. What changed, and why

Bugs found and fixed while reconciling the two features:

1. **Earnings vanished on completion.** Analytics filtered `status: captured`, but
   completion flips rows to `pending_release`. A caregiver's total dropped to zero as she
   finished work. → both sides use `EARNING_STATUSES`.
2. **Payouts accrued to nobody.** The `manual_pending` placeholder was written without
   `nanny_id`, and every caregiver query filtered on that column. Admin showed the payout
   as owed; the caregiver app showed ₹0. → listener now sets it, migration backfills
   history, and attribution runs through the booking regardless.
3. **"Pending" was fiction.** The old `pendingProcessing` summed `status: created` —
   checkouts a parent opened and *abandoned*. It showed caregivers money that does not
   exist. Removed from the API and the UI.
4. **Commission on GST.** Deducting the take rate from `payments.amount` taxes the
   caregiver on the government's money. → `preTaxServiceFee`.
5. **Two rate sources.** Env var (default 5) vs DB setting (default 0), with no seed row.
   On any existing database the two apps disagreed from the first request. → one resolver,
   one seeded row.
6. **Cancellation fees split as if worked.** Admin accrued 95% of every cancellation fee
   as a caregiver payout the caregiver app would never show; the platform's own revenue
   was understated by the same amount.

---

## 8. Open items

- [ ] **Business decision:** do caregivers get a share of cancellation fees? (§3)
- [ ] **Confirm the seeded rate is 5%**, not 15 — an earlier draft of `revenue.service.ts`
      documented `{ percent: 15 }`. The seed migration currently writes 5.
- [ ] **Refund handling on the caregiver side.** Admin reverses commission on refunds;
      the caregiver side simply excludes `refunded` rows, so earnings silently disappear
      from her total with no explanation in the UI.
- [ ] **Nothing shows a caregiver *when* she'll be paid.** `released_at` exists but there
      is no schedule, and the old UI's hardcoded "Expected next Tuesday" was removed
      because it was invented. Decide the settlement cadence before promising a date.
- [ ] **Stale specs.** `payments.service.spec.ts`, `admin.service.spec.ts`,
      `bookings.service.spec.ts`, `users.service.spec.ts`, both `recurring-requests`
      specs and `bookings.reassignment.spec.ts` fail at `HEAD` with unresolved DI
      (missing `NotificationsService` / `AdminAuditService` in their test modules).
      **Pre-existing — not caused by this work**, but it means neither feature has
      service-level test coverage. `pricing.service.spec.ts` covers commission
      resolution and passes.

---

## 9. Files

**Backend** (`care-connect-backend`, uncommitted on `prod/dev`)

| File | |
|---|---|
| `src/common/payout-policy.ts` | **new** — shared rules |
| `src/common/pricing.service.ts` | `getCommissionConfig()`, `COMMISSION_SETTING_KEY` |
| `src/common/pricing.service.spec.ts` | commission-resolution tests |
| `src/payments/payments.service.ts` | `getNannyEarningsAnalytics`, `getNannyEarnings` |
| `src/payments/payments.controller.ts` | Swagger contract note |
| `src/admin/revenue.service.ts` | ledger; delegates rate, excludes cancellation fees |
| `src/admin/admin.controller.ts` · `admin.module.ts` | revenue routes + wiring |
| `src/bookings/listeners/booking.listeners.ts` | placeholder now sets `nanny_id` |
| `prisma/schema.prisma` | `released_at`, `released_by` |
| `prisma/migrations/20260801120000_add_payout_release/` | payout settlement columns |
| `prisma/migrations/20260801130000_seed_commission_and_backfill_payout_nanny/` | seed + backfill |

**Apps**

| File | |
|---|---|
| `mobile-nanny/src/app/(app)/(tabs)/earnings.tsx` | Total Earned + Your Payout cards |
| `mobile-nanny/src/types/api.ts` · `src/i18n/translations.ts` | contract + EN/HI copy |
| `keel-mobile-admin/src/app/(admin)/revenue.tsx` | callout keys off `commissionConfigured` |
| `keel-mobile-admin/src/types/api.ts` | `RevenueSummary`, `NannyEarningsAnalytics` |

Neither migration has been applied to a live database yet. Run them together — the seed
and the backfill are both required for the two apps to agree.
