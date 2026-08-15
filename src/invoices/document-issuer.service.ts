import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PlanEntitlement } from "../common/plan-entitlement.service";
import { InvoiceDataBuilder } from "./invoice-data.builder";
import { InvoiceNumberService } from "./invoice-number.service";
import { SettlementBuilder, SettlementInput } from "./settlement.builder";
import { GstConfigService } from "./gst.config";
import { InvoiceConfig } from "./invoice.config";
import { InvoiceData } from "./invoice.types";
import { amountInWords, formatAmount, formatDate } from "./utils/format.util";

/** Anything Prisma can write through — the client, or an interactive transaction. */
type Db = PrismaService | Prisma.TransactionClient;

/**
 * Stands in for the document number while the document is being assembled.
 *
 * A document is built before its number is allocated, so the expensive reads
 * happen outside the transaction that hands the number out. It is replaced
 * before anything is stored — nothing carrying this placeholder is ever written.
 */
const PENDING_NUMBER = "";

/** Why an invoice is being reduced. Printed on the note and stored for reporting. */
export type CreditNoteReason =
  | "refund"
  | "plan_cancelled"
  | "written_off"
  | "correction";

export type CreditNoteSettlement =
  | "refunded"
  | "retained_as_entitlement"
  | "written_off";

export interface IssueCreditNoteInput {
  invoiceId: string;
  reason: CreditNoteReason;
  settlement: CreditNoteSettlement;
  /** Rupees to credit. Defaults to whatever is left uncredited on the invoice. */
  amount?: number;
  note?: string;
  refundId?: string;
}

/**
 * Writes documents and freezes them.
 *
 * Every method here is the *only* way its document comes into existence, and each
 * one stores a complete rendered snapshot alongside the numbers. Rendering later
 * reads the snapshot, never the live tables — which is the whole reason the
 * previous design failed. An invoice built on demand from `payment_installments`
 * showed one total in September and another in November under the same number,
 * because a plan's cycles open month by month against a single anchor booking.
 *
 * Issuance is transactional by design: pass the caller's `tx` so the number, the
 * row and the business event it documents either all land or none do. A number
 * allocated by a transaction that later rolls back is a hole in a statutory
 * series, which is exactly what the `document_series` table exists to prevent.
 */
@Injectable()
export class DocumentIssuerService {
  private readonly logger = new Logger(DocumentIssuerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly builder: InvoiceDataBuilder,
    private readonly settlements: SettlementBuilder,
    private readonly numbers: InvoiceNumberService,
    private readonly gst: GstConfigService,
    private readonly config: InvoiceConfig,
  ) {}

  // ── Tax invoices ───────────────────────────────────────────────────────────

