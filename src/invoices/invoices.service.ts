import { Injectable, NotFoundException } from "@nestjs/common";
import { readFile } from "fs/promises";
import { join } from "path";
import { PrismaService } from "../prisma/prisma.service";
import { UserRole } from "../auth/dto/signup.dto";
import { INSTALMENT_PAID, MATCHING_FEE_KIND } from "../constants";
import {
  INVOICEABLE_STATUSES,
  InvoiceDataBuilder,
} from "./invoice-data.builder";
import { InvoiceNumberService } from "./invoice-number.service";
import { PdfService } from "./pdf.service";
import { InvoiceData } from "./invoice.types";
import { renderTemplate } from "./utils/template.util";
import { formatAmount, formatDate } from "./utils/format.util";

@Injectable()
export class InvoicesService {
  /** Read once at startup; the template is a deploy artifact, not live content. */
  private templatePromise: Promise<string> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly builder: InvoiceDataBuilder,
    private readonly numbers: InvoiceNumberService,
    private readonly pdf: PdfService,
  ) {}

  /**
   * Every booking the parent can download an invoice for, newest first — one
   * entry per booking, because one engagement is one document.
   *
   * Deliberately covers unpaid instalments too: the design is a bill (it has a
   * due date and bank details), and a family often needs it *before* paying —
   * to file a claim, or to hand to whoever actually transfers the money.
   */
  async listForParent(parentId: string) {
    const bookings = await this.prisma.bookings.findMany({
      where: {
        parent_id: parentId,
        payment_installments: {
          some: { status: { in: INVOICEABLE_STATUSES } },
        },
      },
      orderBy: [{ created_at: "desc" }],
      take: 200,
      select: {
        id: true,
        invoice_number: true,
        invoice_issued_at: true,
        payment_installments: {
          where: { status: { in: INVOICEABLE_STATUSES } },
          select: {
            id: true,
            kind: true,
            amount: true,
            status: true,
            due_date: true,
            paid_at: true,
            installment_no: true,
            total_installments: true,
          },
        },
      },
    });

    return bookings.map((booking) => {
      const installments = booking.payment_installments;
      const total = this.sum(installments.map((i) => Number(i.amount)));
      const outstanding = this.sum(
        installments
          .filter((i) => i.status !== INSTALMENT_PAID)
          .map((i) => Number(i.amount)),
      );
      const paid = outstanding === 0;
      const dueDate = this.earliest(
        installments
          .filter((i) => i.status !== INSTALMENT_PAID)
          .map((i) => i.due_date),
      );

      return {
        bookingId: booking.id,
        /** Null until the parent first downloads it — numbers are issued lazily. */
        invoiceNumber: booking.invoice_number,
        issuedAt: booking.invoice_issued_at,
        title: this.titleFor(installments),
        /** What the whole engagement came to, paid or not. */
        amount: total,
        amountFormatted: `₹ ${formatAmount(total)}`,
        /** What is still owed on it — zero once settled. */
        amountDue: outstanding,
        amountDueFormatted: `₹ ${formatAmount(outstanding)}`,
        paid,
        dueDate,
        dueDateFormatted: dueDate ? formatDate(dueDate) : "On receipt",
        paidAt: this.latest(installments.map((i) => i.paid_at)),
        /** How many fees the one invoice covers — for a "3 items" style hint. */
        itemCount: installments.length,
      };
    });
  }

  /**
   * The invoice as structured data — what the app renders for an in-app preview,
   * and the same object the PDF is built from, so the two cannot disagree.
   */
  async getInvoiceData(
    bookingId: string,
    user: RequestUser,
  ): Promise<InvoiceData> {
    await this.assertCanAccess(bookingId, user);
    const { invoiceNumber, issuedAt } =
      await this.numbers.ensureForBooking(bookingId);
    return this.builder.buildForBooking(bookingId, invoiceNumber, issuedAt);
  }

  /** The same invoice, rendered. `filename` is what the app should save it as. */
  async getInvoicePdf(
    bookingId: string,
    user: RequestUser,
  ): Promise<{ pdf: Buffer; filename: string; invoiceNumber: string }> {
    const data = await this.getInvoiceData(bookingId, user);
    const html = renderTemplate(
      await this.loadTemplate(),
      data as unknown as Record<string, unknown>,
    );
    const pdf = await this.pdf.render(html);

    return {
      pdf,
      filename: `Invoice-${data.invoiceNumber}.pdf`,
      invoiceNumber: data.invoiceNumber,
    };
  }

  // ── Access ─────────────────────────────────────────────────────────────────

  /**
   * A parent may only download invoices for their own bookings; admins may
   * download any, for support.
   *
   * Checked with its own narrow query rather than trusting the builder's join:
   * authorisation that rides along on a data load is authorisation that quietly
   * disappears the day someone changes the `include`.
   */
  private async assertCanAccess(bookingId: string, user: RequestUser) {
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      select: { parent_id: true },
    });

    if (!booking) {
      throw new NotFoundException("Invoice not found");
    }

    const isAdmin = user.role === UserRole.ADMIN;
    if (!isAdmin && booking.parent_id !== user.id) {
      // Not a 403: confirming the id exists would leak that another family has a
      // booking with it.
      throw new NotFoundException("Invoice not found");
    }

    // Nothing billable left — every instalment was voided or refunded — so there
    // is no document to issue rather than an empty one that looks payable.
    const billable = await this.prisma.payment_installments.findFirst({
      where: { booking_id: bookingId, status: { in: INVOICEABLE_STATUSES } },
      select: { id: true },
    });
    if (!billable) {
      throw new NotFoundException("No invoice is available for this booking");
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * What the single invoice is called in a list. It has to name everything on it,
   * since there is no longer a per-fee row to spell the rest out.
   */
  private titleFor(installments: Array<{ kind: string | null }>): string {
    const hasMatching = installments.some((i) => i.kind === MATCHING_FEE_KIND);
    const hasSupport = installments.some((i) => i.kind !== MATCHING_FEE_KIND);

    if (hasMatching && hasSupport) {
      return "Shadow teacher support & matching fee";
    }
    return hasMatching ? "Matching & placement fee" : "Shadow teacher support";
  }

  private sum(values: number[]): number {
    return Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;
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

  private loadTemplate(): Promise<string> {
    // `__dirname` rather than `process.cwd()`: it resolves the same whether the
    // app runs from src via ts-node or from dist, and does not depend on where
    // the process was started.
    this.templatePromise ??= readFile(
      join(__dirname, "templates", "invoice.template.html"),
      "utf8",
    );
    return this.templatePromise;
  }
}

/** The shape `AuthGuard('jwt')` puts on the request. */
export interface RequestUser {
  id: string;
  role?: string;
}
