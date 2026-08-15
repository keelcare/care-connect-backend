import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { InvoicesController } from "./invoices.controller";
import { InvoicesService } from "./invoices.service";
import { InvoiceDataBuilder } from "./invoice-data.builder";
import { SettlementBuilder } from "./settlement.builder";
import { DocumentIssuerService } from "./document-issuer.service";
import { InvoiceNumberService } from "./invoice-number.service";
import { InvoiceConfig } from "./invoice.config";
import { GstConfigService } from "./gst.config";
import { PdfService } from "./pdf.service";

@Module({
  imports: [ConfigModule],
  controllers: [InvoicesController],
  providers: [
    InvoicesService,
    InvoiceDataBuilder,
    SettlementBuilder,
    DocumentIssuerService,
    InvoiceNumberService,
    InvoiceConfig,
    GstConfigService,
    PdfService,
    PrismaService,
  ],
  // `DocumentIssuerService` is exported because issuance belongs to the moment a
  // business event happens, not to a read path: payments issue an invoice at
  // capture and a credit note at refund, and cancellation issues a settlement.
  // Anything that later needs to attach a document — a receipt email, an admin
  // export — renders the same object the app does.
  exports: [InvoicesService, DocumentIssuerService, GstConfigService, PdfService],
})
export class InvoicesModule {}
