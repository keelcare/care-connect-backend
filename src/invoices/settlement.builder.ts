import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PlanEntitlement } from "../common/plan-entitlement.service";
import { cycleWindow } from "../common/utils/pricing.utils";
import { InvoiceConfig } from "./invoice.config";
import { GstConfigService } from "./gst.config";
import { fullName, joinNames } from "./invoice-data.builder";
import {
  InvoiceFact,
  InvoiceTotalLine,
  SettlementCycleRow,
  SettlementData,
} from "./invoice.types";
import {
  formatAmount,
  formatDate,
  formatShortDate,
  formatTime,
} from "./utils/format.util";

const DAY_MS = 86_400_000;

const SETTLEMENT_TERMS = [
  "The sessions listed above are already paid for and remain yours to use on the dates shown.",
  "No further instalments will be raised for this plan. Amounts shown as released are no longer payable.",
  "The matching fee is not refundable — it paid for a placement that was made.",
  "Sessions already delivered, in progress or missed are not returned by a cancellation.",
  "Questions about this statement? Reply to the email it was sent from and quote the statement number.",
];

export interface SettlementInput {
  planId: string;
  settlementNumber: string;
  cancelledAt: Date;
  reason: string | null;
  entitlement: PlanEntitlement;
  /** The sessions the parent keeps, already chosen by the cancellation path. */
  retainedBookingIds: string[];
  amounts: {
    billed: number;
    paid: number;
    voided: number;
    stillOwed: number;
    matchingFeeRetained: number;
  };
}

/**
 * The document a family gets when they cancel a plan.
 *
 * Not a tax document: under the entitlement model no money moves at
 * cancellation, so there is nothing to invoice and nothing to credit. What there
 * is, is a question — *which sessions do I keep, on what dates, and what happens
 * to the rest* — that the system could previously answer only by reading the
 * bookings table. This is that answer, frozen at the moment it was true.
 *
 * The per-cycle working is printed in full rather than summarised. A parent told
 * "you keep 7 sessions" with no arithmetic behind it has no way to check the
 * number, and a support agent has no way to defend it six weeks later once the
 * ledger rows have moved on.
 */
