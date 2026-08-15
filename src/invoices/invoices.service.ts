import { Injectable, NotFoundException } from "@nestjs/common";
import { readFile } from "fs/promises";
import { join } from "path";
import { PrismaService } from "../prisma/prisma.service";
import { UserRole } from "../auth/dto/signup.dto";
import { INSTALMENT_PAID } from "../constants";
import {
  INVOICEABLE_STATUSES,
  InvoiceDataBuilder,
} from "./invoice-data.builder";
import { PdfService } from "./pdf.service";
import { InvoiceData, SettlementData } from "./invoice.types";
import { renderTemplate } from "./utils/template.util";
import { formatAmount, formatDate } from "./utils/format.util";

/** Which template renders a given document. */
type TemplateName = "invoice" | "settlement";

/** The kinds of document a parent can be handed. */
export type ParentDocumentKind =
  | "proforma"
  | "tax_invoice"
  | "credit_note"
  | "settlement";

/**
 * A row in the parent's document list.
 *
 * Deliberately uniform across kinds: the app renders one list, and a family does
 * not think in terms of which table a document came out of.
 */
export interface ParentDocument {
  kind: ParentDocumentKind;
  /** Stable handle for fetching this document — an id, or a booking/plan id. */
  id: string;
  bookingId: string | null;
  planId: string | null;
  number: string | null;
  title: string;
  subtitle: string;
  issuedAt: Date | null;
  issuedAtFormatted: string;
  amount: number;
  amountFormatted: string;
  /** True for money the parent received back or no longer owes. */
  negative: boolean;
  /** The path the app should hit to download the PDF. */
  downloadPath: string;
}

/** The running account for one plan, or one standalone booking. */
export interface PlanStatement {
  planId: string | null;
  bookingId: string;
  title: string;
  /** Everything the term will cost, projected cycles included. */
  contracted: number;
  contractedFormatted: string;
  billed: number;
  billedFormatted: string;
  paid: number;
  paidFormatted: string;
  credited: number;
  creditedFormatted: string;
  outstanding: number;
  outstandingFormatted: string;
  nextDueDate: Date | null;
  nextDueDateFormatted: string | null;
  sessionsInTerm: number | null;
  documents: ParentDocument[];
}

