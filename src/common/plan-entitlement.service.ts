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
import {
  countSessionsBetween,
  cycleNumberFor,
  cycleWindow,
} from "./utils/pricing.utils";

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
   * Delivered sessions bucketed by the cycle their date falls in.
   *
   * Needed to tell a month where care outran payment from one where it did not,
   * which is the difference between a balance that is genuinely owed and one that
   * should stop being chased.
   */
  async deliveredByCycle(
    planId: string,
    planStart: Date | string,
  ): Promise<Map<number, number>> {
    const delivered = await this.prisma.bookings.findMany({
      where: {
        recurring_request_id: planId,
        status: { in: DELIVERED_BOOKING_STATUSES },
      },
      select: { start_time: true },
    });

    const byCycle = new Map<number, number>();
    for (const booking of delivered) {
      if (!booking.start_time) continue;
      const { number } = cycleNumberFor(planStart, booking.start_time);
      byCycle.set(number, (byCycle.get(number) ?? 0) + 1);
    }
    return byCycle;
  }

  /**
   * Which cycles' outstanding money stops being owed when a plan is cancelled.
   *
   * The rule this replaces voided only cycles that began *after* the last
   * retained session, on the reasoning that a partly-served month is still being
   * served so its balance stands. That is right when the parent has used more of
   * the month than they paid for and wrong in the far more common case where they
   * have not: a parent who pays a 50% advance on a twenty-session month, attends
   * nothing and cancels correctly keeps ten sessions — and was then still chased
   * for the balance that would have bought the ten sessions just cancelled.
   *
   * What is actually owed is care that was *delivered* beyond what was paid for.
   * Compared in aggregate first, because retained sessions can spill forward: a
   * fully-paid month with five sessions left over hands them to the next month,
   * and that next month must not read as unpaid consumption. Only once delivery
   * genuinely outruns entitlement across the term does the per-cycle comparison
   * decide which months keep their balance.
   *
   * Voiding stays at instalment granularity. Reducing an instalment to a part
   * amount would mean rewriting a frozen billing row, and rounding is left in the
   * parent's favour — consistent with the single floor in `reduce`.
   */
  cyclesToVoid(input: {
    planMonths: number;
    entitlement: PlanEntitlement;
    deliveredByCycle: Map<number, number>;
  }): number[] {
    const { planMonths, entitlement, deliveredByCycle } = input;
    const months = Math.max(1, Math.round(planMonths || 1));

    const allCycles: number[] = [];
    for (let n = 1; n <= months; n++) allCycles.push(n);
    // Cycles billed past the sold term — a plan extended by hand, or a term
    // shortened after the fact — would otherwise keep their balances forever.
    for (const cycle of entitlement.cycles) {
      if (!allCycles.includes(cycle.cycleNumber)) allCycles.push(cycle.cycleNumber);
    }
    allCycles.sort((a, b) => a - b);

    // Nothing was over-consumed across the term, so nothing outstanding is owed.
    if (entitlement.sessionsDelivered <= entitlement.sessionsEntitled) {
      return allCycles;
    }

    const earnedByCycle = new Map(
      entitlement.cycles.map((c) => [c.cycleNumber, c.sessionsEarned]),
    );

    return allCycles.filter((cycle) => {
      const delivered = deliveredByCycle.get(cycle) ?? 0;
      const earned = earnedByCycle.get(cycle) ?? 0;
      // Keep the balance only where this month's care outran this month's money.
      return delivered <= earned + 1e-9;
    });
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
