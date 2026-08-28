// `PdfService` imports puppeteer, which cannot load under jest; this spec never
// renders a PDF, so the module is stubbed out before anything pulls it in.
jest.mock("./pdf.service", () => ({ PdfService: class PdfService {} }));

import { Test, TestingModule } from "@nestjs/testing";
import { InvoicesService } from "./invoices.service";
import { InvoiceDataBuilder } from "./invoice-data.builder";
import { PdfService } from "./pdf.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * The parent-facing document list, tested where its rows are shaped.
 *
 * `statementForBooking` filters a plan's documents on `planId`, so any kind of
 * row that fails to carry its plan id silently vanishes from the statement — the
 * exact bug that dropped every credit note from a plan's statement while its
 * amount still counted in `credited`.
 */
describe("InvoicesService", () => {
  let service: InvoicesService;

  const mockPrisma: Record<string, any> = {
    invoices: { findMany: jest.fn() },
    credit_notes: { findMany: jest.fn() },
    plan_settlements: { findMany: jest.fn() },
    bookings: { findMany: jest.fn(), findUnique: jest.fn() },
    payment_installments: { findMany: jest.fn(), findFirst: jest.fn() },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: InvoiceDataBuilder, useValue: { buildProforma: jest.fn() } },
        { provide: PdfService, useValue: { render: jest.fn() } },
      ],
    }).compile();
    service = module.get(InvoicesService);

    mockPrisma.invoices.findMany.mockResolvedValue([]);
    mockPrisma.credit_notes.findMany.mockResolvedValue([]);
    mockPrisma.plan_settlements.findMany.mockResolvedValue([]);
    mockPrisma.bookings.findMany.mockResolvedValue([]);
  });

  describe("listForParent", () => {
    it("carries the plan id of the invoice a credit note reduces", async () => {
      // Without this, a plan's statement — which filters documents on planId —
      // showed a credited total with no credit note behind it.
      mockPrisma.credit_notes.findMany.mockResolvedValue([
        {
          id: "cn-1",
          number: "KL-CN-2026-0001",
          booking_id: "b1",
          reason: "refund",
          issued_at: new Date("2026-08-01"),
          total_amount: 5000,
          invoices: { plan_id: "plan-1" },
        },
      ]);

      const rows = await service.listForParent("parent-1");

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "credit_note",
        planId: "plan-1",
        negative: true,
      });
    });

    it("leaves planId null on a standalone booking's credit note", async () => {
      mockPrisma.credit_notes.findMany.mockResolvedValue([
        {
          id: "cn-2",
          number: "KL-CN-2026-0002",
          booking_id: "b2",
          reason: "correction",
          issued_at: new Date("2026-08-02"),
          total_amount: 100,
          invoices: { plan_id: null },
        },
      ]);

      const rows = await service.listForParent("parent-1");

      expect(rows[0].planId).toBeNull();
    });
  });
});
