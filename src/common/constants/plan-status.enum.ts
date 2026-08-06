/**
 * `recurring_service_requests.status`.
 *
 * A plain `VarChar` column rather than a Postgres enum, so these strings are the
 * only definition there is — every filter that decides whether a plan is still
 * live must go through the groupings below rather than spelling out its own list,
 * or a new status silently means "not matched by anything" and the plan falls out
 * of generation, billing and the parent's list at once.
 */
export const PLAN_STATUS = {
  /** Created, waiting for a caregiver. Nothing is billable yet. */
  PENDING: "pending",
  /** A caregiver is serving it. The only state that bills and generates. */
  ACTIVE: "active",
  /**
   * Cancelled by the parent, but sessions they had already paid for are still
   * owed and remain on the calendar. Generation and billing stop; the caregiver
   * stays attached until the last retained session is delivered.
   */
  WINDING_DOWN: "winding_down",
  /** Cancelled with nothing left to deliver. */
  CANCELLED: "cancelled",
  /** Ran its full term, or wound down to its last retained session. */
  COMPLETED: "completed",
  /** Never staffed by its start date. */
  EXPIRED: "expired",
  /** Generation has been stuck long enough to need a human. */
  ERROR: "error",
} as const;

export type PlanStatus = (typeof PLAN_STATUS)[keyof typeof PLAN_STATUS];

/**
 * Plans the rolling generator and the billing cron may act on.
 *
 * `WINDING_DOWN` is deliberately absent: a wound-down plan keeps the sessions it
 * has, but must never grow new ones or open a new cycle to charge for.
 */
export const PLAN_STATUSES_GENERATING: PlanStatus[] = [
  PLAN_STATUS.PENDING,
  PLAN_STATUS.ACTIVE,
];

/** Plans that can no longer be cancelled, because there is nothing left to cancel. */
export const PLAN_STATUSES_TERMINAL: PlanStatus[] = [
  PLAN_STATUS.CANCELLED,
  PLAN_STATUS.COMPLETED,
  PLAN_STATUS.EXPIRED,
];

/**
 * Whether a plan has finished for good. Takes a bare `string` because the column
 * is one, and rows written before a status existed still have to be classified.
 */
export function isTerminalPlanStatus(status: string): boolean {
  return (PLAN_STATUSES_TERMINAL as string[]).includes(status);
}
