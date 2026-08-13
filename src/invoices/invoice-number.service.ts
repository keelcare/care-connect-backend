import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { InvoiceConfig } from "./invoice.config";

/**
 * Allocates the human-facing invoice number for an installment, once.
 *
 * Lazy on purpose: most installments are never asked for as a PDF, and a number
 * handed out is a number that has to be accounted for. Once allocated it is
 * immutable — a family may already be quoting it on a bank transfer.
 */
@Injectable()
export class InvoiceNumberService {
  private readonly logger = new Logger(InvoiceNumberService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: InvoiceConfig,
  ) {}

  /**
   * Returns the installment's invoice number and issue date, minting them on
   * first call.
   *
   * The write is a conditional UPDATE rather than a read-then-write: two devices
   * tapping download at the same moment would otherwise each see a null and each
   * mint a number. Here the loser's UPDATE matches no row, and it re-reads the
   * winner's value. That can burn a sequence value, which is fine — Postgres
   * sequences are not gapless under any usage, and the numbers only need to be
   * unique and ordered, not contiguous.
   */
  async ensureFor(
    installmentId: string,
  ): Promise<{ invoiceNumber: string; issuedAt: Date }> {
    const existing = await this.prisma.payment_installments.findUnique({
      where: { id: installmentId },
      select: { invoice_number: true, invoice_issued_at: true },
    });

    if (existing?.invoice_number) {
      return {
        invoiceNumber: existing.invoice_number,
        issuedAt: existing.invoice_issued_at ?? new Date(),
      };
    }

    const issuedAt = new Date();
    const candidate = this.format(await this.nextSequenceValue(), issuedAt);

    const claimed = await this.prisma.payment_installments.updateMany({
      where: { id: installmentId, invoice_number: null },
      data: { invoice_number: candidate, invoice_issued_at: issuedAt },
    });

    if (claimed.count === 1) {
      this.logger.log(
        `Issued invoice ${candidate} for installment ${installmentId}`,
      );
      return { invoiceNumber: candidate, issuedAt };
    }

    // Lost the race — the concurrent caller's number is the real one.
    const winner = await this.prisma.payment_installments.findUniqueOrThrow({
      where: { id: installmentId },
      select: { invoice_number: true, invoice_issued_at: true },
    });
    return {
      invoiceNumber: winner.invoice_number ?? candidate,
      issuedAt: winner.invoice_issued_at ?? issuedAt,
    };
  }

  private async nextSequenceValue(): Promise<number> {
    const [row] = await this.prisma.$queryRaw<Array<{ nextval: bigint }>>`
      SELECT nextval('invoice_number_seq') AS nextval
    `;
    return Number(row.nextval);
  }

  /**
   * `KL-2026-0001`. The year is the issue year for readability only — the
   * counter behind it is global, so it does not restart and numbers stay unique
   * across a year boundary.
   */
  private format(sequence: number, issuedAt: Date): string {
    const year = new Intl.DateTimeFormat("en-IN", {
      year: "numeric",
      timeZone: "Asia/Kolkata",
    }).format(issuedAt);
    return `${this.config.invoicePrefix}-${year}-${String(sequence).padStart(4, "0")}`;
  }
}
