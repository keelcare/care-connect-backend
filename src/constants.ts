export const CATEGORY_SKILL_MAP = {
  CC: ["Infant Care", "Toddlers", "Child Care", "Babysitting", "Nanny"],
  ST: ["Shadow Teacher", "Special Education", "Autism Support", "ADHD Support"],
  SN: [
    "Special Needs",
    "Disability Care",
    "Therapy Support",
    "Medical Assistance",
  ],
  EC: ["Elderly Care", "Geriatric Support", "Companion Care"],
};

export enum BookingStatus {
  REQUESTED = "requested",
  CONFIRMED = "CONFIRMED",
  IN_PROGRESS = "IN_PROGRESS",
  COMPLETED = "COMPLETED",
  CANCELLED = "CANCELLED",
  EXPIRED = "EXPIRED",
  PARENT_NO_SHOW = "PARENT_NO_SHOW",
}

export enum PaymentStatus {
  CREATED = "created",
  CAPTURED = "captured",
  FAILED = "failed",
  REFUNDED = "refunded",
  PENDING_RELEASE = "pending_release",
  /**
   * A row that no longer represents anything owed or collected. Only the
   * `manual_pending` completion placeholder reaches it: once the parent actually
   * pays for the session the placeholder stood in for, keeping it in an earning
   * status would pay the caregiver for the same care twice.
   *
   * Voided rather than deleted so the audit trail survives. Every payments query is
   * a status whitelist of `captured` / `pending_release` / `refunded` / `failed`, so
   * a voided row drops out of earnings, the revenue ledger and parent transactions
   * without any of them needing to know this status exists.
   */
  VOID = "void",
}

/**
 * Provider on the placeholder `payments` row written when a booking completes with no
 * payment attached. It records a payout obligation, not a charge the parent made.
 */
export const MANUAL_PENDING_PROVIDER = "manual_pending";

/**
 * `payment_installments.status`. Plain strings rather than a Prisma enum, matching
 * how `price_snapshots.status` and `payment_plans.status` are already modelled.
 *
 * `void` is for money that stopped being owed — a cancelled booking, or the sibling
 * of a refunded half — so it drops out of the pending list and the dunning cron
 * without pretending it was ever collected.
 */
export const INSTALMENT_PENDING = "pending";
export const INSTALMENT_PAID = "paid";
/**
 * `payment_installments.kind` for the one-off placement fee.
 *
 * Lives here rather than beside the pricing engine because the payout policy has
 * to recognise it too: the fee is the platform's charge for making the match, not
 * a share of anyone's care, and a rule that only the engine knows about is one the
 * ledger contradicts.
 */
export const MATCHING_FEE_KIND = "matching_fee";
export const INSTALMENT_VOID = "void";
export const INSTALMENT_REFUNDED = "refunded";

/**
 * OAuth callback error codes. These are returned to clients as
 * `?error=<code>` on the redirect back into the app, so they are a public
 * contract — clients map them to user-facing copy. Keep them stable.
 *
 * `auth_failed` is the catch-all for anything without a specific remedy.
 */
export const OAUTH_ERROR_UNVERIFIED_ACCOUNT = "unverified_account_exists";
export const OAUTH_ERROR_GENERIC = "auth_failed";

/**
 * `bookings.cancellation_fee_status`.
 *
 * `owed` replaces the old `charged`/`pending` pair. `charged` was never true: the
 * code that set it created a Razorpay order and wrote a `payments` row directly to
 * `captured` without debiting anyone, so it recorded revenue that did not exist and
 * could not be refunded (no gateway payment id). `pending` was written on the
 * failure branch and read by nothing — no dunning job, no retry — so a genuinely
 * failed charge was abandoned silently.
 *
 * A fee is now recorded as `owed` and stays that way until the parent settles it
 * through the ordinary checkout path. Clients must treat `owed` as an outstanding
 * amount, never as collected.
 *
 * `charged` still appears on historical rows written before this change. Those are
 * the phantom ones — see the client handoff doc; they must not be read as paid.
 */
export const CANCELLATION_FEE_NONE = "no_fee";
export const CANCELLATION_FEE_OWED = "owed";
/**
 * The parent settled the fee through the real checkout path
 * (`createCancellationFeeOrder` → Razorpay → capture). Unlike the historical
 * `charged`, a row only ever reaches `paid` off the back of a gateway capture
 * with a payment id, so it is refundable like any other charge.
 */
export const CANCELLATION_FEE_PAID = "paid";

/**
 * Version of the Privacy Notice currently in force. Must be kept in step with
 * `LEGAL.version` in the mobile apps (src/lib/legal.ts) — a consent row records
 * the version of the notice the user was actually shown, so if these drift the
 * audit trail points at the wrong document.
 *
 * Bump whenever the substance of the notice changes; users are then re-prompted
 * and a fresh consent row is written against the new version.
 */
export const CONSENT_POLICY_VERSION = "1.2";
