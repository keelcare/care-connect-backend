import { Test, TestingModule } from "@nestjs/testing";
import { InvoiceNumberService } from "./invoice-number.service";
import { InvoiceConfig } from "./invoice.config";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Numbering moved off a global Postgres sequence onto a per-series, per-financial
 * -year counter. GST wants a serial that is unique and consecutive within a
 * financial year, credit notes need their own series, and a counter incremented
 * inside the issuing transaction rolls back with it rather than leaving a hole.
 */
describe("InvoiceNumberService", () => {
  let service: InvoiceNumberService;

  const mockPrisma = {
    $queryRaw: jest.fn(),
    bookings: { findUnique: jest.fn() },
    payment_installments: { findFirst: jest.fn() },
  };

  /** The counter row hands back the value this caller won. */
  const allocates = (value: number) =>
    mockPrisma.$queryRaw.mockResolvedValue([{ next_value: value }]);

  /** The year the counter row was keyed on, as passed into the raw query. */
  const seriesYearUsed = () => mockPrisma.$queryRaw.mock.calls[0][2];
  const seriesKindUsed = () => mockPrisma.$queryRaw.mock.calls[0][1];

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoiceNumberService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: InvoiceConfig, useValue: { invoicePrefix: "KL" } },
      ],
    }).compile();
    service = module.get(InvoiceNumberService);
  });

  it("formats an invoice number as the existing series reads", async () => {
    allocates(7);
    const number = await service.next("invoice", new Date("2026-08-14"), false);
    expect(number).toBe("KL-2026-0007");
  });

  it("gives credit notes and settlements their own visible series", async () => {
    allocates(1);
    expect(await service.next("credit_note", new Date("2026-08-14"), false)).toBe(
      "KL-CN-2026-0001",
    );

    jest.clearAllMocks();
    allocates(1);
    expect(await service.next("settlement", new Date("2026-08-14"), false)).toBe(
      "KL-ST-2026-0001",
    );
  });

  it("counts by calendar year while unregistered", async () => {
    // Every number already issued reads as a calendar year; switching the basis
    // for an unregistered platform would renumber for no reason.
    allocates(1);
    await service.next("invoice", new Date("2026-02-10"), false);
    expect(seriesYearUsed()).toBe(2026);
  });

  it("counts by financial year once registered", async () => {
    // A February invoice belongs to the year that began the previous April.
    allocates(1);
    await service.next("invoice", new Date("2026-02-10"), true);
    expect(seriesYearUsed()).toBe(2025);
  });

  it("starts the new financial year in April, not January", async () => {
    allocates(1);
    await service.next("invoice", new Date("2026-04-01T06:00:00+05:30"), true);
    expect(seriesYearUsed()).toBe(2026);
  });

  it("draws each series from its own counter", async () => {
    allocates(3);
    await service.next("credit_note", new Date("2026-08-14"), false);
    expect(seriesKindUsed()).toBe("credit_note");
  });

  describe("legacyNumberForBooking", () => {
    it("adopts the booking's own number when it has one", async () => {
      const issuedAt = new Date("2026-08-01");
      mockPrisma.bookings.findUnique.mockResolvedValue({
        invoice_number: "KL-2026-0003",
        invoice_issued_at: issuedAt,
      });

      expect(await service.legacyNumberForBooking("b1")).toEqual({
        invoiceNumber: "KL-2026-0003",
        issuedAt,
      });
      expect(mockPrisma.payment_installments.findFirst).not.toHaveBeenCalled();
    });

    it("falls back to the oldest per-instalment number from before the change", async () => {
      // Those numbers are on documents families already hold, and quite possibly
      // on a bank transfer reference.
      const issuedAt = new Date("2026-07-01");
      mockPrisma.bookings.findUnique.mockResolvedValue({
        invoice_number: null,
        invoice_issued_at: null,
      });
      mockPrisma.payment_installments.findFirst.mockResolvedValue({
        invoice_number: "KL-2026-0001",
        invoice_issued_at: issuedAt,
      });

      expect(await service.legacyNumberForBooking("b1")).toEqual({
        invoiceNumber: "KL-2026-0001",
        issuedAt,
      });
    });

    it("is null for a booking that never had one", async () => {
      mockPrisma.bookings.findUnique.mockResolvedValue({
        invoice_number: null,
        invoice_issued_at: null,
      });
      mockPrisma.payment_installments.findFirst.mockResolvedValue(null);

      expect(await service.legacyNumberForBooking("b1")).toBeNull();
    });
  });
});
