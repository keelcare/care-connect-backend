import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  INSTALMENT_PAID,
  INSTALMENT_PENDING,
  MATCHING_FEE_KIND,
} from "../constants";
import { InvoiceConfig } from "./invoice.config";
import {
  InvoiceData,
  InvoiceFact,
  InvoiceLineItem,
  InvoiceTotalLine,
} from "./invoice.types";
import {
  amountInWords,
  formatAmount,
  formatDate,
  formatMonthRange,
  formatShortDate,
} from "./utils/format.util";

/** Weeks a monthly cycle is priced over — mirrors `weeksInCycleFor('MONTHLY')`. */
const WEEKS_PER_CYCLE = 4;

/**
 * Statuses that belong on the document. A `void` instalment was superseded
 * before anyone paid it and a `refunded` one has been unwound; billing either
 * on a live invoice would overstate what the family owes.
 */
export const INVOICEABLE_STATUSES = [INSTALMENT_PENDING, INSTALMENT_PAID];

const DEFAULT_TERMS = [
  "Payment is due by the date shown above. Placement begins only once the first instalment is received.",
  "Fees are payable in instalments as set out in the Service & Payment Policy.",
  "The matching fee is non-refundable once a shadow teacher has been assigned.",
  "Families are requested not to engage an assigned shadow teacher directly or outside Keel.",
  "Please quote the invoice number as the payment reference.",
];

type LoadedBooking = Awaited<ReturnType<InvoiceDataBuilder["load"]>>;
type LoadedInstallment = LoadedBooking["payment_installments"][number];
type LoadedRequest =
  | LoadedBooking["service_requests"]
  | LoadedBooking["recurring_service_requests"];

/**
 * Turns one booking's instalments into render-ready `InvoiceData`.
 *
 * The booking is the invoice unit. It used to be the instalment, which meant an
 * engagement with a matching fee and a session fee handed the family two
 * separate documents for one thing they bought — the app then had to offer two
 * download buttons and let the parent work out that they were halves of the same
 * bill. Every fee is now a line item on one invoice, which is also how the
 * totals block was always designed to read.
 *
 * Money is read straight off the frozen installment/snapshot columns and never
 * recomputed here. Those columns exist precisely so a later rate change, GST
 * flip or rounding fix cannot re-state a document a family already holds.
 */
