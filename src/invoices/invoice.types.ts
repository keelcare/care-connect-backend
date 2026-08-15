/**
 * The shapes the document templates render against.
 *
 * Everything here is already formatted for display — strings, not Decimals —
 * because a template must not be in the business of rounding money or picking a
 * locale. These objects are also exactly what the mobile app receives, so an
 * in-app preview and the PDF can never disagree about what was billed.
 *
 * For an issued document this object is *stored*, in `invoices.snapshot` /
 * `credit_notes.snapshot` / `plan_settlements.snapshot`, and re-rendered from
 * there forever after. That is the immutability guarantee: a later rate change, a
 * GST-registration flip or a corrected profile name cannot restate a document
 * someone already holds.
 */

export interface InvoiceParty {
  name: string;
  /** Free-form address / contact lines, rendered one per row. */
  lines: string[];
  /** Recipient GSTIN, when they gave one and registration is on. */
  gstin?: string;
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
  /** Service Accounting Code. Present only once GST registration is enabled. */
  sac?: string;
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

/**
 * The supplier-side tax identity printed on the document, frozen at issue.
 *
 * `registered: false` is the normal state today — Keel collects GST but is not
 * yet issuing tax invoices — and the template drops the whole block rather than
 * printing empty fields.
 */
export interface InvoiceGstBlock {
  registered: boolean;
  gstin: string;
  legalName: string;
  placeOfSupply: string;
  /** True when the tax is IGST rather than CGST + SGST. */
  interState: boolean;
  /** Whether the items table should carry an SAC column. */
  showSac: boolean;
}

/** What a credit note is reducing. Required by GST s.34 on the note itself. */
export interface InvoiceReference {
  label: string;
  number: string;
  date: string;
  reason: string;
}

/** A single row of a proforma's forward-looking payment schedule. */
export interface InvoiceScheduleRow {
  label: string;
  period: string;
  due: string;
  amount: string;
  /** `Paid` / `Due` / `Scheduled` — the state as at render time. */
  status: string;
}

export type DocumentKind =
  | "tax_invoice"
  | "proforma"
  | "credit_note"
  | "legacy";

export interface InvoiceData {
  /** `Tax Invoice`, `Invoice`, `Proforma Invoice`, `Credit Note`. */
  documentTitle: string;
  documentKind: DocumentKind;
  invoiceNumber: string;
  /** True once every amount on the document is settled — bill becomes receipt. */
  paid: boolean;
  /**
   * A proforma is not a demand and not a tax document; it is what the engagement
   * will cost. The template prints a standing notice saying so, because a family
   * filing a claim with one would otherwise be turned away at the counter.
   */
  isProforma: boolean;
  /** The standing notice itself, when there is one. */
  notice?: string;
  billedTo: InvoiceParty;
  /** Invoice date, due/paid date, billing period, amount. */
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
  gst: InvoiceGstBlock;
  /** Set on a credit note: the invoice it reduces. */
  reference?: InvoiceReference;
  /** Set on a proforma: every instalment of the term, raised or not. */
  schedule?: InvoiceScheduleRow[];
  hasSchedule: boolean;
  payment: InvoicePaymentDetails;
  terms: string[];
}

/** One cycle's working on a settlement statement, so any number can be audited. */
export interface SettlementCycleRow {
  label: string;
  period: string;
  billed: string;
  paid: string;
  sessionsInCycle: string;
  sessionsEarned: string;
}

export interface SettlementData {
  documentTitle: string;
  settlementNumber: string;
  billedTo: InvoiceParty;
  facts: InvoiceFact[];
  engagement: InvoiceFact[];
  hasEngagement: boolean;
  /** Plain-language summary of the outcome, above the arithmetic. */
  headline: string;
  outcome: InvoiceFact[];
  cycles: SettlementCycleRow[];
  /** The dates the parent keeps. The question they actually asked. */
  retainedSessions: Array<{ date: string; time: string }>;
  hasRetainedSessions: boolean;
  totals: InvoiceTotalLine[];
  /** Invoices and credit notes this settlement sits on top of. */
  documents: Array<{ label: string; number: string; date: string; amount: string }>;
  hasDocuments: boolean;
  company: InvoiceCompany;
  gst: InvoiceGstBlock;
  terms: string[];
}
