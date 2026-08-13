/**
 * The shape the invoice template renders against.
 *
 * Everything here is already formatted for display — strings, not Decimals —
 * because the template must not be in the business of rounding money or picking
 * a locale. `InvoiceDataBuilder` is the only thing that produces one of these,
 * and it is also the JSON the mobile app gets from `GET /invoices/:id`, so an
 * in-app preview and the PDF can never disagree about what was billed.
 */

export interface InvoiceParty {
  name: string;
  /** Free-form address / contact lines, rendered one per row. */
  lines: string[];
}

export interface InvoiceFact {
  label: string;
  value: string;
}

export interface InvoiceLineItem {
  name: string;
  description: string;
  qty: string;
  rate: string;
  amount: string;
}

export interface InvoiceTotalLine {
  label: string;
  amount: string;
  /** Rendered with a leading minus, for credits such as an advance already paid. */
  negative?: boolean;
}

export interface InvoiceCompany {
  name: string;
  tagline: string;
  addressLine: string;
  contactLine: string;
  supportEmail: string;
}

export interface InvoicePaymentDetails {
  accountName: string;
  bank: string;
  accountNo: string;
  ifsc: string;
  upi: string;
  reference: string;
}

export interface InvoiceData {
  invoiceNumber: string;
  /** True once the installment is settled — flips the document from bill to receipt. */
  paid: boolean;
  billedTo: InvoiceParty;
  /** Invoice date, due/paid date, billing period, instalment position, amount. */
  facts: InvoiceFact[];
  /** Student / school / caregiver strip. Omitted entirely when nothing is known. */
  engagement: InvoiceFact[];
  /** The template cannot ask whether an array is empty; this is that question. */
  hasEngagement: boolean;
  items: InvoiceLineItem[];
  totals: InvoiceTotalLine[];
  grandTotal: { label: string; amount: string };
  amountInWords: string;
  company: InvoiceCompany;
  payment: InvoicePaymentDetails;
  terms: string[];
}