@Injectable()
export class InvoiceDataBuilder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: InvoiceConfig,
  ) {}

  async buildForBooking(
    bookingId: string,
    invoiceNumber: string,
    issuedAt: Date,
  ): Promise<InvoiceData> {
    const booking = await this.load(bookingId);
    const request: LoadedRequest =
      booking.service_requests ?? booking.recurring_service_requests;

    const installments = this.ordered(booking.payment_installments);
    if (installments.length === 0) {
      throw new NotFoundException(
        `Booking ${bookingId} has nothing to invoice for`,
      );
    }

    // A single unpaid instalment keeps the whole document a bill: the paid badge
    // must never appear on an invoice that still has money outstanding.
    const paid = installments.every((i) => i.status === INSTALMENT_PAID);
    const total = this.sum(installments, (i) => Number(i.amount));
    const paidToDate = this.sum(
      installments.filter((i) => i.status === INSTALMENT_PAID),
      (i) => Number(i.amount),
    );
    const outstanding = Math.round((total - paidToDate) * 100) / 100;

    const children = booking.booking_children.map((bc) => bc.children);
    const engagement = this.buildEngagement(children, booking);
    const childNames = children
      .map((c) => `${c.first_name} ${c.last_name}`.trim())
      .filter(Boolean);

    const parent = booking.users_bookings_parent_idTousers;
    const parentProfile = parent?.profiles ?? null;
    const parentAddress =
      parent?.addresses?.[0]?.address ??
      parentProfile?.address ??
      parentProfile?.location_address ??
      null;

    return {
      invoiceNumber,
      paid,
      billedTo: {
        name:
          this.fullName(parentProfile) || parent?.email || "Parent / Guardian",
        lines: [
          childNames.length
            ? `Parent / Guardian of ${this.joinNames(childNames)}`
            : "Parent / Guardian",
          parentAddress,
          [parent?.email, parentProfile?.phone].filter(Boolean).join(" · "),
        ].filter((line): line is string => !!line && line.trim().length > 0),
      },
      facts: this.buildFacts({
        issuedAt,
        paid,
        installments,
        booking,
        request,
        amount: paid ? total : outstanding,
      }),
      engagement,
      hasEngagement: engagement.length > 0,
      items: installments.map((installment) =>
        this.buildItem({ installment, booking, request }),
      ),
      totals: this.buildTotals({ installments, paid, paidToDate }),
      grandTotal: {
        label: paid ? "Total paid" : "Balance due",
        amount: formatAmount(paid ? total : outstanding),
      },
      amountInWords: amountInWords(paid ? total : outstanding),
      company: this.config.company,
      payment: this.config.paymentDetails(invoiceNumber),
      terms: DEFAULT_TERMS,
    };
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  /**
   * One query, because every section of the document needs a different corner of
   * the booking graph and an invoice assembled from six round trips could observe
   * a mid-flight status change halfway down the page.
   */
  private async load(bookingId: string) {
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      include: {
        payment_installments: {
          where: { status: { in: INVOICEABLE_STATUSES } },
          include: { price_snapshots: true },
        },
        service_requests: true,
        recurring_service_requests: true,
        booking_children: { include: { children: true } },
        users_bookings_parent_idTousers: {
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
        users_bookings_nanny_idTousers: {
          select: {
            profiles: { select: { first_name: true, last_name: true } },
          },
        },
      },
    });

    if (!booking) {
      throw new NotFoundException(`Booking ${bookingId} not found`);
    }
    return booking;
  }

  /**
   * Reading order for the line items: the matching fee is what the family paid
   * first and is the one deducted from the plan, so it heads the list; the rest
   * run in the order they were billed.
   */
  private ordered(installments: LoadedInstallment[]): LoadedInstallment[] {
    return [...installments].sort((a, b) => {
      const aMatching = a.kind === MATCHING_FEE_KIND ? 0 : 1;
      const bMatching = b.kind === MATCHING_FEE_KIND ? 0 : 1;
      return (
        aMatching - bMatching ||
        (a.cycle_number ?? 0) - (b.cycle_number ?? 0) ||
        a.installment_no - b.installment_no
      );
    });
  }

  // ── Sections ───────────────────────────────────────────────────────────────

  private buildFacts(input: {
    issuedAt: Date;
    paid: boolean;
    installments: LoadedInstallment[];
    booking: LoadedBooking;
    request: LoadedRequest;
    amount: number;
  }): InvoiceFact[] {
    const { issuedAt, paid, installments, booking, request, amount } = input;

    const facts: InvoiceFact[] = [
      { label: "Invoice date", value: formatDate(issuedAt) },
    ];

    if (paid) {
      // The date the engagement was fully settled — the last payment, not the first.
      facts.push({
        label: "Paid on",
        value: formatDate(this.latest(installments.map((i) => i.paid_at))),
      });
    } else {
      // The soonest thing outstanding is what the parent has to act on. A balance
      // with no due date yet is waiting on its advance being paid, so it is
      // payable on receipt rather than late.
      const outstanding = installments.filter(
        (i) => i.status !== INSTALMENT_PAID,
      );
      const due = this.earliest(outstanding.map((i) => i.due_date));
      facts.push({
        label: "Due date",
        value: due ? formatDate(due) : "On receipt",
      });
    }

    const period = this.billingPeriod(booking, request, installments);
    if (period) facts.push({ label: "Billing period", value: period });

    facts.push({
      label: paid ? "Amount paid" : "Amount due",
      value: `₹ ${formatAmount(amount)}`,
    });

    return facts;
  }

  private buildEngagement(
    children: LoadedBooking["booking_children"][number]["children"][],
    booking: LoadedBooking,
  ): InvoiceFact[] {
    const facts: InvoiceFact[] = [];
    const child = children[0];

    if (child) {
      const school = this.schoolDetails(child.school_details);
      const name = `${child.first_name} ${child.last_name}`.trim();
      facts.push({
        label: "Student",
        value: school.grade ? `${name} · ${school.grade}` : name,
      });
      if (school.name) facts.push({ label: "School", value: school.name });
    }

    const caregiver = this.fullName(
      booking.users_bookings_nanny_idTousers?.profiles ?? null,
    );
    if (caregiver) facts.push({ label: "Shadow teacher", value: caregiver });

    return facts;
  }

  /** One instalment, as one row of the items table. */
  private buildItem(input: {
    installment: LoadedInstallment;
    booking: LoadedBooking;
    request: LoadedRequest;
  }): InvoiceLineItem {
    const { installment, booking, request } = input;
    // Line items carry the pre-tax figure; GST is its own totals row, so a parent
    // comparing the invoice against their bank statement can see where the
    // difference came from.
    const value = formatAmount(Number(installment.subtotal_amount));

    if (installment.kind === MATCHING_FEE_KIND) {
      return {
        name: "Matching & placement fee",
        description:
          "Verification, shortlisting and assignment of a shadow teacher; " +
          "onboarding and school coordination. Deducted from the plan total, " +
          "not charged on top of it.",
        qty: "1",
        rate: value,
        amount: value,
      };
    }

    const hoursPerDay = this.toNumber(
      booking.hours_per_day ?? request?.duration_hours,
    );
    const daysPerWeek = booking.days_per_week ?? request?.days_per_week ?? null;

    const schedule =
      hoursPerDay && daysPerWeek
        ? `In-school support, ${daysPerWeek} days per week, ${this.trimNumber(hoursPerDay)} hours per day. `
        : "In-school support. ";

    const window = this.cycleWindow(booking, installment.cycle_number);
    const periodText = window
      ? `Period: ${formatShortDate(window.from)} – ${formatDate(window.to)}.`
      : "";

    return {
      name:
        installment.total_installments > 1
          ? `Shadow teacher support — Instalment ${installment.installment_no} of ${installment.total_installments}`
          : "Shadow teacher support",
      description: `${schedule}${periodText}`.trim(),
      qty: "1",
      rate: value,
      amount: value,
    };
  }

  private buildTotals(input: {
    installments: LoadedInstallment[];
    paid: boolean;
    paidToDate: number;
  }): InvoiceTotalLine[] {
    const { installments, paid, paidToDate } = input;

    const totals: InvoiceTotalLine[] = [
      {
        label: "Subtotal",
        amount: formatAmount(
          this.sum(installments, (i) => Number(i.subtotal_amount)),
        ),
      },
    ];

    // GST is grouped by the rate that was actually charged: instalments billed
    // either side of a rate change must not be silently merged into one line at
    // a percentage neither of them used.
    for (const [percent, amount] of this.gstByRate(installments)) {
      // A ₹0.00 tax line invites the question of whether it should have been
      // there, so a rate that raised nothing is omitted rather than shown.
      if (amount > 0) {
        totals.push({
          label: `GST (${this.trimNumber(percent)}%)`,
          amount: formatAmount(amount),
        });
      }
    }

    // Only on a part-paid engagement: on a fully settled one the grand total is
    // already labelled "Total paid", and on an untouched one this would be ₹0.00.
    if (!paid && paidToDate > 0) {
      totals.push({
        label: "Already paid",
        amount: formatAmount(paidToDate),
        negative: true,
      });
    }

    return totals;
  }

  // ── Derivations ────────────────────────────────────────────────────────────

  /** Total GST per rate, in the order the rates first appear on the invoice. */
  private gstByRate(installments: LoadedInstallment[]): Map<number, number> {
    const byRate = new Map<number, number>();
    for (const installment of installments) {
      const percent = Number(
        installment.price_snapshots?.gst_percent_used ?? 0,
      );
      byRate.set(
        percent,
        (byRate.get(percent) ?? 0) + Number(installment.gst_amount),
      );
    }
    return byRate;
  }

  /**
   * The months this plan spans, for the header fact. Falls back to the window of
   * the cycles actually billed when the booking is not a multi-month plan.
   */
  private billingPeriod(
    booking: LoadedBooking,
    request: LoadedRequest,
    installments: LoadedInstallment[],
  ): string | null {
    const start = booking.start_time ?? booking.created_at;
    if (!start) return null;

    const months =
      booking.plan_duration_months || request?.plan_duration_months || 1;
    if (months <= 1) {
      // The last cycle billed is the far end of the period; the matching fee has
      // no cycle of its own, so it cannot shorten it.
      const cycles = installments
        .filter((i) => i.kind !== MATCHING_FEE_KIND)
        .map((i) => i.cycle_number ?? 1);
      const window = this.cycleWindow(booking, Math.max(1, ...cycles));
      return window
        ? formatMonthRange(start, window.to)
        : formatMonthRange(start, start);
    }

    const end = new Date(start);
    end.setMonth(end.getMonth() + months - 1);
    return formatMonthRange(start, end);
  }

  /**
   * The dates a given cycle covers, derived from the booking start plus whole
   * cycles. Approximate by design — cycles are priced as four-week blocks and
   * there is no per-cycle date range stored to read instead.
   */
  private cycleWindow(
    booking: LoadedBooking,
    cycleNumber: number,
  ): { from: Date; to: Date } | null {
    const start = booking.start_time ?? booking.created_at;
    if (!start) return null;

    const cycleIndex = Math.max(0, (cycleNumber || 1) - 1);
    const from = new Date(start);
    from.setDate(from.getDate() + cycleIndex * WEEKS_PER_CYCLE * 7);

    const to = new Date(from);
    to.setDate(to.getDate() + WEEKS_PER_CYCLE * 7 - 1);

    return { from, to };
  }

  /** `children.school_details` is free-form JSON; read it defensively. */
  private schoolDetails(raw: unknown): {
    name: string | null;
    grade: string | null;
  } {
    if (!raw || typeof raw !== "object") return { name: null, grade: null };
    const details = raw as Record<string, unknown>;

    const name = details.school_name ?? details.name ?? details.school;
    const rawGrade = details.grade ?? details.class ?? details.standard;
    const grade = rawGrade == null ? "" : String(rawGrade).trim();

    return {
      name: typeof name === "string" && name.trim() ? name.trim() : null,
      grade: !grade ? null : /^\d+$/.test(grade) ? `Grade ${grade}` : grade,
    };
  }

  private fullName(
    profile: { first_name?: string | null; last_name?: string | null } | null,
  ): string {
    return [profile?.first_name, profile?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  private joinNames(names: string[]): string {
    if (names.length <= 1) return names[0] ?? "";
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }

  private sum<T>(rows: T[], value: (row: T) => number): number {
    // Rounded back to paise: the columns are Decimal(12,2), but summing them as
    // floats can leave a 0.000000001 tail that formats as a rupee out.
    return (
      Math.round(rows.reduce((acc, row) => acc + value(row), 0) * 100) / 100
    );
  }

  private earliest(dates: Array<Date | null>): Date | null {
    const known = dates.filter((d): d is Date => !!d);
    return known.length
      ? new Date(Math.min(...known.map((d) => d.getTime())))
      : null;
  }

  private latest(dates: Array<Date | null>): Date | null {
    const known = dates.filter((d): d is Date => !!d);
    return known.length
      ? new Date(Math.max(...known.map((d) => d.getTime())))
      : null;
  }

  private toNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /** `4.00` → `4`, `18.50` → `18.5` — trailing zeros read as false precision. */
  private trimNumber(value: number): string {
    return String(Number(value));
  }
}
