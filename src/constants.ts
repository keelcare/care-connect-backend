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