  /**
   * Issue the tax invoice for a captured instalment.
   *
   * Idempotent on `invoices.installment_id`, which is unique. Razorpay can
   * deliver `payment.captured` after `api:verify_payment` has already run the
   * same capture, and a second document for one payment would be a second entry
   * in the books for money that arrived once.
   *
   * Returns null rather than throwing when the instalment is not in a state to be
   * invoiced. This runs inside the payment capture path, and a document problem
   * must never be the reason a parent's payment fails to record.
   */
  async issueForInstallment(
    installmentId: string,
    db: Db = this.prisma,
    issuedAt: Date = new Date(),
  ): Promise<{ id: string; number: string } | null> {
    const existing = await db.invoices.findUnique({
      where: { installment_id: installmentId },
      select: { id: true, number: true, kind: true },
    });
    // A `legacy` row here is a number minted under the old download-time scheme
    // for this same instalment. Upgrade it in place rather than issuing a second
    // number: the family may already be quoting the first one on a transfer.
    if (existing && existing.kind !== "legacy") {
      return { id: existing.id, number: existing.number };
    }

    const registration = await this.gst.getRegistration();

    // Built before the number exists, so the reads that assemble the document
    // stay outside the transaction below. The number is stamped onto the
    // snapshot at the end — see `numberDocument`.
    const built = await this.builder.buildForInstallment(
      installmentId,
      PENDING_NUMBER,
      issuedAt,
      registration,
    );

    return this.inTransaction(db, async (tx) => {
      const number =
        existing?.number ??
        (await this.numbers.next("invoice", issuedAt, registration.enabled, tx));
      const snapshot = this.numberDocument(built.data, number);

      const payload = {
        number,
        kind: "tax_invoice",
        booking_id: built.bookingId,
        plan_id: built.planId,
        parent_id: built.parentId,
        installment_id: installmentId,
        price_snapshot_id: built.priceSnapshotId,
        cycle_number: built.cycleNumber,
        period_from: built.periodFrom,
        period_to: built.periodTo,
        subtotal_amount: built.subtotalAmount,
        gst_amount: built.gstAmount,
        total_amount: built.totalAmount,
        gst_registered: registration.enabled,
        issued_at: issuedAt,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
      };

      const invoice = existing
        ? await tx.invoices.update({
            where: { id: existing.id },
            data: { ...payload, updated_at: new Date() },
            select: { id: true, number: true },
          })
        : await tx.invoices.create({
            data: payload,
            select: { id: true, number: true },
          });

      if (existing) {
        await tx.invoice_lines.deleteMany({ where: { invoice_id: invoice.id } });
      }
      await tx.invoice_lines.createMany({
        data: built.lines.map((line) => ({
          invoice_id: invoice.id,
          seq: line.seq,
          name: line.name,
          description: line.description,
          qty: line.qty,
          unit_amount: line.unitAmount,
          subtotal_amount: line.subtotalAmount,
          gst_percent: line.gstPercent,
          gst_amount: line.gstAmount,
          amount: line.amount,
          sessions_covered: line.sessionsCovered,
          sac_code: line.sacCode,
        })),
      });

      this.logger.log(
        `Issued ${registration.enabled ? "tax invoice" : "invoice"} ${number} for instalment ${installmentId}`,
      );
      return invoice;
    });
  }

  /**
   * Run `work` in a transaction, unless the caller already gave us one.
   *
   * Allocating a number and writing the row it belongs to have to succeed or
   * fail together. A number handed out by a call that then dies is a gap in a
   * statutory series — the specific failure the `document_series` table exists
   * to rule out, and one a Postgres sequence could not.
   */
  private inTransaction<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<T> {
    // Already inside one: joining it is the point of accepting `db` at all.
    if (db !== this.prisma) return work(db);
    return this.prisma.$transaction((tx) => work(tx));
  }

  /**
   * Stamp the allocated number onto a document built before it was known.
   *
   * The number appears twice — as the document's own identifier and as the bank
   * reference a family is asked to quote — and both have to be the real one.
   */
  private numberDocument(data: InvoiceData, number: string): InvoiceData {
    return {
      ...data,
      invoiceNumber: number,
      payment: this.config.paymentDetails(number),
    };
  }

  // ── Credit notes ───────────────────────────────────────────────────────────

