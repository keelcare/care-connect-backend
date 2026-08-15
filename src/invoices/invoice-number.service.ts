import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { InvoiceConfig } from "./invoice.config";

/** The series a number is drawn from. Each counts independently. */
export type DocumentSeries = "invoice" | "credit_note" | "settlement";

/** What each series' numbers read as: `KL-2026-0001`, `KL-CN-2026-0001`. */
const SERIES_INFIX: Record<DocumentSeries, string> = {
  invoice: "",
  credit_note: "CN-",
  settlement: "ST-",
};

/** Anything Prisma can run a query on — the client, or an interactive transaction. */
type Db = PrismaService | Prisma.TransactionClient;

/**
 * Allocates document numbers from a per-series, per-financial-year counter.
 *
 * Replaces the old global `invoice_number_seq`, for three reasons. GST requires a
 * serial that is unique and *consecutive within a financial year*, and a sequence
 * that never resets cannot express that. Credit notes need their own series
 * rather than interleaving with invoices. And a sequence hands out a number the
 * instant it is asked, even if the surrounding transaction then rolls back —
 * whereas a row incremented inside that transaction rolls back with it, so a
 * failed capture does not leave a hole in the books.
 *
 * Allocation is eager now, not lazy. Numbers used to be minted on first download,
 * which was right when the document was re-derived on every read; it is wrong now
 * that a document is a persisted thing issued at a definite moment.
 */
@Injectable()
export class InvoiceNumberService {
  private readonly logger = new Logger(InvoiceNumberService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: InvoiceConfig,
  ) {}

  /**
   * The next number in a series.
   *
   * Pass the transaction client when issuing inside one — that is the whole point
   * of the table over a sequence, and calling this on the base client from inside
   * a transaction would silently give up the rollback guarantee.
   *
   * The counter row is created on demand, so the first document of a new
   * financial year needs no migration or cron to have run first.
   */
  async next(
    series: DocumentSeries,
    issuedAt: Date,
    gstRegistered: boolean,
    db: Db = this.prisma,
  ): Promise<string> {
    const year = this.seriesYear(issuedAt, gstRegistered);

    // Upsert-then-increment in one statement: two concurrent captures must not
    // both read the same `next_value`. `RETURNING` gives us the value this caller
    // won, and the row-level lock Postgres takes on the update serialises the
    // rest behind it.
    const rows = await db.$queryRaw<Array<{ next_value: number }>>`
      INSERT INTO "document_series" ("kind", "financial_year", "next_value", "updated_at")
      VALUES (${series}, ${year}, 2, now())
      ON CONFLICT ("kind", "financial_year")
      DO UPDATE SET "next_value" = "document_series"."next_value" + 1, "updated_at" = now()
      RETURNING "next_value" - 1 AS "next_value"
    `;

    const value = rows[0]?.next_value ?? 1;
    return this.format(series, value, year);
  }

  /**
   * The year a number is stamped with, and the counter it draws from.
   *
   * Unregistered: the IST calendar year, which is what every number already
   * issued reads as. Registered: the financial year's start year, because GST
   * counts a serial per FY (April–March) and a January invoice belongs to the
   * year that began the previous April.
   */
  private seriesYear(issuedAt: Date, gstRegistered: boolean): number {
    const parts = new Intl.DateTimeFormat("en-IN", {
      year: "numeric",
      month: "numeric",
      timeZone: "Asia/Kolkata",
    }).formatToParts(issuedAt);

    const year = Number(parts.find((p) => p.type === "year")?.value);
    const month = Number(parts.find((p) => p.type === "month")?.value);

    if (!gstRegistered) return year;
    return month >= 4 ? year : year - 1;
  }

  /** `KL-2026-0001`, `KL-CN-2026-0001`, `KL-ST-2026-0001`. */
  private format(
    series: DocumentSeries,
    value: number,
    year: number,
  ): string {
    return `${this.config.invoicePrefix}-${SERIES_INFIX[series]}${year}-${String(value).padStart(4, "0")}`;
  }

  /**
   * The number already issued against a booking under the old render-on-download
   * scheme, if any.
   *
   * Adopted rather than superseded: it is on a document the family already holds,
   * and quite possibly on a bank transfer reference. Only used for the legacy
   * read path — new captures always draw a fresh number.
   */
  async legacyNumberForBooking(
    bookingId: string,
  ): Promise<{ invoiceNumber: string; issuedAt: Date } | null> {
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      select: { invoice_number: true, invoice_issued_at: true },
    });

    if (booking?.invoice_number) {
      return {
        invoiceNumber: booking.invoice_number,
        issuedAt: booking.invoice_issued_at ?? new Date(),
      };
    }

    const installment = await this.prisma.payment_installments.findFirst({
      where: { booking_id: bookingId, invoice_number: { not: null } },
      orderBy: [{ invoice_issued_at: "asc" }],
      select: { invoice_number: true, invoice_issued_at: true },
    });

    return installment?.invoice_number
      ? {
          invoiceNumber: installment.invoice_number,
          issuedAt: installment.invoice_issued_at ?? new Date(),
        }
      : null;
  }
}
