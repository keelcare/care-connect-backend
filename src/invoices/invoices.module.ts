import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { InvoicesController } from "./invoices.controller";
import { InvoicesService } from "./invoices.service";
import { InvoiceDataBuilder } from "./invoice-data.builder";
import { InvoiceNumberService } from "./invoice-number.service";
import { InvoiceConfig } from "./invoice.config";
import { PdfService } from "./pdf.service";

@Module({
  imports: [ConfigModule],
  controllers: [InvoicesController],
  providers: [
    InvoicesService,
    InvoiceDataBuilder,
    InvoiceNumberService,
    InvoiceConfig,
    PdfService,
    PrismaService,
  ],
  // Exported so anything that later needs to attach an invoice — a payment
  // receipt email, an admin export — renders the same document as the app does.
  exports: [InvoicesService, PdfService],
})
export class InvoicesModule {}
