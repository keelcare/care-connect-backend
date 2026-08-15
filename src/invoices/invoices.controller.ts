import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Response } from "express";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { UserRole } from "../auth/dto/signup.dto";
import { Roles } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { InvoicesService } from "./invoices.service";

@ApiTags("Invoices")
@Controller("invoices")
@UseGuards(AuthGuard("jwt"))
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @Roles(UserRole.PARENT)
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @ApiOperation({
    summary: "Every document the authenticated parent holds",
    description:
      "Tax invoices, credit notes, cancellation statements, and a proforma for " +
      "any booking that is billable but has nothing captured yet. One flat list, " +
      "newest first — a family does not think in terms of which table a document " +
      "came from.\n\n" +
      "Each row carries `downloadPath`, which is the exact path to fetch its PDF " +
      "from. Clients should follow it rather than reconstructing URLs per kind.",
  })
  @ApiResponse({ status: 200, description: "Documents listed" })
  async list(@Req() req: any) {
    return this.invoices.listForParent(req.user.id);
  }

  // ── Statement ──────────────────────────────────────────────────────────────

  @Get("booking/:bookingId/statement")
  @ApiOperation({
    summary: "The running account for a booking, or its whole plan",
    description:
      "What the term costs, what has been billed, paid and credited, what is " +
      "outstanding and when the next payment falls due, plus every document on " +
      "the engagement. The surface an app should lead with: a six-month plan ends " +
      "with a dozen documents, and none of them answers 'where do I stand'.",
  })
  @ApiResponse({ status: 200, description: "Statement returned" })
  @ApiResponse({ status: 404, description: "No such booking for this user" })
  async statement(
    @Req() req: any,
    @Param("bookingId", ParseUUIDPipe) bookingId: string,
  ) {
    return this.invoices.statementForBooking(bookingId, req.user);
  }

  // ── Proforma ───────────────────────────────────────────────────────────────

  @Get("booking/:bookingId/proforma")
  @ApiOperation({
    summary: "What the engagement will cost, end to end",
    description:
      "Not a tax invoice and not a demand for payment — it carries a standing " +
      "notice saying so. Includes a payment schedule covering the whole term, " +
      "with cycles the billing cron has not opened yet projected from the last " +
      "price actually snapshotted and marked `Scheduled`.\n\n" +
      "Rebuilt on every read, unlike issued documents: it is a statement of what " +
      "the term will cost, which legitimately changes as cycles open.",
  })
  @ApiResponse({ status: 200, description: "Proforma returned" })
  async proforma(
    @Req() req: any,
    @Param("bookingId", ParseUUIDPipe) bookingId: string,
  ) {
    return this.invoices.getProforma(bookingId, req.user);
  }

  @Get("booking/:bookingId/proforma/pdf")
  @ApiOperation({ summary: "Download the proforma as a PDF" })
  async proformaPdf(
    @Req() req: any,
    @Param("bookingId", ParseUUIDPipe) bookingId: string,
    @Res() res: Response,
  ) {
    const { pdf, filename } = await this.invoices.getProformaPdf(
      bookingId,
      req.user,
    );
    this.stream(res, pdf, filename);
  }

  /**
   * Where the old per-booking invoice route pointed.
   *
   * Kept so app builds already in the wild keep working. Those clients expect one
   * document covering the whole booking, which is exactly what the proforma is.
   */
  @Get("booking/:bookingId")
  @ApiOperation({
    summary: "Deprecated — the booking's invoice as structured data",
    deprecated: true,
    description:
      "Serves the proforma. Invoices are now issued per captured payment and " +
      "listed at `GET /invoices`; use `booking/:id/statement` for an overview " +
      "and `booking/:id/proforma` for this document by its real name.",
  })
  async legacyBookingInvoice(
    @Req() req: any,
    @Param("bookingId", ParseUUIDPipe) bookingId: string,
  ) {
    return this.invoices.getProforma(bookingId, req.user);
  }

  @Get("booking/:bookingId/pdf")
  @ApiOperation({
    summary: "Deprecated — download the booking's invoice as a PDF",
    deprecated: true,
  })
  async legacyBookingPdf(
    @Req() req: any,
    @Param("bookingId", ParseUUIDPipe) bookingId: string,
    @Res() res: Response,
  ) {
    const { pdf, filename } = await this.invoices.getProformaPdf(
      bookingId,
      req.user,
    );
    this.stream(res, pdf, filename);
  }

  // ── Settlements ────────────────────────────────────────────────────────────

  @Get("plan/:planId/settlement")
  @ApiOperation({
    summary: "The settlement statement for a cancelled plan",
    description:
      "Which sessions the family keeps, on what dates, the per-cycle working " +
      "behind that number, and what is no longer payable. Frozen at cancellation.",
  })
  @ApiResponse({ status: 404, description: "Plan was never cancelled" })
  async settlement(
    @Req() req: any,
    @Param("planId", ParseUUIDPipe) planId: string,
  ) {
    return this.invoices.getSettlement(planId, req.user);
  }

  @Get("plan/:planId/settlement/pdf")
  @ApiOperation({ summary: "Download the settlement statement as a PDF" })
  async settlementPdf(
    @Req() req: any,
    @Param("planId", ParseUUIDPipe) planId: string,
    @Res() res: Response,
  ) {
    const { pdf, filename } = await this.invoices.getSettlementPdf(
      planId,
      req.user,
    );
    this.stream(res, pdf, filename);
  }

  // ── Credit notes ───────────────────────────────────────────────────────────

  @Get("credit-notes/:creditNoteId")
  @ApiOperation({ summary: "A credit note, as structured data" })
  async creditNote(
    @Req() req: any,
    @Param("creditNoteId", ParseUUIDPipe) creditNoteId: string,
  ) {
    return this.invoices.getCreditNote(creditNoteId, req.user);
  }

  @Get("credit-notes/:creditNoteId/pdf")
  @ApiOperation({ summary: "Download a credit note as a PDF" })
  async creditNotePdf(
    @Req() req: any,
    @Param("creditNoteId", ParseUUIDPipe) creditNoteId: string,
    @Res() res: Response,
  ) {
    const { pdf, filename } = await this.invoices.getCreditNotePdf(
      creditNoteId,
      req.user,
    );
    this.stream(res, pdf, filename);
  }

  // ── Issued invoices ────────────────────────────────────────────────────────
  // Declared last: `:invoiceId` would otherwise swallow `booking`, `plan` and
  // `credit-notes` as if they were ids.

  @Get(":invoiceId")
  @ApiOperation({
    summary: "An issued invoice, rendered from its frozen snapshot",
    description:
      "Exactly the object the PDF is rendered from, already formatted for " +
      "display — amounts are strings, dates are IST. Byte-identical on every " +
      "read: an issued invoice is never re-derived from live billing rows.",
  })
  @ApiResponse({ status: 404, description: "No such invoice for this user" })
  async invoice(
    @Req() req: any,
    @Param("invoiceId", ParseUUIDPipe) invoiceId: string,
  ) {
    return this.invoices.getInvoice(invoiceId, req.user);
  }

  @Get(":invoiceId/pdf")
  @ApiOperation({
    summary: "Download an issued invoice as a PDF",
    description:
      "Streams `application/pdf` with a `Content-Disposition` filename, for the " +
      "mobile app to save or share. Admins may fetch any invoice; a parent may " +
      "only fetch their own.",
  })
  async invoicePdf(
    @Req() req: any,
    @Param("invoiceId", ParseUUIDPipe) invoiceId: string,
    @Res() res: Response,
  ) {
    const { pdf, filename } = await this.invoices.getInvoicePdf(
      invoiceId,
      req.user,
    );
    this.stream(res, pdf, filename);
  }

  private stream(res: Response, pdf: Buffer, filename: string) {
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(pdf.length),
      // A document is per-user and a proforma can change the moment a payment
      // captures, so it must never sit in a shared or device cache.
      "Cache-Control": "private, no-store",
    });
    res.end(pdf);
  }
}
