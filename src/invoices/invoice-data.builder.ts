import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  INSTALMENT_PAID,
  INSTALMENT_PENDING,
  MATCHING_FEE_KIND,
} from "../constants";
import {
  countSessionsBetween,
  cycleWindow,
  isSplittable,
  planInstalments,
} from "../common/utils/pricing.utils";
import { InvoiceConfig } from "./invoice.config";
import { GstConfigService, GstRegistration } from "./gst.config";
import {
  DocumentKind,
  InvoiceData,
  InvoiceFact,
  InvoiceGstBlock,
  InvoiceLineItem,
  InvoiceScheduleRow,
  InvoiceTotalLine,
} from "./invoice.types";
import {
  amountInWords,
  formatAmount,
  formatDate,
  formatMonthRange,
  formatShortDate,
} from "./utils/format.util";

/**
 * Statuses that belong on a *proforma*. A `void` instalment was superseded before
 * anyone paid it and a `refunded` one has been unwound; showing either as payable
 * would overstate what the family owes.
 *
 * Issued tax invoices are unaffected by this — they are rendered from their own
 * frozen snapshot, so an instalment changing status afterwards cannot reach them.
 */
export const INVOICEABLE_STATUSES = [INSTALMENT_PENDING, INSTALMENT_PAID];

const DEFAULT_TERMS = [
  "Payment is due by the date shown above. Placement begins only once the first instalment is received.",
  "Fees are payable in instalments as set out in the Service & Payment Policy.",
  "The matching fee is non-refundable once a shadow teacher has been assigned.",
  "Families are requested not to engage an assigned shadow teacher directly or outside Keel.",
  "Please quote the invoice number as the payment reference.",
];

const PROFORMA_NOTICE =
  "This is a proforma invoice, issued for information only. It is not a tax " +
  "invoice and not a demand for payment. A tax invoice is issued for each " +
  "instalment once payment is received.";

/** One item row, in the numbers the ledger stores rather than the strings it prints. */
export interface PersistableLine {
  seq: number;
  name: string;
  description: string;
  qty: number;
  unitAmount: number;
  subtotalAmount: number;
  gstPercent: number;
  gstAmount: number;
  amount: number;
  sessionsCovered: number | null;
  sacCode: string | null;
}

/** Everything the issuing service needs to write an `invoices` row. */
export interface IssuableInvoice {
  data: InvoiceData;
  lines: PersistableLine[];
  bookingId: string;
  planId: string | null;
  parentId: string | null;
  priceSnapshotId: string | null;
  cycleNumber: number | null;
  periodFrom: Date | null;
  periodTo: Date | null;
  subtotalAmount: number;
  gstAmount: number;
  totalAmount: number;
}

type LoadedBooking = Awaited<ReturnType<InvoiceDataBuilder["load"]>>;
type LoadedInstallment = LoadedBooking["payment_installments"][number];
type LoadedRequest =
  | LoadedBooking["service_requests"]
  | LoadedBooking["recurring_service_requests"];

/**
 * How a booking's cycles map onto the calendar.
 *
 * Resolved once and passed around, because the answer differs between a plan
 * (natural months anchored on the plan's start date, several sessions each) and a
 * standalone booking (one session, one window). Every period and session count on
 * every document goes through this, so the two can never drift apart.
 */
interface ScheduleContext {
  isPlan: boolean;
  /** Anchor for `cycleWindow` — the plan's start date, or the booking's. */
  anchor: Date;
  months: number;
  recurrenceType: string;
  recurrencePattern: unknown;
  hoursPerDay: number | null;
  daysPerWeek: number | null;
}

/**
 * Turns billing rows into render-ready document data.
 *
 * Three documents come out of here and they answer three different questions.
 * A **tax invoice** says what one captured payment bought — it is built once, at
 * capture, and then frozen into `invoices.snapshot`. A **proforma** says what the
 * whole engagement will cost and when each instalment falls due; it is rebuilt on
 * every read and is explicitly not a tax document. A **settlement statement**
 * (see `SettlementBuilder`) says what a cancelling family keeps.
 *
 * Money is read straight off the frozen installment/snapshot columns and never
 * recomputed here. Those columns exist precisely so a later rate change, GST flip
 * or rounding fix cannot re-state a document a family already holds.
 */
