import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { INSTALMENT_PAID, MATCHING_FEE_KIND } from "../constants";
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

const DEFAULT_TERMS = [
  "Payment is due by the date shown above. Placement begins only once the first instalment is received.",
  "Fees are payable in instalments as set out in the Service & Payment Policy.",
  "The matching fee is non-refundable once a shadow teacher has been assigned.",
  "Families are requested not to engage an assigned shadow teacher directly or outside Keel.",
  "Please quote the invoice number as the payment reference.",
];

type LoadedInstallment = Awaited<ReturnType<InvoiceDataBuilder["load"]>>;
type LoadedBooking = LoadedInstallment["bookings"];
type LoadedRequest =
  | LoadedBooking["service_requests"]
  | LoadedBooking["recurring_service_requests"];

/**
 * Turns one `payment_installments` row into render-ready `InvoiceData`.
 *
 * The installment — not the payment, not the booking — is the invoice unit,
 * because it is the thing a parent is actually asked to pay: one line on the
 * pending list, one Razorpay order, one amount. A cycle split into an advance
 * and a balance therefore produces two invoices, which is exactly what the
 * "Instalment 1 of 2" row in the design was always describing.
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

  async build(
    installmentId: string,
    invoiceNumber: string,
    issuedAt: Date,
  ): Promise<InvoiceData> {
    const installment = await this.load(installmentId);
    const booking = installment.bookings;
    const request: LoadedRequest =
      booking.service_requests ?? booking.recurring_service_requests;

    const paid = installment.status === INSTALMENT_PAID;
    const isMatchingFee = installment.kind === MATCHING_FEE_KIND;

    const amount = Number(installment.amount);
    const subtotal = Number(installment.subtotal_amount);
    const gstAmount = Number(installment.gst_amount);
    const gstPercent = Number(installment.price_snapshots.gst_percent_used);

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
        installment,
        booking,
        request,
        amount,
      }),
      engagement,
      hasEngagement: engagement.length > 0,
      items: this.buildItems({
        installment,
        booking,
        request,
        isMatchingFee,
        subtotal,
      }),
      totals: this.buildTotals({ subtotal, gstPercent, gstAmount }),
      grandTotal: {
        label: paid ? "Total paid" : "Total due",
        amount: formatAmount(amount),
      },
      amountInWords: amountInWords(amount),
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
  private async load(installmentId: string) {
    const installment = await this.prisma.payment_installments.findUnique({
      where: { id: installmentId },
      include: {
        price_snapshots: true,
        bookings: {
          include: {
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
        },
      },
    });

    if (!installment) {
      throw new NotFoundException(`Installment ${installmentId} not found`);
    }
    return installment;
  }

  // ── Sections ───────────────────────────────────────────────────────────────

  private buildFacts(input: {
    issuedAt: Date;
    paid: boolean;
    installment: LoadedInstallment;
    booking: LoadedBooking;
    request: LoadedRequest;
    amount: number;
  }): InvoiceFact[] {
    const { issuedAt, paid, installment, booking, request, amount } = input;

    const facts: InvoiceFact[] = [
      { label: "Invoice date", value: formatDate(issuedAt) },
    ];

    if (paid) {
      facts.push({ label: "Paid on", value: formatDate(installment.paid_at) });
    } else {
      // A balance with no due date yet is waiting on its advance being paid, so
      // it is payable on receipt rather than late.
      facts.push({
        label: "Due date",
        value: installment.due_date
          ? formatDate(installment.due_date)
          : "On receipt",
      });
    }

    const period = this.billingPeriod(
      booking,
      request,
      installment.cycle_number,
    );
    if (period) facts.push({ label: "Billing period", value: period });

    if (installment.total_installments > 1) {
      facts.push({
        label: "Instalment",
        value: `${installment.installment_no} of ${installment.total_installments}`,
      });
    }

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

  private buildItems(input: {
    installment: LoadedInstallment;
    booking: LoadedBooking;
    request: LoadedRequest;
    isMatchingFee: boolean;
    subtotal: number;
  }): InvoiceLineItem[] {
    const { installment, booking, request, isMatchingFee, subtotal } = input;
    // Line items carry the pre-tax figure; GST is its own totals row, so a parent
    // comparing the invoice against their bank statement can see where the
    // difference came from.
    const value = formatAmount(subtotal);

    if (isMatchingFee) {
      return [
        {
          name: "Matching & placement fee",
          description:
            "Verification, shortlisting and assignment of a shadow teacher; " +
            "onboarding and school coordination. Deducted from the plan total, " +
            "not charged on top of it.",
          qty: "1",
          rate: value,
          amount: value,
        },
      ];
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

    return [
      {
        name:
          installment.total_installments > 1
            ? `Shadow teacher support — Instalment ${installment.installment_no}`
            : "Shadow teacher support",
        description: `${schedule}${periodText}`.trim(),
        qty: "1",
        rate: value,
        amount: value,
      },
    ];
  }

  private buildTotals(input: {
    subtotal: number;
    gstPercent: number;
    gstAmount: number;
  }): InvoiceTotalLine[] {
    const totals: InvoiceTotalLine[] = [
      { label: "Subtotal", amount: formatAmount(input.subtotal) },
    ];
    // GST is omitted rather than shown as zero when none was charged: a ₹0.00 tax
    // line invites the question of whether it should have been there.
    if (input.gstAmount > 0) {
      totals.push({
        label: `GST (${this.trimNumber(input.gstPercent)}%)`,
        amount: formatAmount(input.gstAmount),
      });
    }
    return totals;
  }

  // ── Derivations ────────────────────────────────────────────────────────────

  /**
   * The months this plan spans, for the header fact. Falls back to the single
   * cycle's window when the booking is not a multi-month plan.
   */
  private billingPeriod(
    booking: LoadedBooking,
    request: LoadedRequest,
    cycleNumber: number,
  ): string | null {
    const start = booking.start_time ?? booking.created_at;
    if (!start) return null;

    const months =
      booking.plan_duration_months || request?.plan_duration_months || 1;
    if (months <= 1) {
      const window = this.cycleWindow(booking, cycleNumber);
      return window
        ? formatMonthRange(window.from, window.to)
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
