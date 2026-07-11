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
