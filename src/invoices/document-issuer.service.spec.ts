import { Test, TestingModule } from "@nestjs/testing";
import { DocumentIssuerService } from "./document-issuer.service";
import { InvoiceDataBuilder } from "./invoice-data.builder";
import { SettlementBuilder } from "./settlement.builder";
import { InvoiceNumberService } from "./invoice-number.service";
import { GstConfigService } from "./gst.config";
import { InvoiceConfig } from "./invoice.config";
import { PrismaService } from "../prisma/prisma.service";
import { InvoiceData } from "./invoice.types";

/**
 * The immutability guarantee, tested where it is actually made.
 *
 * An invoice used to be re-derived from `payment_installments` on every read, so
 * a six-month plan's document grew each month under the same number and shrank
 * again when cancellation voided a row. Everything here exists to make that
 * impossible: one document per billing group — a cycle of a booking, with the
 * matching fee folded into cycle 1 — written once, snapshot and all, and only
 * once every instalment in that group has been captured.
 */
describe("DocumentIssuerService", () => {
  let service: DocumentIssuerService;

  const mockPrisma: Record<string, any> = {
    invoices: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    invoice_lines: { createMany: jest.fn(), deleteMany: jest.fn() },
    credit_notes: { create: jest.fn() },
    credit_note_lines: { create: jest.fn() },
    plan_settlements: { findUnique: jest.fn(), create: jest.fn() },
    payment_installments: { findUnique: jest.fn(), findMany: jest.fn() },
    // Issuance opens its own transaction so a number and the row it belongs to
    // cannot land separately. Run the callback against the same mock.
    $transaction: jest.fn((work: (tx: unknown) => unknown) => work(mockPrisma)),
  };

  const mockBuilder = { buildForGroup: jest.fn(), gstBlock: jest.fn() };

  /** A cycle whose instalments are all captured, so its invoice is due. */
  const settledGroup = (
    rows: Array<Record<string, unknown>> = [
      { id: "inst-fee", status: "paid", cycle_number: 0, kind: "matching_fee" },
      { id: "inst-1", status: "paid", cycle_number: 1, kind: "cycle" },
    ],
  ) => mockPrisma.payment_installments.findMany.mockResolvedValue(rows);
  const mockSettlements = { build: jest.fn() };
  const mockNumbers = { next: jest.fn() };
  const mockGst = {
    getRegistration: jest.fn(),
    taxLines: jest.fn(),
    isInterState: jest.fn(),
  };
  const mockConfig = {
    company: { name: "Keel" },
    paymentDetails: jest.fn(() => ({ reference: "ref" })),
  };

  const UNREGISTERED = { enabled: false, gstin: "", defaultSacCode: "999599" };

  const built = {
    data: { invoiceNumber: "KL-2026-0001" } as unknown as InvoiceData,
    lines: [
      {
        seq: 1,
        name: "Shadow teacher support",
        description: "Covers 10 of 20 scheduled sessions in this cycle.",
        qty: 1,
        unitAmount: 12712,
        subtotalAmount: 12712,
        gstPercent: 18,
        gstAmount: 2288,
        amount: 15000,
        sessionsCovered: 10,
        sacCode: null,
      },
    ],
    bookingId: "b1",
    planId: "plan-1",
    parentId: "parent-1",
    priceSnapshotId: "snap-1",
    cycleNumber: 1,
    periodFrom: new Date("2026-09-01"),
    periodTo: new Date("2026-09-30"),
    subtotalAmount: 12712,
    gstAmount: 2288,
    totalAmount: 15000,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentIssuerService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: InvoiceDataBuilder, useValue: mockBuilder },
        { provide: SettlementBuilder, useValue: mockSettlements },
        { provide: InvoiceNumberService, useValue: mockNumbers },
        { provide: GstConfigService, useValue: mockGst },
        { provide: InvoiceConfig, useValue: mockConfig },
      ],
    }).compile();
    service = module.get(DocumentIssuerService);

    mockGst.getRegistration.mockResolvedValue(UNREGISTERED);
    mockGst.taxLines.mockReturnValue([{ label: "GST (18%)", amount: 0 }]);
    mockBuilder.gstBlock.mockReturnValue({ registered: false });
    // Fresh each time: the issuer stamps the number onto what the builder
    // returned, and a shared object would carry it between cases.
    mockBuilder.buildForGroup.mockImplementation(async () => ({
      ...built,
      data: { ...built.data },
    }));
    mockPrisma.payment_installments.findUnique.mockResolvedValue({
      booking_id: "b1",
      cycle_number: 1,
    });
    settledGroup();
    mockPrisma.invoices.findFirst.mockResolvedValue(null);
    mockConfig.paymentDetails.mockReturnValue({ reference: "ref" });
    mockNumbers.next.mockResolvedValue("KL-2026-0001");
    mockPrisma.invoices.create.mockResolvedValue({ id: "inv-1", number: "KL-2026-0001" });
    mockPrisma.invoice_lines.createMany.mockResolvedValue({ count: 1 });
  });

  describe("issueForBillingGroup", () => {
    it("freezes the rendered document alongside the numbers", async () => {
      await service.issueForInstallment("inst-1");

      const written = mockPrisma.invoices.create.mock.calls[0][0].data;
      // The document is assembled before its number is allocated, so the number
      // has to be stamped onto the snapshot — in both places it appears.
      expect(written.snapshot).toMatchObject({
        invoiceNumber: "KL-2026-0001",
        payment: { reference: "ref" },
      });
      expect(written.number).toBe("KL-2026-0001");
      expect(written.total_amount).toBe(15000);
      // The number the whole redesign exists to record: what this money bought.
      expect(mockPrisma.invoice_lines.createMany.mock.calls[0][0].data[0].sessions_covered).toBe(10);
    });

    it("holds until every instalment in the cycle is captured", async () => {
      // A split cycle's advance must not raise an invoice on its own: the
      // document covers the whole cycle, matching fee included, and one issued
      // at half the amount would either understate it or have to grow later.
      settledGroup([
        { id: "inst-1", status: "paid", cycle_number: 1, kind: "cycle" },
        { id: "inst-2", status: "pending", cycle_number: 1, kind: "cycle" },
      ]);

      const result = await service.issueForInstallment("inst-1");

      expect(result).toBeNull();
      expect(mockPrisma.invoices.create).not.toHaveBeenCalled();
      expect(mockNumbers.next).not.toHaveBeenCalled();
    });

    it("bills the matching fee through cycle 1 rather than on its own", async () => {
      // Cycle 0 is not a cycle: the fee is carved out of cycle 1, so it resolves
      // to that group and lands on that document.
      mockPrisma.payment_installments.findUnique.mockResolvedValue({
        booking_id: "b1",
        cycle_number: 0,
      });

      await service.issueForInstallment("inst-fee");

      expect(mockBuilder.buildForGroup).toHaveBeenCalledWith(
        "b1",
        1,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("does not issue a second invoice for a group already invoiced", async () => {
      // Razorpay delivers `payment.captured` after `api:verify_payment` has
      // already run the same capture. A second document would be a second entry
      // in the books for money that arrived once.
      mockPrisma.invoices.findFirst.mockResolvedValue({
        id: "inv-1",
        number: "KL-2026-0001",
      });

      const result = await service.issueForInstallment("inst-1");

      expect(result).toEqual({ id: "inv-1", number: "KL-2026-0001" });
      expect(mockPrisma.invoices.create).not.toHaveBeenCalled();
      expect(mockNumbers.next).not.toHaveBeenCalled();
    });

    it("issues a stranded matching fee alone when forced", async () => {
      // A fee paid on a booking whose first cycle never opened belongs to a
      // group that will never complete. Past the grace period the reconciliation
      // sweep bills it on its own rather than leaving money undocumented.
      settledGroup([
        { id: "inst-fee", status: "paid", cycle_number: 0, kind: "matching_fee" },
      ]);

      const result = await service.issueForBillingGroup(
        "b1",
        1,
        mockPrisma as never,
        new Date("2026-09-04"),
        { force: true },
      );

      expect(result).not.toBeNull();
      expect(mockPrisma.invoices.create).toHaveBeenCalled();
    });

    it("records whether registration was in force at the moment of issue", async () => {
      mockGst.getRegistration.mockResolvedValue({
        ...UNREGISTERED,
        enabled: true,
        gstin: "27AAAAA0000A1Z5",
      });

      await service.issueForInstallment("inst-1");

      // Frozen, so enabling registration later cannot turn last quarter's
      // receipts into tax invoices retrospectively.
      expect(mockPrisma.invoices.create.mock.calls[0][0].data.gst_registered).toBe(true);
    });
  });

  describe("issueCreditNote", () => {
    const invoice = {
      id: "inv-1",
      number: "KL-2026-0001",
      booking_id: "b1",
      parent_id: "parent-1",
      issued_at: new Date("2026-09-01"),
      subtotal_amount: 12712,
      gst_amount: 2288,
      total_amount: 15000,
      credited_amount: 0,
      gst_registered: false,
      snapshot: { invoiceNumber: "KL-2026-0001" },
    };

    beforeEach(() => {
      mockNumbers.next.mockResolvedValue("KL-CN-2026-0001");
      mockPrisma.credit_notes.create.mockResolvedValue({
        id: "cn-1",
        number: "KL-CN-2026-0001",
      });
    });

    it("splits the credit across tax and pre-tax in the invoice's own ratio", async () => {
      // A partial credit must not reclaim more or less GST than the share of the
      // supply it reverses.
      mockPrisma.invoices.findUnique.mockResolvedValue(invoice);

      await service.issueCreditNote({
        invoiceId: "inv-1",
        reason: "refund",
        settlement: "refunded",
        amount: 7500,
      });

      const written = mockPrisma.credit_notes.create.mock.calls[0][0].data;
      expect(written.total_amount).toBe(7500);
      expect(written.gst_amount).toBe(1144);
      expect(written.subtotal_amount).toBe(6356);
      expect(written.gst_amount + written.subtotal_amount).toBe(7500);
    });

    it("credits whatever is left when no amount is named", async () => {
      mockPrisma.invoices.findUnique.mockResolvedValue({
        ...invoice,
        credited_amount: 5000,
      });

      const note = await service.issueCreditNote({
        invoiceId: "inv-1",
        reason: "correction",
        settlement: "written_off",
      });

      expect(note.amount).toBe(10000);
    });

    it("will not credit an invoice past its own value", async () => {
      mockPrisma.invoices.findUnique.mockResolvedValue({
        ...invoice,
        credited_amount: 15000,
      });

      await expect(
        service.issueCreditNote({
          invoiceId: "inv-1",
          reason: "refund",
          settlement: "refunded",
        }),
      ).rejects.toThrow(/nothing left to credit/);
    });

    it("keeps a running total on the invoice rather than aggregating notes", async () => {
      mockPrisma.invoices.findUnique.mockResolvedValue({
        ...invoice,
        credited_amount: 2000,
      });

      await service.issueCreditNote({
        invoiceId: "inv-1",
        reason: "refund",
        settlement: "refunded",
        amount: 3000,
      });

      expect(mockPrisma.invoices.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "inv-1" },
          data: expect.objectContaining({ credited_amount: 5000 }),
        }),
      );
    });

    it("references the invoice it reduces, as section 34 requires", async () => {
      mockPrisma.invoices.findUnique.mockResolvedValue(invoice);

      await service.issueCreditNote({
        invoiceId: "inv-1",
        reason: "refund",
        settlement: "refunded",
        amount: 1000,
      });

      const snapshot = mockPrisma.credit_notes.create.mock.calls[0][0].data
        .snapshot as InvoiceData;
      expect(snapshot.documentTitle).toBe("Credit Note");
      expect(snapshot.reference).toEqual(
        expect.objectContaining({ number: "KL-2026-0001" }),
      );
    });
  });

  describe("issueSettlement", () => {
    const input = {
      planId: "plan-1",
      parentId: "parent-1",
      cancelledAt: new Date("2026-09-15"),
      reason: "Parent cancelled",
      entitlement: {
        sessionsEntitled: 10,
        sessionsDelivered: 3,
        sessionsRemaining: 7,
        cycles: [],
      },
      retainedBookingIds: ["b1", "b2", "b3", "b4", "b5", "b6", "b7"],
      amounts: { billed: 30000, paid: 15000, voided: 15000, stillOwed: 0, matchingFeeRetained: 249 },
    };

    it("returns the existing statement rather than issuing a second one", async () => {
      // Cancellation is idempotent — a retry after a dropped response must get
      // the same statement, not a second one with a different number.
      mockPrisma.plan_settlements.findUnique.mockResolvedValue({
        id: "s-1",
        number: "KL-ST-2026-0001",
      });

      const result = await service.issueSettlement(input);

      expect(result).toEqual({ id: "s-1", number: "KL-ST-2026-0001" });
      expect(mockPrisma.plan_settlements.create).not.toHaveBeenCalled();
      expect(mockNumbers.next).not.toHaveBeenCalled();
    });

    it("freezes the per-cycle working and the retained dates", async () => {
      mockPrisma.plan_settlements.findUnique.mockResolvedValue(null);
      mockNumbers.next.mockResolvedValue("KL-ST-2026-0001");
      mockSettlements.build.mockResolvedValue({ settlementNumber: "KL-ST-2026-0001" });
      mockPrisma.plan_settlements.create.mockResolvedValue({
        id: "s-1",
        number: "KL-ST-2026-0001",
      });

      await service.issueSettlement(input);

      const written = mockPrisma.plan_settlements.create.mock.calls[0][0].data;
      expect(written.sessions_retained).toBe(7);
      expect(written.retained_booking_ids).toHaveLength(7);
      expect(written.matching_fee_retained).toBe(249);
    });
  });
});