  /**
   * Reduce an issued invoice by a credit note, per GST section 34.
   *
   * The only sanctioned way to change what an invoice is worth. An issued invoice
   * is never edited and never voided — a family holds a copy, and under GST the
   * adjustment has to be a separate numbered document declared in the return for
   * the month it is issued.
   *
   * Rare in practice: because invoices are only ever issued against captured
   * money, and cancellation converts captured money into retained sessions rather
   * than refunding it, nothing in the routine billing path reaches here.
   */
  async issueCreditNote(
    input: IssueCreditNoteInput,
    db: Db = this.prisma,
    issuedAt: Date = new Date(),
  ): Promise<{ id: string; number: string; amount: number }> {
    const invoice = await db.invoices.findUnique({
      where: { id: input.invoiceId },
      select: {
        id: true,
        number: true,
        booking_id: true,
        parent_id: true,
        issued_at: true,
        subtotal_amount: true,
        gst_amount: true,
        total_amount: true,
        credited_amount: true,
        gst_registered: true,
        snapshot: true,
      },
    });
    if (!invoice) {
      throw new Error(`Cannot credit invoice ${input.invoiceId}: not found`);
    }

    const total = Number(invoice.total_amount);
    const alreadyCredited = Number(invoice.credited_amount);
    const remaining = round(total - alreadyCredited);
    const amount = round(
      input.amount == null ? remaining : Math.min(input.amount, remaining),
    );

    if (amount <= 0) {
      throw new Error(
        `Cannot credit invoice ${invoice.number}: nothing left to credit`,
      );
    }

    // Split the credit across pre-tax and tax in the same ratio the invoice
    // carried, so a partial credit does not silently reclaim more or less GST
    // than the share of the supply it reverses.
    const taxShare =
      total > 0 ? Number(invoice.gst_amount) / total : 0;
    const gstAmount = round(amount * taxShare);
    const subtotal = round(amount - gstAmount);

    const registration = await this.gst.getRegistration();

    // Built off the invoice's own frozen snapshot, not off live data: a credit
    // note has to describe the document it reduces as that document actually
    // reads, even if the underlying booking has moved on since.
    const source = invoice.snapshot as unknown as InvoiceData | null;
    const data: InvoiceData = {
      ...(source ?? ({} as InvoiceData)),
      documentTitle: "Credit Note",
      documentKind: "credit_note",
      invoiceNumber: PENDING_NUMBER,
      paid: false,
      isProforma: false,
      notice: undefined,
      reference: {
        label: "Against invoice",
        number: invoice.number,
        date: formatDate(invoice.issued_at),
        reason: REASON_TEXT[input.reason],
      },
      items: [
        {
          name: REASON_TEXT[input.reason],
          description:
            input.note?.trim() ||
            `Credit against invoice ${invoice.number} dated ${formatDate(invoice.issued_at)}.`,
          qty: "1",
          rate: formatAmount(subtotal),
          amount: formatAmount(subtotal),
          sac: registration.enabled ? registration.defaultSacCode : undefined,
        },
      ],
      totals: [
        { label: "Subtotal", amount: formatAmount(subtotal) },
        ...this.gst
          .taxLines(registration, this.rateOf(invoice), gstAmount)
          .filter((line) => line.amount > 0)
          .map((line) => ({
            label: line.label,
            amount: formatAmount(line.amount),
          })),
      ],
      grandTotal: { label: "Total credited", amount: formatAmount(amount) },
      amountInWords: amountInWords(amount),
      company: this.config.company,
      gst: this.builder.gstBlock(registration),
      hasSchedule: false,
      schedule: undefined,
      payment: this.config.paymentDetails(PENDING_NUMBER),
      terms: [
        `This credit note reduces invoice ${invoice.number} by ₹ ${formatAmount(amount)}.`,
        input.settlement === "refunded"
          ? "The amount has been refunded to the original payment method."
          : input.settlement === "retained_as_entitlement"
            ? "The value has been retained against sessions still owed to you, not refunded."
            : "The amount has been written off and is no longer payable.",
        "Please retain this note with the original invoice for your records.",
      ],
    };

    return this.inTransaction(db, async (tx) => {
      const number = await this.numbers.next(
        "credit_note",
        issuedAt,
        invoice.gst_registered,
        tx,
      );

      const note = await tx.credit_notes.create({
        data: {
          number,
          invoice_id: invoice.id,
          booking_id: invoice.booking_id,
          parent_id: invoice.parent_id,
          reason: input.reason,
          settlement: input.settlement,
          note: input.note ?? null,
          subtotal_amount: subtotal,
          gst_amount: gstAmount,
          total_amount: amount,
          refund_id: input.refundId ?? null,
          issued_at: issuedAt,
          snapshot: this.numberDocument(
            data,
            number,
          ) as unknown as Prisma.InputJsonValue,
        },
        select: { id: true, number: true },
      });

      await tx.credit_note_lines.create({
        data: {
          credit_note_id: note.id,
          seq: 1,
          name: REASON_TEXT[input.reason],
          description: input.note ?? null,
          subtotal_amount: subtotal,
          gst_percent: this.rateOf(invoice),
          gst_amount: gstAmount,
          amount,
        },
      });

      // Bumped in the same transaction as the note, so the invoice can never
      // read as credited by an amount no note accounts for, or the reverse.
      await tx.invoices.update({
        where: { id: invoice.id },
        data: {
          credited_amount: round(alreadyCredited + amount),
          updated_at: new Date(),
        },
      });

      this.logger.log(
        `Issued credit note ${number} for ₹${amount} against invoice ${invoice.number} (${input.reason}/${input.settlement})`,
      );
      return { id: note.id, number, amount };
    });
  }