@Injectable()
export class SettlementBuilder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: InvoiceConfig,
    private readonly gst: GstConfigService,
  ) {}

  async build(input: SettlementInput): Promise<SettlementData> {
    const registration = await this.gst.getRegistration();

    const plan = await this.prisma.recurring_service_requests.findUnique({
      where: { id: input.planId },
      select: {
        id: true,
        start_date: true,
        end_date: true,
        plan_type: true,
        plan_duration_months: true,
        days_per_week: true,
        duration_hours: true,
        users: {
          select: {
            id: true,
            email: true,
            profiles: true,
            addresses: {
              where: { deleted_at: null },
              orderBy: [{ is_default: "desc" }, { created_at: "asc" }],
              take: 1,
            },
          },
        },
        nanny: {
          select: {
            profiles: { select: { first_name: true, last_name: true } },
          },
        },
      },
    });
    if (!plan) throw new NotFoundException(`Plan ${input.planId} not found`);

    const [retained, children, documents] = await Promise.all([
      // Ordered by date, not by the order the ids happened to arrive in: the list
      // is read as a calendar.
      input.retainedBookingIds.length
        ? this.prisma.bookings.findMany({
            where: { id: { in: input.retainedBookingIds } },
            orderBy: { start_time: "asc" },
            select: { start_time: true },
          })
        : Promise.resolve([]),
      this.prisma.booking_children.findMany({
        where: { bookings: { recurring_request_id: input.planId } },
        select: { children: true },
        distinct: ["child_id"],
      }),
      this.loadDocuments(input.planId),
    ]);

    const months = Math.max(1, Number(plan.plan_duration_months ?? 1));
    const parentProfile = plan.users?.profiles ?? null;
    const childNames = children
      .map((c) => `${c.children.first_name} ${c.children.last_name}`.trim())
      .filter(Boolean);

    const { sessionsEntitled, sessionsDelivered, sessionsRemaining } =
      input.entitlement;

    return {
      documentTitle: "Cancellation Settlement Statement",
      settlementNumber: input.settlementNumber,
      billedTo: {
        name: fullName(parentProfile) || plan.users?.email || "Parent / Guardian",
        lines: [
          childNames.length
            ? `Parent / Guardian of ${joinNames(childNames)}`
            : "Parent / Guardian",
          plan.users?.addresses?.[0]?.address ??
            parentProfile?.address ??
            parentProfile?.location_address ??
            null,
          [plan.users?.email, parentProfile?.phone].filter(Boolean).join(" · "),
        ].filter((line): line is string => !!line && line.trim().length > 0),
      },
      facts: [
        { label: "Statement date", value: formatDate(input.cancelledAt) },
        { label: "Plan", value: this.planLabel(plan.plan_type, months) },
        {
          label: "Plan period",
          value: this.termLabel(plan.start_date, months),
        },
        { label: "Cancelled on", value: formatDate(input.cancelledAt) },
        ...(input.reason ? [{ label: "Reason", value: input.reason }] : []),
      ],
      ...this.engagement(plan, children),
      headline: this.headline(sessionsRemaining, sessionsDelivered),
      outcome: this.outcome({
        sessionsEntitled,
        sessionsDelivered,
        sessionsRemaining,
      }),
      cycles: this.cycleRows(input, plan.start_date),
      retainedSessions: retained
        .filter((b) => !!b.start_time)
        .map((b) => ({
          date: formatDate(b.start_time),
          time: formatTime(b.start_time),
        })),
      hasRetainedSessions: retained.length > 0,
      totals: this.totals(input),
      documents,
      hasDocuments: documents.length > 0,
      company: this.config.company,
      gst: {
        registered: registration.enabled,
        gstin: registration.gstin,
        legalName: registration.legalName || this.config.company.name,
        placeOfSupply: registration.placeOfSupplyName,
        interState: this.gst.isInterState(registration),
        // A settlement statement is not a supply, so no SAC column belongs on it
        // even when registration is on.
        showSac: false,
      },
      terms: SETTLEMENT_TERMS,
    };
  }

  // ── Sections ───────────────────────────────────────────────────────────────

  /**
   * The sentence a parent reads first. Written for the two cases that actually
   * occur: they have sessions left, or they have used everything they paid for.
   */
  private headline(remaining: number, delivered: number): string {
    if (remaining > 0) {
      return (
        `Your plan has been cancelled and no further payments are due. ` +
        `You keep ${remaining} ${plural(remaining, "session")} that you have already paid for, ` +
        `on the dates listed below.`
      );
    }
    return delivered > 0
      ? "Your plan has been cancelled. Every session you had paid for has already been delivered, so there are no remaining sessions to schedule."
      : "Your plan has been cancelled. No sessions had been paid for, so nothing remains to schedule and nothing further is due.";
  }

  private outcome(input: {
    sessionsEntitled: number;
    sessionsDelivered: number;
    sessionsRemaining: number;
  }): InvoiceFact[] {
    return [
      {
        label: "Sessions paid for",
        value: String(input.sessionsEntitled),
      },
      {
        label: "Sessions already delivered",
        value: String(input.sessionsDelivered),
      },
      { label: "Sessions you keep", value: String(input.sessionsRemaining) },
    ];
  }

  /** The per-cycle arithmetic, so any number above can be checked by hand. */
  private cycleRows(
    input: SettlementInput,
    planStart: Date,
  ): SettlementCycleRow[] {
    return input.entitlement.cycles.map((cycle) => {
      const { start, end } = cycleWindow(planStart, cycle.cycleNumber);
      // Billed and paid are recovered from the fraction rather than re-queried:
      // the fraction is what the retained count was actually derived from, so
      // showing anything else here would be showing different working.
      return {
        label: `Cycle ${cycle.cycleNumber}`,
        period: `${formatShortDate(start)} – ${formatDate(new Date(end.getTime() - DAY_MS))}`,
        billed: `${Math.round(cycle.paidFraction * 100)}% paid`,
        paid: `${Math.round(cycle.paidFraction * 100)}%`,
        sessionsInCycle: String(cycle.sessionsInCycle),
        sessionsEarned: trim(cycle.sessionsEarned),
      };
    });
  }

  private totals(input: SettlementInput): InvoiceTotalLine[] {
    const { billed, paid, voided, stillOwed, matchingFeeRetained } =
      input.amounts;

    const rows: InvoiceTotalLine[] = [
      { label: "Billed to date", amount: formatAmount(billed) },
      { label: "Paid to date", amount: formatAmount(paid) },
    ];

    if (matchingFeeRetained > 0) {
      rows.push({
        label: "Of which matching fee (non-refundable)",
        amount: formatAmount(matchingFeeRetained),
      });
    }
    if (voided > 0) {
      rows.push({
        label: "Released — no longer payable",
        amount: formatAmount(voided),
        negative: true,
      });
    }

    rows.push({
      label: stillOwed > 0 ? "Still payable" : "Nothing further to pay",
      amount: formatAmount(stillOwed),
    });

    return rows;
  }

  private engagement(
    plan: {
      days_per_week: number | null;
      duration_hours: unknown;
      nanny: { profiles: { first_name: string | null; last_name: string | null } | null } | null;
    },
    children: Array<{ children: { first_name: string; last_name: string } }>,
  ): { engagement: InvoiceFact[]; hasEngagement: boolean } {
    const facts: InvoiceFact[] = [];

    const child = children[0]?.children;
    if (child) {
      facts.push({
        label: "Student",
        value: `${child.first_name} ${child.last_name}`.trim(),
      });
    }

    const hours = Number(plan.duration_hours);
    if (plan.days_per_week && Number.isFinite(hours)) {
      facts.push({
        label: "Schedule",
        value: `${plan.days_per_week} days/week · ${trim(hours)} hrs/day`,
      });
    }

    const caregiver = fullName(plan.nanny?.profiles ?? null);
    if (caregiver) facts.push({ label: "Shadow teacher", value: caregiver });

    return { engagement: facts, hasEngagement: facts.length > 0 };
  }

  /**
   * Every tax invoice and credit note already issued against the plan.
   *
   * Listed so the statement is a complete account rather than one more document
   * a family has to reconcile against the others by hand.
   */
  private async loadDocuments(planId: string) {
    const invoices = await this.prisma.invoices.findMany({
      where: { plan_id: planId },
      orderBy: { issued_at: "asc" },
      select: {
        number: true,
        issued_at: true,
        total_amount: true,
        credit_notes: {
          select: { number: true, issued_at: true, total_amount: true },
        },
      },
    });

    const rows: SettlementData["documents"] = [];
    for (const invoice of invoices) {
      rows.push({
        label: "Tax invoice",
        number: invoice.number,
        date: formatDate(invoice.issued_at),
        amount: formatAmount(Number(invoice.total_amount)),
      });
      for (const note of invoice.credit_notes) {
        rows.push({
          label: "Credit note",
          number: note.number,
          date: formatDate(note.issued_at),
          amount: `– ${formatAmount(Number(note.total_amount))}`,
        });
      }
    }
    return rows;
  }

  // ── Labels ─────────────────────────────────────────────────────────────────

  private planLabel(planType: string | null, months: number): string {
    switch (planType) {
      case "MONTHLY":
        return "Monthly plan";
      case "SIX_MONTH":
        return "6-month plan";
      case "YEARLY":
        return "Yearly plan";
      case "ONE_TIME":
        return "One-time booking";
      default:
        return `${months}-month plan`;
    }
  }

  private termLabel(planStart: Date, months: number): string {
    const { end } = cycleWindow(planStart, months);
    return `${formatShortDate(planStart)} – ${formatDate(new Date(end.getTime() - DAY_MS))}`;
  }
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/** `7.000000001` → `7`, `10.5` → `10.5`. */
function trim(value: number): string {
  return String(Number(value.toFixed(2)));
}
