import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { BookingStatus } from "./constants/booking-status.enum";
import {
  INSTALMENT_PAID,
  INSTALMENT_REFUNDED,
  INSTALMENT_VOID,
  MATCHING_FEE_KIND,
} from "../constants";
import { MATCHING_FEE_CYCLE } from "./pricing.service";
import { countSessionsBetween, cycleWindow } from "./utils/pricing.utils";

/**
 * Sessions a plan has already used up. A session that was served — or that the
 * parent was marked absent for — is spent either way; only a cancellation gives
 * it back.
 */
export const DELIVERED_BOOKING_STATUSES: BookingStatus[] = [
  BookingStatus.COMPLETED,
  BookingStatus.IN_PROGRESS,
  BookingStatus.PARENT_NO_SHOW,
  BookingStatus.NANNY_NO_SHOW,
];

/** Per-cycle working shown alongside the total, so a support agent can audit a number. */
export interface EntitlementCycle {
  cycleNumber: number;
  /** Amount-weighted share of this cycle that has actually been captured, 0..1. */
  paidFraction: number;
  sessionsInCycle: number;
  /** `paidFraction × sessionsInCycle`, unrounded. */
  sessionsEarned: number;
}

export interface PlanEntitlement {
  /** Sessions the parent has paid for across every billed cycle. */
  sessionsEntitled: number;
  /** Sessions already served (or no-showed). */
  sessionsDelivered: number;
  /** What is still owed to them: `max(0, entitled − delivered)`. */
  sessionsRemaining: number;
  cycles: EntitlementCycle[];
}

/**
 * How many sessions of a recurring plan the parent has actually bought.
 *
 * A plan is sold as a term but billed a month at a time, each cycle split into a
 * 50% advance and a 50% balance. Cancelling used to void the whole remaining
 * schedule regardless of that — a parent who had paid an advance covering twenty
 * sessions and used three lost the other seventeen outright. Entitlement is the
 * number that stops it: money already captured buys a proportional number of
 * sessions, and those survive cancellation.
 *
 * Deliberately derived rather than stored. The inputs (`payment_installments`)
 * are the ledger, and a cached counter beside them is a second source of truth
 * that drifts the first time a webhook is replayed or an admin voids a row. The
 * one exception is the moment of cancellation, which *is* snapshotted onto the
 * plan — see `sessions_entitled_at_cancellation`.
 */