@Injectable()
export class InvoiceDataBuilder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: InvoiceConfig,
    private readonly gst: GstConfigService,
  ) {}

  // ── Tax invoice ────────────────────────────────────────────────────────────

  /**
   * The document for one captured instalment.
   *
   * Deliberately narrow: one payment, one invoice. The booking used to be the
   * unit, which read well until a plan's second cycle opened and the "same"
   * invoice quietly grew. Anchoring on the payment is the only unit that cannot
   * change after the fact, and it is also what GST wants — the tax point for an
   * advance is when the money arrives.
   */
  async buildForInstallment(
    installmentId: string,
    invoiceNumber: string,
    issuedAt: Date,
    registration: GstRegistration,
  ): Promise<IssuableInvoice> {
    const installment = await this.prisma.payment_installments.findUnique({
      where: { id: installmentId },
      select: { booking_id: true },
    });
    if (!installment) {
      throw new NotFoundException(`Instalment ${installmentId} not found`);
    }

    const booking = await this.load(installment.booking_id);
    const row = booking.payment_installments.find((i) => i.id === installmentId);
    if (!row) {
      throw new NotFoundException(
        `Instalment ${installmentId} is not billable on its booking`,
      );
    }

    const request = booking.service_requests ?? booking.recurring_service_requests;
    const schedule = this.scheduleContext(booking, request);
    const cycle = this.cycleFacts(booking, schedule, row);

    const gstPercent = this.gstPercentOf(row);
    const item = this.buildItem({
      installment: row,
      schedule,
      cycle,
      siblings: this.cycleSiblings(booking, row),
      registration,
    });

    const subtotal = round(Number(row.subtotal_amount));
    const gstAmount = round(Number(row.gst_amount));
    const total = round(Number(row.amount));

    const data: InvoiceData = {
      documentTitle: registration.enabled ? "Tax Invoice" : "Invoice",
      documentKind: "tax_invoice",
      invoiceNumber,
      // Issued at capture, so it is a receipt from the moment it exists.
      paid: true,
      isProforma: false,
      billedTo: this.billedTo(booking, registration),
      facts: [
        { label: "Invoice date", value: formatDate(issuedAt) },
        { label: "Paid on", value: formatDate(row.paid_at ?? issuedAt) },
        ...(cycle.periodLabel
          ? [{ label: "Billing period", value: cycle.periodLabel }]
          : []),
        { label: "Amount paid", value: `₹ ${formatAmount(total)}` },
      ],
      ...this.engagementSection(booking),
      items: [item],
      totals: this.buildTotals({
        subtotal,
        gstByRate: new Map([[gstPercent, gstAmount]]),
        registration,
        paidToDate: 0,
        paid: true,
      }),
      grandTotal: { label: "Total paid", amount: formatAmount(total) },
      amountInWords: amountInWords(total),
      company: this.config.company,
      gst: this.gstBlock(registration),
      hasSchedule: false,
      payment: this.config.paymentDetails(invoiceNumber),
      terms: DEFAULT_TERMS,
    };

    return {
      data,
      lines: [
        {
          seq: 1,
          name: item.name,
          description: item.description,
          qty: 1,
          unitAmount: subtotal,
          subtotalAmount: subtotal,
          gstPercent,
          gstAmount,
          amount: total,
          sessionsCovered: item.sessionsCovered,
          sacCode: registration.enabled ? registration.defaultSacCode : null,
        },
      ],
      bookingId: booking.id,
      planId: booking.recurring_request_id ?? null,
      parentId: booking.parent_id ?? null,
      priceSnapshotId: row.price_snapshot_id,
      cycleNumber: row.cycle_number,
      periodFrom: cycle.from,
      periodTo: cycle.to,
      subtotalAmount: subtotal,
      gstAmount,
      totalAmount: total,
    };
  }

  // ── Proforma ───────────────────────────────────────────────────────────────

  /**
   * What the engagement costs, end to end, whether or not it has been billed yet.
   *
   * This is the document a family needs *before* paying — to file a claim, or to
   * hand to whoever actually transfers the money — and the one that answers "what
   * am I signing up for" on a six-month plan. Cycles the billing cron has not
   * reached yet are projected from the last price actually snapshotted, and
   * labelled as scheduled rather than owed.
   */
  async buildProforma(bookingId: string): Promise<InvoiceData> {
    const registration = await this.gst.getRegistration();
    const booking = await this.load(bookingId);
    const request = booking.service_requests ?? booking.recurring_service_requests;
    const schedule = this.scheduleContext(booking, request);

    const installments = this.ordered(
      booking.payment_installments.filter((i) =>
        INVOICEABLE_STATUSES.includes(i.status),
      ),
    );

    const items: InvoiceLineItem[] = installments.map((installment) =>
      this.buildItem({
        installment,
        schedule,
        cycle: this.cycleFacts(booking, schedule, installment),
        siblings: this.cycleSiblings(booking, installment),
        registration,
      }),
    );

    const billedSubtotal = sum(installments.map((i) => Number(i.subtotal_amount)));
    const billedGst = sum(installments.map((i) => Number(i.gst_amount)));
    const billedTotal = sum(installments.map((i) => Number(i.amount)));
    const paidToDate = sum(
      installments
        .filter((i) => i.status === INSTALMENT_PAID)
        .map((i) => Number(i.amount)),
    );

    const projected = this.projectRemainingCycles(booking, schedule, installments);
    const contracted = round(billedTotal + sum(projected.map((p) => p.amount)));
    const outstanding = round(billedTotal - paidToDate);
    const paid = installments.length > 0 && outstanding === 0 && projected.length === 0;

    const scheduleRows = this.scheduleRows(
      booking,
      schedule,
      installments,
      projected,
    );

    const gstByRate = this.gstByRate(installments);

    return {
      documentTitle: "Proforma Invoice",
      documentKind: "proforma",
      invoiceNumber: `PF-${booking.id.slice(0, 8).toUpperCase()}`,
      paid,
      isProforma: true,
      notice: PROFORMA_NOTICE,
      billedTo: this.billedTo(booking, registration),
      facts: this.proformaFacts({
        booking,
        schedule,
        installments,
        contracted,
        outstanding,
      }),
      ...this.engagementSection(booking),
      items,
      totals: this.buildTotals({
        subtotal: billedSubtotal,
        gstByRate,
        registration,
        paidToDate,
        paid,
      }),
      grandTotal: paid
        ? { label: "Total paid", amount: formatAmount(billedTotal) }
        : { label: "Balance due", amount: formatAmount(outstanding) },
      amountInWords: amountInWords(paid ? billedTotal : outstanding),
      company: this.config.company,
      gst: this.gstBlock(registration),
      schedule: scheduleRows,
      hasSchedule: scheduleRows.length > 0,
      payment: this.config.paymentDetails(
        `Booking ${booking.id.slice(0, 8).toUpperCase()}`,
      ),
      terms: DEFAULT_TERMS,
      // GST totals are informational on a proforma; the sum above already carries
      // the billed portion, and projected cycles are quoted tax-inclusive.
    };
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  /**
   * One query, because every section of a document needs a different corner of
   * the booking graph and a document assembled from six round trips could observe
   * a mid-flight status change halfway down the page.
   *
   * Note this loads *every* instalment, not only the invoiceable ones: a tax
   * invoice has to know a voided sibling existed in order to work out what share
   * of a cycle its own money represents.
   */
  private async load(bookingId: string) {
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      include: {
        payment_installments: { include: { price_snapshots: true } },
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
   * Reading order: the matching fee is what the family paid first and is the one
   * deducted from the plan, so it heads the list; the rest run as they were billed.
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

  // ── Schedule ───────────────────────────────────────────────────────────────

  /**
   * Where cycles fall on the calendar, for this booking.
   *
   * The old builder walked flat 28-day blocks from `booking.start_time` while
   * billing and entitlement used natural months anchored on `plan.start_date`.
   * A plan starting 4 September was therefore billed for 4 Sep – 3 Oct and told
   * its invoice said 4 Sep – 1 Oct, and the gap widened every cycle. There is now
   * one definition, imported from the pricing utils that billing itself uses.
   */
  private scheduleContext(
    booking: LoadedBooking,
    request: LoadedRequest,
  ): ScheduleContext {
    const plan = booking.recurring_service_requests;
    const hoursPerDay = toNumber(booking.hours_per_day ?? request?.duration_hours);
    const daysPerWeek = booking.days_per_week ?? request?.days_per_week ?? null;

    if (plan) {
      return {
        isPlan: true,
        anchor: new Date(plan.start_date),
        months: Math.max(
          1,
          Number(plan.plan_duration_months ?? booking.plan_duration_months ?? 1),
        ),
        recurrenceType: plan.recurrence_type,
        recurrencePattern: plan.recurrence_pattern,
        hoursPerDay,
        daysPerWeek,
      };
    }

    return {
      isPlan: false,
      anchor: new Date(booking.start_time ?? booking.created_at ?? new Date()),
      months: Math.max(1, Number(booking.plan_duration_months ?? 1)),
      recurrenceType: "",
      recurrencePattern: null,
      hoursPerDay,
      daysPerWeek,
    };
  }

  /** How many scheduled sessions fall inside one cycle. A lone booking is one. */
  private sessionsInCycle(schedule: ScheduleContext, cycleNumber: number): number {
    if (!schedule.isPlan) return 1;
    const { start, end } = cycleWindow(schedule.anchor, Math.max(1, cycleNumber));
    return countSessionsBetween(
      start,
      end,
      schedule.recurrenceType,
      schedule.recurrencePattern,
    );
  }

  /** The dates and label for the cycle an instalment belongs to. */
  private cycleFacts(
    booking: LoadedBooking,
    schedule: ScheduleContext,
    installment: LoadedInstallment,
  ): { from: Date | null; to: Date | null; periodLabel: string | null } {
    if (installment.kind === MATCHING_FEE_KIND) {
      return { from: null, to: null, periodLabel: null };
    }

    const cycleNumber = Math.max(1, installment.cycle_number ?? 1);
    const { start, end } = cycleWindow(schedule.anchor, cycleNumber);
    // `cycleWindow` is half-open; the last day a family is served is the day
    // before it closes, and printing the exclusive bound reads as an extra day.
    const inclusiveEnd = new Date(end.getTime() - DAY_MS);

    if (!schedule.isPlan) {
      const from = booking.start_time ?? start;
      const to = booking.end_time ?? booking.start_time ?? inclusiveEnd;
      return { from, to, periodLabel: formatDate(from) };
    }

    return {
      from: start,
      to: inclusiveEnd,
      periodLabel: `${formatShortDate(start)} – ${formatDate(inclusiveEnd)}`,
    };
  }

  /** Every instalment billed against the same price snapshot, in billing order. */
  private cycleSiblings(
    booking: LoadedBooking,
    installment: LoadedInstallment,
  ): LoadedInstallment[] {
    return booking.payment_installments
      .filter((i) => i.price_snapshot_id === installment.price_snapshot_id)
      .sort((a, b) => a.installment_no - b.installment_no);
  }

  // ── Sections ───────────────────────────────────────────────────────────────

  /** One instalment, as one row of the items table. */
  private buildItem(input: {
    installment: LoadedInstallment;
    schedule: ScheduleContext;
    cycle: { from: Date | null; to: Date | null; periodLabel: string | null };
    siblings: LoadedInstallment[];
    registration: GstRegistration;
  }): InvoiceLineItem & { sessionsCovered: number | null } {
    const { installment, schedule, cycle, siblings, registration } = input;
    // Line items carry the pre-tax figure; GST is its own totals row, so a parent
    // comparing the invoice against their bank statement can see where the
    // difference came from.
    const value = formatAmount(Number(installment.subtotal_amount));
    const sac = registration.enabled ? registration.defaultSacCode : undefined;

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
        sac,
        sessionsCovered: null,
      };
    }

    const cycleNumber = Math.max(1, installment.cycle_number ?? 1);
    const sessionsInCycle = this.sessionsInCycle(schedule, cycleNumber);
    const sessionsCovered = this.sessionsFor(installment, siblings, sessionsInCycle);

    const scheduleText =
      schedule.hoursPerDay && schedule.daysPerWeek
        ? `In-school support, ${schedule.daysPerWeek} ${plural(schedule.daysPerWeek, "day")} per week, ${trimNumber(schedule.hoursPerDay)} ${plural(schedule.hoursPerDay, "hour")} per day.`
        : "In-school support.";
    const periodText = cycle.periodLabel ? ` Period: ${cycle.periodLabel}.` : "";

    // The sentence the whole redesign exists for. A 50% advance on a
    // twenty-session month buys ten sessions, and a parent should be able to read
    // that off the document rather than reverse-engineer it from a percentage.
    const coverageText =
      schedule.isPlan && sessionsInCycle > 0
        ? ` Covers ${sessionsCovered} of ${sessionsInCycle} scheduled ${plural(sessionsInCycle, "session")} in this cycle.`
        : "";

    return {
      name:
        installment.total_installments > 1
          ? `Shadow teacher support — Instalment ${installment.installment_no} of ${installment.total_installments}`
          : "Shadow teacher support",
      description: `${scheduleText}${periodText}${coverageText}`.trim(),
      qty: "1",
      rate: value,
      amount: value,
      sac,
      sessionsCovered: schedule.isPlan ? sessionsCovered : null,
    };
  }

  private buildTotals(input: {
    subtotal: number;
    gstByRate: Map<number, number>;
    registration: GstRegistration;
    paidToDate: number;
    paid: boolean;
  }): InvoiceTotalLine[] {
    const { subtotal, gstByRate, registration, paidToDate, paid } = input;

    const totals: InvoiceTotalLine[] = [
      { label: "Subtotal", amount: formatAmount(subtotal) },
    ];

    // GST is grouped by the rate that was actually charged: instalments billed
    // either side of a rate change must not be silently merged into one line at
    // a percentage neither of them used. Each rate then splits into CGST + SGST
    // or a single IGST line, once registration is on.
    for (const [percent, amount] of gstByRate) {
      // A ₹0.00 tax line invites the question of whether it should have been
      // there, so a rate that raised nothing is omitted rather than shown.
      if (amount <= 0) continue;
      for (const line of this.gst.taxLines(registration, percent, amount)) {
        totals.push({ label: line.label, amount: formatAmount(line.amount) });
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

  private proformaFacts(input: {
    booking: LoadedBooking;
    schedule: ScheduleContext;
    installments: LoadedInstallment[];
    contracted: number;
    outstanding: number;
  }): InvoiceFact[] {
    const { booking, schedule, installments, contracted, outstanding } = input;

    const facts: InvoiceFact[] = [
      { label: "Issued", value: formatDate(new Date()) },
    ];

    const period = this.termPeriod(schedule);
    if (period) facts.push({ label: "Plan period", value: period });

    if (schedule.isPlan) {
      const sessions = this.sessionsInTerm(schedule);
      if (sessions > 0) {
        facts.push({ label: "Sessions in term", value: String(sessions) });
      }
    }

    // The soonest thing outstanding is what the parent has to act on. A balance
    // with no due date yet is waiting on its advance being paid, so it is payable
    // on receipt rather than late.
    const due = earliest(
      installments
        .filter((i) => i.status !== INSTALMENT_PAID)
        .map((i) => i.due_date),
    );
    if (outstanding > 0) {
      facts.push({
        label: "Next payment due",
        value: due ? formatDate(due) : "On receipt",
      });
    }

    facts.push({
      label: "Plan total",
      value: `₹ ${formatAmount(contracted)}`,
    });

    if (booking.invoice_number) {
      // A legacy number the family may already be quoting. Surfaced rather than
      // hidden, so support can join a bank reference to this engagement.
      facts.push({ label: "Reference", value: booking.invoice_number });
    }

    return facts;
  }

  private engagementSection(booking: LoadedBooking): {
    engagement: InvoiceFact[];
    hasEngagement: boolean;
  } {
    const facts: InvoiceFact[] = [];
    const child = booking.booking_children.map((bc) => bc.children)[0];

    if (child) {
      const school = this.schoolDetails(child.school_details);
      const name = `${child.first_name} ${child.last_name}`.trim();
      facts.push({
        label: "Student",
        value: school.grade ? `${name} · ${school.grade}` : name,
      });
      if (school.name) facts.push({ label: "School", value: school.name });
    }

    const caregiver = fullName(
      booking.users_bookings_nanny_idTousers?.profiles ?? null,
    );
    if (caregiver) facts.push({ label: "Shadow teacher", value: caregiver });

    return { engagement: facts, hasEngagement: facts.length > 0 };
  }

  private billedTo(booking: LoadedBooking, registration: GstRegistration) {
    const parent = booking.users_bookings_parent_idTousers;
    const parentProfile = parent?.profiles ?? null;
    const address =
      parent?.addresses?.[0]?.address ??
      parentProfile?.address ??
      parentProfile?.location_address ??
      null;

    const childNames = booking.booking_children
      .map((bc) => `${bc.children.first_name} ${bc.children.last_name}`.trim())
      .filter(Boolean);

    return {
      name: fullName(parentProfile) || parent?.email || "Parent / Guardian",
      lines: [
        childNames.length
          ? `Parent / Guardian of ${joinNames(childNames)}`
          : "Parent / Guardian",
        address,
        [parent?.email, parentProfile?.phone].filter(Boolean).join(" · "),
        // Place of supply belongs on the recipient block, and only means
        // something once we are actually registered.
        registration.enabled && registration.placeOfSupplyName
          ? `Place of supply: ${registration.placeOfSupplyName} (${registration.placeOfSupplyStateCode})`
          : null,
      ].filter((line): line is string => !!line && line.trim().length > 0),
    };
  }

  gstBlock(registration: GstRegistration): InvoiceGstBlock {
    return {
      registered: registration.enabled,
      gstin: registration.gstin,
      legalName: registration.legalName || this.config.company.name,
      placeOfSupply: registration.placeOfSupplyName
        ? `${registration.placeOfSupplyName} (${registration.placeOfSupplyStateCode})`
        : registration.placeOfSupplyStateCode,
      interState: this.gst.isInterState(registration),
      showSac: registration.enabled,
    };
  }

  // ── Projection ─────────────────────────────────────────────────────────────

  /**
   * Cycles the billing cron has not opened yet, priced off the last one it did.
   *
   * A plan is sold as a term but billed a month at a time, so on the day a parent
   * signs up only cycle 1 exists as rows. A proforma that showed only cycle 1
   * would be answering a question nobody asked. The estimate is honest about
   * being one: it uses the most recent snapshot's total, which is exactly right
   * under the default `locked` price mode and close enough to quote otherwise.
   */
  private projectRemainingCycles(
    booking: LoadedBooking,
    schedule: ScheduleContext,
    installments: LoadedInstallment[],
  ): Array<{ cycleNumber: number; installmentNo: number; totalInstallments: number; amount: number }> {
    if (!schedule.isPlan || schedule.months <= 1) return [];

    const billedCycles = new Set(
      installments
        .filter((i) => i.kind !== MATCHING_FEE_KIND)
        .map((i) => i.cycle_number),
    );

    const lastSnapshot = installments
      .filter((i) => i.kind !== MATCHING_FEE_KIND && i.price_snapshots)
      .sort((a, b) => (b.cycle_number ?? 0) - (a.cycle_number ?? 0))[0];
    if (!lastSnapshot?.price_snapshots) return [];

    const cycleTotal = round(Number(lastSnapshot.price_snapshots.final_amount));
    if (cycleTotal <= 0) return [];

    const planType = booking.recurring_service_requests?.plan_type ?? null;
    const splittable = isSplittable(planType, cycleTotal, true);

    const out: Array<{
      cycleNumber: number;
      installmentNo: number;
      totalInstallments: number;
      amount: number;
    }> = [];

    for (let cycle = 1; cycle <= schedule.months; cycle++) {
      if (billedCycles.has(cycle)) continue;
      const planned = planInstalments(cycleTotal, { splittable });
      planned.forEach((instalment, index) => {
        out.push({
          cycleNumber: cycle,
          installmentNo: index + 1,
          totalInstallments: planned.length,
          amount: round(instalment.amount),
        });
      });
    }

    return out;
  }

  /** The proforma's payment schedule: what is billed, then what is coming. */
  private scheduleRows(
    booking: LoadedBooking,
    schedule: ScheduleContext,
    installments: LoadedInstallment[],
    projected: ReturnType<InvoiceDataBuilder["projectRemainingCycles"]>,
  ): InvoiceScheduleRow[] {
    const rows: InvoiceScheduleRow[] = installments.map((installment) => {
      const cycle = this.cycleFacts(booking, schedule, installment);
      return {
        label:
          installment.kind === MATCHING_FEE_KIND
            ? "Matching & placement fee"
            : installment.total_installments > 1
              ? `Cycle ${installment.cycle_number} · Instalment ${installment.installment_no} of ${installment.total_installments}`
              : `Cycle ${installment.cycle_number}`,
        period: cycle.periodLabel ?? "—",
        due:
          installment.status === INSTALMENT_PAID
            ? formatDate(installment.paid_at)
            : installment.due_date
              ? formatDate(installment.due_date)
              : "On receipt",
        amount: formatAmount(Number(installment.amount)),
        status: installment.status === INSTALMENT_PAID ? "Paid" : "Due",
      };
    });

    for (const row of projected) {
      const { start, end } = cycleWindow(schedule.anchor, row.cycleNumber);
      rows.push({
        label:
          row.totalInstallments > 1
            ? `Cycle ${row.cycleNumber} · Instalment ${row.installmentNo} of ${row.totalInstallments}`
            : `Cycle ${row.cycleNumber}`,
        period: `${formatShortDate(start)} – ${formatDate(new Date(end.getTime() - DAY_MS))}`,
        due: "—",
        amount: formatAmount(row.amount),
        // Not "Due": nothing is owed until the cycle is actually opened, and a
        // parent must never be chased for a row that is only a forecast.
        status: "Scheduled",
      });
    }

    return rows;
  }

  // ── Derivations ────────────────────────────────────────────────────────────

  /**
   * How many of a cycle's sessions one instalment's money bought.
   *
   * Allocated cumulatively rather than by rounding each share independently: two
   * halves of a twenty-one-session month each round to eleven, which would
   * promise twenty-two sessions for twenty-one sessions' money. Taking the
   * running floor makes the parts sum to the whole by construction, and hands the
   * odd session to whoever pays last.
   */
  private sessionsFor(
    installment: LoadedInstallment,
    siblings: LoadedInstallment[],
    sessionsInCycle: number,
  ): number {
    if (sessionsInCycle <= 0) return 0;

    const amounts = siblings.map((i) => Number(i.amount));
    const total = amounts.reduce((a, b) => a + b, 0);
    if (total <= 0) return 0;

    let cumulativeAmount = 0;
    let allocated = 0;
    for (const sibling of siblings) {
      cumulativeAmount += Number(sibling.amount);
      const upTo = Math.floor(
        (cumulativeAmount / total) * sessionsInCycle + 1e-9,
      );
      const share = upTo - allocated;
      allocated = upTo;
      if (sibling.id === installment.id) return share;
    }
    return 0;
  }

  /** Total GST per rate, in the order the rates first appear on the document. */
  private gstByRate(installments: LoadedInstallment[]): Map<number, number> {
    const byRate = new Map<number, number>();
    for (const installment of installments) {
      const percent = this.gstPercentOf(installment);
      byRate.set(
        percent,
        round((byRate.get(percent) ?? 0) + Number(installment.gst_amount)),
      );
    }
    return byRate;
  }

  private gstPercentOf(installment: LoadedInstallment): number {
    return Number(installment.price_snapshots?.gst_percent_used ?? 0);
  }

  /** The months a plan spans, for the header fact. */
  private termPeriod(schedule: ScheduleContext): string | null {
    const start = schedule.anchor;
    if (!start || Number.isNaN(start.getTime())) return null;

    const { end } = cycleWindow(start, schedule.months);
    return formatMonthRange(start, new Date(end.getTime() - DAY_MS));
  }

  private sessionsInTerm(schedule: ScheduleContext): number {
    let total = 0;
    for (let cycle = 1; cycle <= schedule.months; cycle++) {
      total += this.sessionsInCycle(schedule, cycle);
    }
    return total;
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
}

// ── Shared helpers ───────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/**
 * Rounded back to paise: the columns are Decimal(12,2), but summing them as
 * floats can leave a 0.000000001 tail that formats as a rupee out.
 */
function round(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

function sum(values: number[]): number {
  return round(values.reduce((a, b) => a + b, 0));
}

function earliest(dates: Array<Date | null>): Date | null {
  const known = dates.filter((d): d is Date => !!d);
  return known.length
    ? new Date(Math.min(...known.map((d) => d.getTime())))
    : null;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** `4.00` → `4`, `18.50` → `18.5` — trailing zeros read as false precision. */
function trimNumber(value: number): string {
  return String(Number(value));
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

export function fullName(
  profile: { first_name?: string | null; last_name?: string | null } | null,
): string {
  return [profile?.first_name, profile?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
}

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
