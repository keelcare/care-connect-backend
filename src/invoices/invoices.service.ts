import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { readFile } from "fs/promises";
import { join } from "path";
import { PrismaService } from "../prisma/prisma.service";
import { UserRole } from "../auth/dto/signup.dto";
import {
  INSTALMENT_PAID,
  INSTALMENT_PENDING,
  MATCHING_FEE_KIND,
} from "../constants";
import { InvoiceDataBuilder } from "./invoice-data.builder";
import { InvoiceNumberService } from "./invoice-number.service";
import { PdfService } from "./pdf.service";
import { InvoiceData } from "./invoice.types";
import { renderTemplate } from "./utils/template.util";
import { formatAmount, formatDate } from "./utils/format.util";

/**
 * Statuses an invoice can be issued for. A `void` instalment was superseded
 * before anyone paid it and a `refunded` one has been unwound — handing either
 * out as a document that looks payable would be worse than saying it is gone.
 */
const INVOICEABLE_STATUSES = [INSTALMENT_PENDING, INSTALMENT_PAID];

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
   * Every instalment the parent can download an invoice for, newest first.
   *
   * Deliberately covers unpaid instalments too: the design is a bill (it has a
   * due date and bank details), and a family often needs it *before* paying —
   * to file a claim, or to hand to whoever actually transfers the money.
   */
  async listForParent(parentId: string) {
    const rows = await this.prisma.payment_installments.findMany({
      where: {
        status: { in: INVOICEABLE_STATUSES },
        bookings: { parent_id: parentId },
      },
      orderBy: [{ created_at: "desc" }, { installment_no: "asc" }],
      take: 200,
      select: {
        id: true,
        booking_id: true,
        kind: true,
        amount: true,
        status: true,
        due_date: true,
        paid_at: true,
        cycle_number: true,
        installment_no: true,
        total_installments: true,
        invoice_number: true,
        invoice_issued_at: true,
      },
    });

    return rows.map((row) => ({
      installmentId: row.id,
      bookingId: row.booking_id,
      /** Null until the parent first downloads it — numbers are issued lazily. */
      invoiceNumber: row.invoice_number,
      issuedAt: row.invoice_issued_at,
      kind: row.kind,
      title:
        row.kind === MATCHING_FEE_KIND
          ? "Matching & placement fee"
          : row.total_installments > 1
            ? `Shadow teacher support — Instalment ${row.installment_no}`
            : "Shadow teacher support",
      amount: Number(row.amount),
      amountFormatted: `₹ ${formatAmount(Number(row.amount))}`,
      paid: row.status === INSTALMENT_PAID,
      dueDate: row.due_date,
      dueDateFormatted: row.due_date ? formatDate(row.due_date) : "On receipt",
      paidAt: row.paid_at,
      cycleNumber: row.cycle_number,
      installmentNo: row.installment_no,
      totalInstallments: row.total_installments,
    }));
  }

  /**
   * The invoice as structured data — what the app renders for an in-app preview,
   * and the same object the PDF is built from, so the two cannot disagree.
   */
  async getInvoiceData(
    installmentId: string,
    user: RequestUser,
  ): Promise<InvoiceData> {
    await this.assertCanAccess(installmentId, user);
    const { invoiceNumber, issuedAt } =
      await this.numbers.ensureFor(installmentId);
    return this.builder.build(installmentId, invoiceNumber, issuedAt);
  }

  /** The same invoice, rendered. `filename` is what the app should save it as. */
  async getInvoicePdf(
    installmentId: string,
    user: RequestUser,
  ): Promise<{ pdf: Buffer; filename: string; invoiceNumber: string }> {
    const data = await this.getInvoiceData(installmentId, user);
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
  private async assertCanAccess(installmentId: string, user: RequestUser) {
    const installment = await this.prisma.payment_installments.findUnique({
      where: { id: installmentId },
      select: { status: true, bookings: { select: { parent_id: true } } },
    });

    if (!installment) {
      throw new NotFoundException("Invoice not found");
    }

    const isAdmin = user.role === UserRole.ADMIN;
    if (!isAdmin && installment.bookings?.parent_id !== user.id) {
      // Not a 403: confirming the id exists would leak that another family has a
      // booking with it.
      throw new NotFoundException("Invoice not found");
    }

    if (!INVOICEABLE_STATUSES.includes(installment.status)) {
      throw new ForbiddenException(
        `No invoice is available for a ${installment.status} instalment`,
      );
    }
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