@Injectable()
export class InvoicesService {
  /** Read once at startup; templates are deploy artifacts, not live content. */
  private readonly templates = new Map<TemplateName, Promise<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly builder: InvoiceDataBuilder,
    private readonly pdf: PdfService,
  ) {}

  // ── Listing ────────────────────────────────────────────────────────────────

  /**
   * Every document the parent holds, newest first.
   *
   * Covers issued tax invoices, credit notes and settlement statements, plus a
   * proforma for any booking that is billable but has nothing captured yet —
   * because the design is also a bill, and a family often needs it *before*
   * paying, to file a claim or to hand to whoever transfers the money.
   */
  async listForParent(parentId: string): Promise<ParentDocument[]> {
    const [invoices, creditNotes, settlements, unpaidBookings] =
      await Promise.all([
        this.prisma.invoices.findMany({
          where: { parent_id: parentId },
          orderBy: [{ issued_at: "desc" }],
          take: 200,
          select: {
            id: true,
            number: true,
            kind: true,
            booking_id: true,
            plan_id: true,
            cycle_number: true,
            issued_at: true,
            total_amount: true,
            gst_registered: true,
          },
        }),
        this.prisma.credit_notes.findMany({
          where: { parent_id: parentId },
          orderBy: [{ issued_at: "desc" }],
          take: 100,
          select: {
            id: true,
            number: true,
            booking_id: true,
            reason: true,
            issued_at: true,
            total_amount: true,
          },
        }),
        this.prisma.plan_settlements.findMany({
          where: { parent_id: parentId },
          orderBy: [{ cancelled_at: "desc" }],
          take: 50,
          select: {
            id: true,
            number: true,
            plan_id: true,
            cancelled_at: true,
            sessions_retained: true,
          },
        }),
        // Bookings with something billable and nothing invoiced yet. These have
        // no document of their own, so the proforma stands in for one.
        this.prisma.bookings.findMany({
          where: {
            parent_id: parentId,
            payment_installments: {
              some: { status: { in: INVOICEABLE_STATUSES } },
            },
            invoices: { none: { kind: "tax_invoice" } },
          },
          orderBy: [{ created_at: "desc" }],
          take: 50,
          select: {
            id: true,
            created_at: true,
            recurring_request_id: true,
            payment_installments: {
              where: { status: { in: INVOICEABLE_STATUSES } },
              select: { amount: true, status: true },
            },
          },
        }),
      ]);

    const rows: ParentDocument[] = [
      ...invoices.map((invoice) => ({
        kind: "tax_invoice" as const,
        id: invoice.id,
        bookingId: invoice.booking_id,
        planId: invoice.plan_id,
        number: invoice.number,
        title: invoice.gst_registered ? "Tax invoice" : "Invoice",
        // A one-cycle engagement has no "cycle 1" worth naming — that is just
        // the booking. Numbering only earns its place on a plan.
        subtitle:
          invoice.plan_id && invoice.cycle_number != null && invoice.cycle_number > 0
            ? `Cycle ${invoice.cycle_number}`
            : "Shadow teacher support",
        issuedAt: invoice.issued_at,
        issuedAtFormatted: formatDate(invoice.issued_at),
        amount: Number(invoice.total_amount),
        amountFormatted: `₹ ${formatAmount(Number(invoice.total_amount))}`,
        negative: false,
        downloadPath: `/invoices/${invoice.id}/pdf`,
      })),
      ...creditNotes.map((note) => ({
        kind: "credit_note" as const,
        id: note.id,
        bookingId: note.booking_id,
        planId: null,
        number: note.number,
        title: "Credit note",
        subtitle: CREDIT_NOTE_SUBTITLE[note.reason] ?? "Adjustment",
        issuedAt: note.issued_at,
        issuedAtFormatted: formatDate(note.issued_at),
        amount: Number(note.total_amount),
        amountFormatted: `– ₹ ${formatAmount(Number(note.total_amount))}`,
        negative: true,
        downloadPath: `/invoices/credit-notes/${note.id}/pdf`,
      })),
      ...settlements.map((settlement) => ({
        kind: "settlement" as const,
        id: settlement.id,
        bookingId: null,
        planId: settlement.plan_id,
        number: settlement.number,
        title: "Cancellation statement",
        subtitle: `${settlement.sessions_retained} ${settlement.sessions_retained === 1 ? "session" : "sessions"} retained`,
        issuedAt: settlement.cancelled_at,
        issuedAtFormatted: formatDate(settlement.cancelled_at),
        amount: 0,
        amountFormatted: "—",
        negative: false,
        downloadPath: `/invoices/plan/${settlement.plan_id}/settlement/pdf`,
      })),
      ...unpaidBookings.map((booking) => {
        const total = sum(
          booking.payment_installments.map((i) => Number(i.amount)),
        );
        return {
          kind: "proforma" as const,
          id: booking.id,
          bookingId: booking.id,
          planId: booking.recurring_request_id,
          number: null,
          title: "Proforma invoice",
          subtitle: "Not a tax invoice — issued for information",
          issuedAt: booking.created_at,
          issuedAtFormatted: formatDate(booking.created_at),
          amount: total,
          amountFormatted: `₹ ${formatAmount(total)}`,
          negative: false,
          downloadPath: `/invoices/booking/${booking.id}/proforma/pdf`,
        };
      }),
    ];

    return rows.sort(
      (a, b) => (b.issuedAt?.getTime() ?? 0) - (a.issuedAt?.getTime() ?? 0),
    );
  }

  // ── Single documents ───────────────────────────────────────────────────────

  /** An issued invoice, rendered from its own frozen snapshot. */
  async getInvoice(invoiceId: string, user: RequestUser): Promise<InvoiceData> {
    const invoice = await this.prisma.invoices.findUnique({
      where: { id: invoiceId },
      select: {
        parent_id: true,
        booking_id: true,
        number: true,
        issued_at: true,
        snapshot: true,
      },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    this.assertOwns(invoice.parent_id, user);

    const snapshot = invoice.snapshot as unknown as InvoiceData | null;
    // A `legacy` row carries no snapshot — it was minted under the old
    // render-on-download scheme, which never froze anything. There is no honest
    // historical content to serve, so it is re-derived from the booking exactly
    // as it always was, under the number the family already has.
    if (!snapshot || !snapshot.invoiceNumber) {
      const proforma = await this.builder.buildProforma(invoice.booking_id);
      return {
        ...proforma,
        documentTitle: "Invoice",
        documentKind: "legacy",
        invoiceNumber: invoice.number,
        isProforma: false,
        notice:
          "This invoice was issued before invoices were archived, so it is " +
          "reproduced from current booking records.",
      };
    }
    return snapshot;
  }

  async getInvoicePdf(invoiceId: string, user: RequestUser) {
    const data = await this.getInvoice(invoiceId, user);
    return this.render("invoice", data, `Invoice-${data.invoiceNumber}.pdf`);
  }

  /** A credit note, rendered from its own frozen snapshot. */
  async getCreditNote(
    creditNoteId: string,
    user: RequestUser,
  ): Promise<InvoiceData> {
    const note = await this.prisma.credit_notes.findUnique({
      where: { id: creditNoteId },
      select: { parent_id: true, snapshot: true },
    });
    if (!note) throw new NotFoundException("Credit note not found");
    this.assertOwns(note.parent_id, user);
    return note.snapshot as unknown as InvoiceData;
  }

  async getCreditNotePdf(creditNoteId: string, user: RequestUser) {
    const data = await this.getCreditNote(creditNoteId, user);
    return this.render("invoice", data, `CreditNote-${data.invoiceNumber}.pdf`);
  }

  /**
   * The proforma for a booking — the whole engagement, billed or not.
   *
   * Rebuilt on every read, unlike everything else here. That is correct for what
   * it is: not a record of a transaction but a statement of what the term will
   * cost, which legitimately changes as cycles open and payments land.
   */
  async getProforma(
    bookingId: string,
    user: RequestUser,
  ): Promise<InvoiceData> {
    await this.assertCanAccessBooking(bookingId, user);
    return this.builder.buildProforma(bookingId);
  }

  async getProformaPdf(bookingId: string, user: RequestUser) {
    const data = await this.getProforma(bookingId, user);
    return this.render(
      "invoice",
      data,
      `Proforma-${bookingId.slice(0, 8).toUpperCase()}.pdf`,
    );
  }

  /** The settlement statement for a cancelled plan. */
  async getSettlement(
    planId: string,
    user: RequestUser,
  ): Promise<SettlementData> {
    const settlement = await this.prisma.plan_settlements.findUnique({
      where: { plan_id: planId },
      select: { parent_id: true, snapshot: true },
    });
    if (!settlement) {
      throw new NotFoundException("No settlement statement for this plan");
    }
    this.assertOwns(settlement.parent_id, user);
    return settlement.snapshot as unknown as SettlementData;
  }

  async getSettlementPdf(planId: string, user: RequestUser) {
    const data = await this.getSettlement(planId, user);
    return this.render(
      "settlement",
      data as unknown as Record<string, unknown>,
      `Settlement-${data.settlementNumber}.pdf`,
      data.settlementNumber,
    );
  }

  // ── Statement ──────────────────────────────────────────────────────────────

  /**
   * The running account for a booking and, if it belongs to one, its whole plan.
   *
   * The surface the app leads with. A family with a six-month plan holds a dozen
   * documents by the end of it, and the question they actually have — what have I
   * paid, what is left, what is next — is not answerable by reading any one of
   * them.
   */
  async statementForBooking(
    bookingId: string,
    user: RequestUser,
  ): Promise<PlanStatement> {
    await this.assertCanAccessBooking(bookingId, user);

    const booking = await this.prisma.bookings.findUniqueOrThrow({
      where: { id: bookingId },
      select: { id: true, recurring_request_id: true, parent_id: true },
    });

    const planId = booking.recurring_request_id;
    const bookingScope = planId
      ? { bookings: { recurring_request_id: planId } }
      : { booking_id: bookingId };

    const [proforma, installments, invoices] = await Promise.all([
      this.builder.buildProforma(bookingId),
      this.prisma.payment_installments.findMany({
        where: { ...bookingScope, status: { in: INVOICEABLE_STATUSES } },
        select: { amount: true, status: true, due_date: true },
      }),
      this.prisma.invoices.findMany({
        where: planId ? { plan_id: planId } : { booking_id: bookingId },
        select: { credited_amount: true },
      }),
    ]);

    const billed = sum(installments.map((i) => Number(i.amount)));
    const paid = sum(
      installments
        .filter((i) => i.status === INSTALMENT_PAID)
        .map((i) => Number(i.amount)),
    );
    const creditedTotal = sum(invoices.map((i) => Number(i.credited_amount)));
    const nextDue = earliest(
      installments
        .filter((i) => i.status !== INSTALMENT_PAID)
        .map((i) => i.due_date),
    );

    // The proforma already worked out the term total, projected cycles and all;
    // re-deriving it here would be a second answer to the same question. Falls
    // back to what has actually been billed when there is nothing to project.
    const planTotal = proforma.facts.find((f) => f.label === "Plan total");
    const contracted = planTotal ? parseAmount(planTotal.value) : billed;
    const documents = (
      await this.listForParent(booking.parent_id ?? user.id)
    ).filter((doc) =>
      planId ? doc.planId === planId : doc.bookingId === bookingId,
    );

    const sessionsFact = proforma.facts.find(
      (f) => f.label === "Sessions in term",
    );

    return {
      planId,
      bookingId,
      title: proforma.items[0]?.name ?? "Shadow teacher support",
      contracted: round(contracted),
      contractedFormatted: `₹ ${formatAmount(contracted)}`,
      billed,
      billedFormatted: `₹ ${formatAmount(billed)}`,
      paid,
      paidFormatted: `₹ ${formatAmount(paid)}`,
      credited: creditedTotal,
      creditedFormatted: `₹ ${formatAmount(creditedTotal)}`,
      outstanding: round(billed - paid),
      outstandingFormatted: `₹ ${formatAmount(billed - paid)}`,
      nextDueDate: nextDue,
      nextDueDateFormatted: nextDue ? formatDate(nextDue) : null,
      sessionsInTerm: sessionsFact ? Number(sessionsFact.value) : null,
      documents,
    };
  }

  // ── Access ─────────────────────────────────────────────────────────────────

  /**
   * A parent may only read their own documents; admins may read any, for support.
   *
   * Not a 403 on the miss: confirming the id exists would leak that another
   * family has a document with it.
   */
  private assertOwns(ownerId: string | null, user: RequestUser) {
    const isAdmin = user.role === UserRole.ADMIN;
    if (!isAdmin && ownerId !== user.id) {
      throw new NotFoundException("Document not found");
    }
  }

  /**
   * Checked with its own narrow query rather than trusting the builder's join:
   * authorisation that rides along on a data load is authorisation that quietly
   * disappears the day someone changes the `include`.
   */
  private async assertCanAccessBooking(bookingId: string, user: RequestUser) {
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      select: { parent_id: true },
    });
    if (!booking) throw new NotFoundException("Document not found");
    this.assertOwns(booking.parent_id, user);

    // Nothing billable — every instalment was voided or refunded — so there is no
    // document to issue rather than an empty one that looks payable.
    const billable = await this.prisma.payment_installments.findFirst({
      where: { booking_id: bookingId, status: { in: INVOICEABLE_STATUSES } },
      select: { id: true },
    });
    if (!billable) {
      throw new NotFoundException("No invoice is available for this booking");
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  private async render(
    template: TemplateName,
    data: unknown,
    filename: string,
    invoiceNumber?: string,
  ) {
    const html = renderTemplate(
      await this.loadTemplate(template),
      data as Record<string, unknown>,
    );
    const pdf = await this.pdf.render(html);
    return {
      pdf,
      filename,
      invoiceNumber:
        invoiceNumber ?? (data as InvoiceData).invoiceNumber ?? filename,
    };
  }

  private loadTemplate(name: TemplateName): Promise<string> {
    // `__dirname` rather than `process.cwd()`: it resolves the same whether the
    // app runs from src via ts-node or from dist, and does not depend on where
    // the process was started.
    let cached = this.templates.get(name);
    if (!cached) {
      cached = readFile(
        join(__dirname, "templates", `${name}.template.html`),
        "utf8",
      );
      this.templates.set(name, cached);
    }
    return cached;
  }
}

const CREDIT_NOTE_SUBTITLE: Record<string, string> = {
  refund: "Refund of fees",
  plan_cancelled: "Plan cancelled",
  written_off: "Written off",
  correction: "Billing correction",
};

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

/** `"₹ 1,20,000.00"` → `120000`. The formatter's own inverse. */
function parseAmount(formatted: string): number {
  const parsed = Number(formatted.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The shape `AuthGuard('jwt')` puts on the request. */
export interface RequestUser {
  id: string;
  role?: string;
}