@Injectable()
export class PlanEntitlementService {
  private readonly logger = new Logger(PlanEntitlementService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Entitlement for one plan.
   *
   * `deliveredOverride` lets a caller that has already counted delivered sessions
   * (the cancellation path, which needs them inside its own transaction) avoid a
   * second query.
   */
  async computeEntitlement(
    planId: string,
    deliveredOverride?: number,
  ): Promise<PlanEntitlement> {
    const plan = await this.prisma.recurring_service_requests.findUnique({
      where: { id: planId },
      select: {
        id: true,
        start_date: true,
        plan_duration_months: true,
        recurrence_type: true,
        recurrence_pattern: true,
      },
    });

    if (!plan) {
      return {
        sessionsEntitled: 0,
        sessionsDelivered: 0,
        sessionsRemaining: 0,
        cycles: [],
      };
    }

    const [installments, delivered] = await Promise.all([
      // Installments reach the plan through their booking. Every cycle of a plan
      // hangs off a single anchor booking (`planBillingAnchor`), so this is not
      // "the installments of the sessions in this cycle" — there is no such
      // thing. Filtering on the plan rather than the anchor id keeps it correct
      // even if the anchor moves.
      this.prisma.payment_installments.findMany({
        where: {
          bookings: { recurring_request_id: planId },
          // The matching fee buys a placement, not care. It is carved *out of*
          // cycle 1's total, so cycle 1's own fraction is already net of it and
          // counting the fee again here would hand out free sessions.
          kind: { not: MATCHING_FEE_KIND },
          cycle_number: { not: MATCHING_FEE_CYCLE },
        },
        select: { cycle_number: true, amount: true, status: true },
      }),
      deliveredOverride !== undefined
        ? Promise.resolve(deliveredOverride)
        : this.countDelivered(planId),
    ]);

    return this.reduce(plan, installments, delivered);
  }

  /** Entitlement for many plans at once, so the parent's list stays one round trip per table. */
  async computeEntitlementMany(
    planIds: string[],
  ): Promise<Map<string, PlanEntitlement>> {
    const out = new Map<string, PlanEntitlement>();
    if (planIds.length === 0) return out;

    const [plans, installments, deliveredCounts] = await Promise.all([
      this.prisma.recurring_service_requests.findMany({
        where: { id: { in: planIds } },
        select: {
          id: true,
          start_date: true,
          plan_duration_months: true,
          recurrence_type: true,
          recurrence_pattern: true,
        },
      }),
      this.prisma.payment_installments.findMany({
        where: {
          bookings: { recurring_request_id: { in: planIds } },
          kind: { not: MATCHING_FEE_KIND },
          cycle_number: { not: MATCHING_FEE_CYCLE },
        },
        select: {
          cycle_number: true,
          amount: true,
          status: true,
          bookings: { select: { recurring_request_id: true } },
        },
      }),
      this.prisma.bookings.groupBy({
        by: ["recurring_request_id"],
        where: {
          recurring_request_id: { in: planIds },
          status: { in: DELIVERED_BOOKING_STATUSES },
        },
        _count: { _all: true },
      }),
    ]);

    const deliveredByPlan = new Map(
      deliveredCounts.map((row) => [
        row.recurring_request_id as string,
        row._count._all,
      ]),
    );
    const instByPlan = new Map<string, typeof installments>();
    for (const inst of installments) {
      const planId = inst.bookings?.recurring_request_id;
      if (!planId) continue;
      const list = instByPlan.get(planId) ?? [];
      list.push(inst);
      instByPlan.set(planId, list);
    }

    for (const plan of plans) {
      out.set(
        plan.id,
        this.reduce(
          plan,
          instByPlan.get(plan.id) ?? [],
          deliveredByPlan.get(plan.id) ?? 0,
        ),
      );
    }
    return out;
  }

  /** Sessions of a plan that are spent — served, under way, or no-showed. */
  async countDelivered(planId: string): Promise<number> {
    return this.prisma.bookings.count({
      where: {
        recurring_request_id: planId,
        status: { in: DELIVERED_BOOKING_STATUSES },
      },
    });
  }

  /**
   * Which cycles of a plan are wholly beyond a cut-off date, and so are no longer
   * being served at all.
   *
   * Used by cancellation to decide whose pending installments to void. A cycle
   * that is only *partly* dropped is not included: the parent is still being
   * served part of that month, so what they owe for it stands.
   */
  droppedCyclesAfter(
    planStart: Date | string,
    planMonths: number,
    cutoff: Date,
  ): number[] {
    const months = Math.max(1, Math.round(planMonths || 1));
    const dropped: number[] = [];
    for (let n = 1; n <= months; n++) {
      const { start } = cycleWindow(planStart, n);
      if (start >= cutoff) dropped.push(n);
    }
    return dropped;
  }

  /** Money that is still owed, as opposed to captured, voided or refunded. */
  private isOutstanding(status: string): boolean {
    return (
      status !== INSTALMENT_PAID &&
      status !== INSTALMENT_VOID &&
      status !== INSTALMENT_REFUNDED
    );
  }

  /**
   * The arithmetic itself, over already-fetched rows, so the single-plan and
   * batched paths can never disagree about what a cycle is worth.
   */
  private reduce(
    plan: {
      start_date: Date;
      recurrence_type: string;
      recurrence_pattern: unknown;
    },
    installments: { cycle_number: number; amount: unknown; status: string }[],
    delivered: number,
  ): PlanEntitlement {
    const byCycle = new Map<number, { billed: number; paid: number }>();
    for (const inst of installments) {
      const bucket = byCycle.get(inst.cycle_number) ?? { billed: 0, paid: 0 };
      const amount = Number(inst.amount);
      // Voided and refunded money is neither billed nor paid — it stopped being
      // owed, so it leaves both sides of the ratio rather than dragging the
      // fraction down as though it were still outstanding.
      if (inst.status === INSTALMENT_PAID) {
        bucket.billed += amount;
        bucket.paid += amount;
      } else if (this.isOutstanding(inst.status)) {
        bucket.billed += amount;
      }
      byCycle.set(inst.cycle_number, bucket);
    }

    const cycles: EntitlementCycle[] = [];
    let rawEntitled = 0;
    for (const [cycleNumber, { billed, paid }] of [...byCycle.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      // A cycle whose every installment was voided has nothing paid and nothing
      // left to pay: it buys no sessions, and the ratio would otherwise be NaN.
      const paidFraction = billed > 0 ? Math.min(1, paid / billed) : 0;
      const { start, end } = cycleWindow(plan.start_date, cycleNumber);
      const sessionsInCycle = countSessionsBetween(
        start,
        end,
        plan.recurrence_type,
        plan.recurrence_pattern,
      );
      const sessionsEarned = paidFraction * sessionsInCycle;
      rawEntitled += sessionsEarned;
      cycles.push({
        cycleNumber,
        paidFraction,
        sessionsInCycle,
        sessionsEarned,
      });
    }

    // Floored once over the whole term, not per cycle. Flooring each cycle
    // separately throws away up to a session a month for the same money: two
    // half-paid cycles of 21 sessions are 21 sessions bought, but rounded
    // per-cycle they read as 20. Round in the parent's favour — they paid.
    const sessionsEntitled = Math.floor(rawEntitled + 1e-9);
    return {
      sessionsEntitled,
      sessionsDelivered: delivered,
      sessionsRemaining: Math.max(0, sessionsEntitled - delivered),
      cycles,
    };
  }
}
