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
    summary:
      "Every instalment the authenticated parent can download an invoice for",
    description:
      "One entry per instalment — a cycle split into an advance and a balance " +
      "produces two invoices, matching what the parent was actually asked to pay.\n\n" +
      "`invoiceNumber` is null until the invoice is first downloaded: numbers are " +
      "issued lazily so unwanted invoices never consume one. Clients should show " +
      "`title`/`amountFormatted` in the list and not depend on the number being present.\n\n" +
      "Unpaid instalments are included — the document doubles as the bill, with due " +
      "date and bank details on it.",
  })
  @ApiResponse({ status: 200, description: "Downloadable invoices listed" })
  async list(@Req() req: any) {
    return this.invoices.listForParent(req.user.id);
  }

  @Get(":installmentId")
  @ApiOperation({
    summary: "The invoice as structured data, for an in-app preview",
    description:
      "Exactly the object the PDF is rendered from, already formatted for display " +
      "— amounts are strings, dates are IST. Calling this issues the invoice " +
      "number if one has not been issued yet.",
  })
  @ApiResponse({ status: 200, description: "Invoice data returned" })
  @ApiResponse({ status: 404, description: "No such invoice for this user" })
  async getData(
    @Req() req: any,
    @Param("installmentId", ParseUUIDPipe) installmentId: string,
  ) {
    return this.invoices.getInvoiceData(installmentId, req.user);
  }

  @Get(":installmentId/pdf")
  @ApiOperation({
    summary: "Download the invoice as a PDF",
    description:
      "Streams `application/pdf` with a `Content-Disposition` filename, for the " +
      "mobile app to save or share. Admins may fetch any invoice; a parent may " +
      "only fetch their own.",
  })
  @ApiResponse({ status: 200, description: "PDF returned" })
  @ApiResponse({ status: 404, description: "No such invoice for this user" })
  async download(
    @Req() req: any,
    @Param("installmentId", ParseUUIDPipe) installmentId: string,
    @Res() res: Response,
  ) {
    const { pdf, filename } = await this.invoices.getInvoicePdf(
      installmentId,
      req.user,
    );

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(pdf.length),
      // An invoice is per-user and can flip from bill to receipt the moment a
      // payment captures, so it must never sit in a shared or device cache.
      "Cache-Control": "private, no-store",
    });
    res.end(pdf);
  }
}