  // ── Settlements ────────────────────────────────────────────────────────────

  /**
   * Freeze what a cancelled plan settled at.
   *
   * Unique on `plan_id`, because cancellation is idempotent — a parent
   * double-tapping the button, or retrying after a dropped response, must get the
   * same statement rather than a second one with a different number.
   */
  async issueSettlement(input: {
    planId: string;
    parentId: string | null;
    cancelledAt: Date;
    reason: string | null;
    entitlement: PlanEntitlement;
    retainedBookingIds: string[];
    amounts: SettlementInput["amounts"];
    db?: Db;
  }): Promise<{ id: string; number: string } | null> {
    const db = input.db ?? this.prisma;

    const existing = await db.plan_settlements.findUnique({
      where: { plan_id: input.planId },
      select: { id: true, number: true },
    });
    if (existing) return existing;

    const registration = await this.gst.getRegistration();

    // Built before the number exists so the statement's many reads — plan,
    // parent, children, retained dates, every document on the plan — stay out
    // of the transaction that allocates it.
    const data = await this.settlements.build({
      planId: input.planId,
      settlementNumber: PENDING_NUMBER,
      cancelledAt: input.cancelledAt,
      reason: input.reason,
      entitlement: input.entitlement,
      retainedBookingIds: input.retainedBookingIds,
      amounts: input.amounts,
    });

    return this.inTransaction(db, async (tx) => {
      const number = await this.numbers.next(
        "settlement",
        input.cancelledAt,
        registration.enabled,
        tx,
      );

      const settlement = await tx.plan_settlements.create({
        data: {
          number,
          plan_id: input.planId,
          parent_id: input.parentId,
          cancelled_at: input.cancelledAt,
          reason: input.reason,
          entitlement:
            input.entitlement.cycles as unknown as Prisma.InputJsonValue,
          sessions_entitled: input.entitlement.sessionsEntitled,
          sessions_delivered: input.entitlement.sessionsDelivered,
          sessions_retained: input.retainedBookingIds.length,
          retained_booking_ids: input.retainedBookingIds,
          amount_billed: input.amounts.billed,
          amount_paid: input.amounts.paid,
          amount_voided: input.amounts.voided,
          amount_still_owed: input.amounts.stillOwed,
          matching_fee_retained: input.amounts.matchingFeeRetained,
          snapshot: {
            ...data,
            settlementNumber: number,
          } as unknown as Prisma.InputJsonValue,
        },
        select: { id: true, number: true },
      });

      this.logger.log(
        `Issued settlement statement ${number} for plan ${input.planId} ` +
          `(${input.retainedBookingIds.length} sessions retained)`,
      );
      return settlement;
    });
  }

  /** The GST rate an invoice carried, recovered from its own frozen amounts. */
  private rateOf(invoice: {
    subtotal_amount: Prisma.Decimal | number;
    gst_amount: Prisma.Decimal | number;
  }): number {
    const subtotal = Number(invoice.subtotal_amount);
    const gst = Number(invoice.gst_amount);
    if (subtotal <= 0 || gst <= 0) return 0;
    // Snapped to two decimals: 18% recovered off rounded paise comes back as
    // 17.999…, and a credit note reading `CGST (8.999%)` is not a document
    // anybody will accept.
    return Math.round((gst / subtotal) * 10000) / 100;
  }
}

const REASON_TEXT: Record<CreditNoteReason, string> = {
  refund: "Refund of fees",
  plan_cancelled: "Plan cancelled — undelivered service",
  written_off: "Amount written off",
  correction: "Billing correction",
};

function round(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}
