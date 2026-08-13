import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InvoiceCompany, InvoicePaymentDetails } from "./invoice.types";

/**
 * Issuer details printed on every invoice.
 *
 * These are env-driven rather than hard-coded because the bank block is the one
 * part of the document that changes without a deploy (and must never be wrong).
 * The defaults are the placeholders from the design file, so a misconfigured
 * environment produces an obviously-unfinished invoice rather than a plausible
 * one pointing at the wrong account.
 */
@Injectable()
export class InvoiceConfig {
  constructor(private readonly config: ConfigService) {}

  private get(key: string, fallback: string): string {
    const value = this.config.get<string>(key);
    return value && value.trim() ? value.trim() : fallback;
  }

  get company(): InvoiceCompany {
    return {
      name: this.get("INVOICE_COMPANY_NAME", "Keel"),
      tagline: this.get("INVOICE_COMPANY_TAGLINE", "Shadow Teacher Placement"),
      addressLine: this.get(
        "INVOICE_COMPANY_ADDRESS",
        "Keel · Mumbai, Maharashtra",
      ),
      contactLine: this.get(
        "INVOICE_COMPANY_CONTACT",
        "accounts@keel.co.in · +91 22 0000 0000",
      ),
      supportEmail: this.get("INVOICE_SUPPORT_EMAIL", "accounts@keel.co.in"),
    };
  }

  /** `reference` is per-invoice, so the caller supplies it. */
  paymentDetails(reference: string): InvoicePaymentDetails {
    return {
      accountName: this.get("INVOICE_BANK_ACCOUNT_NAME", "Keel"),
      bank: this.get("INVOICE_BANK_NAME", "HDFC Bank, Andheri East"),
      accountNo: this.get("INVOICE_BANK_ACCOUNT_NO", "0000 0000 0000"),
      ifsc: this.get("INVOICE_BANK_IFSC", "HDFC0000000"),
      upi: this.get("INVOICE_UPI_ID", "keel@upi"),
      reference,
    };
  }

  /** Prefix for the rendered invoice number, e.g. `KL` → `KL-2026-0001`. */
  get invoicePrefix(): string {
    return this.get("INVOICE_NUMBER_PREFIX", "KL");
  }
}
