import { Test, TestingModule } from "@nestjs/testing";
import { InvoiceDataBuilder } from "./invoice-data.builder";
import { InvoiceConfig } from "./invoice.config";
import { GstConfigService } from "./gst.config";
import { PrismaService } from "../prisma/prisma.service";

/**
 * What a plan's invoice actually says.
 *
 * Two things are pinned here. First, that periods are the natural months billing
 * uses — the builder used to walk flat 28-day blocks from `booking.start_time`
 * while `pricing.utils` used months anchored on `plan.start_date`, so a plan
 * starting 4 September was billed for 4 Sep – 3 Oct and told its invoice covered
 * 4 Sep – 1 Oct, drifting further every cycle. Second, that a line says how many
 * sessions its money bought, which is the question the whole redesign exists to
 * answer for a parent paying 50% of a month up front.
 */
describe("InvoiceDataBuilder", () => {
  let builder: InvoiceDataBuilder;

  const mockPrisma = {
    bookings: { findUnique: jest.fn() },
    payment_installments: { findUnique: jest.fn() },
  };

  const UNREGISTERED = {
    enabled: false,
    gstin: "",
    legalName: "",
    tradeName: "",
    placeOfSupplyStateCode: "",
    placeOfSupplyName: "",
    supplierStateCode: "",
    defaultSacCode: "999599",
  };

  const mockGst = {
    getRegistration: jest.fn().mockResolvedValue(UNREGISTERED),
    taxLines: jest.fn((_r: unknown, percent: number, amount: number) => [
      { label: `GST (${percent}%)`, amount },
    ]),
    isInterState: jest.fn(() => false),
  };

  const mockConfig = {
    company: { name: "Keel", tagline: "", addressLine: "", contactLine: "", supportEmail: "" },
    paymentDetails: jest.fn(() => ({ reference: "ref" })),
  };

  /** Weekdays from 4 Sep 2026: cycle 1 is 4 Sep – 3 Oct, which holds 22 of them. */
  const PLAN = {
    start_date: new Date("2026-09-04T00:00:00Z"),
    plan_duration_months: 6,
    plan_type: "SIX_MONTH",
    recurrence_type: "WEEKLY",
    recurrence_pattern: { days: ["Mon", "Tue", "Wed", "Thu", "Fri"] },
    duration_hours: 4,
    days_per_week: 5,
  };

  const snapshot = { gst_percent_used: 18, final_amount: 30000 };

  /** A cycle split 50/50, as every plan cycle is. */
  const instalment = (no: number, over: Record<string, unknown> = {}) => ({
    id: `inst-${no}`,
    kind: "cycle",
    cycle_number: 1,
    installment_no: no,
    total_installments: 2,
    amount: 15000,
    subtotal_amount: 12712,
    gst_amount: 2288,
    status: no === 1 ? "paid" : "pending",
    paid_at: no === 1 ? new Date("2026-09-04") : null,
    due_date: no === 1 ? null : new Date("2026-09-18"),
    price_snapshot_id: "snap-1",
    price_snapshots: snapshot,
    ...over,
  });

  const booking = (over: Record<string, unknown> = {}) => ({
    id: "anchor-1",
    parent_id: "parent-1",
    recurring_request_id: "plan-1",
    start_time: new Date("2026-09-04T09:00:00Z"),
    end_time: new Date("2026-09-04T13:00:00Z"),
    created_at: new Date("2026-08-20"),
    hours_per_day: 4,
    days_per_week: 5,
    plan_duration_months: 6,
    invoice_number: null,
    payment_installments: [instalment(1), instalment(2)],
    service_requests: null,
    recurring_service_requests: PLAN,
    booking_children: [],
    users_bookings_parent_idTousers: { id: "parent-1", email: "a@b.com", profiles: null, addresses: [] },
    users_bookings_nanny_idTousers: null,
    ...over,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockGst.getRegistration.mockResolvedValue(UNREGISTERED);
    mockGst.taxLines.mockImplementation((_r: unknown, percent: number, amount: number) => [
      { label: `GST (${percent}%)`, amount },
    ]);
    mockGst.isInterState.mockReturnValue(false);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoiceDataBuilder,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: InvoiceConfig, useValue: mockConfig },
        { provide: GstConfigService, useValue: mockGst },
      ],
    }).compile();
    builder = module.get(InvoiceDataBuilder);
  });

  describe("buildForInstallment", () => {
    beforeEach(() => {
      mockPrisma.payment_installments.findUnique.mockResolvedValue({ booking_id: "anchor-1" });
      mockPrisma.bookings.findUnique.mockResolvedValue(booking());
    });

    it("states how many sessions the money bought", async () => {
      const built = await builder.buildForInstallment(
        "inst-1",
        "KL-2026-0001",
        new Date("2026-09-04"),
        UNREGISTERED,
      );

      // 4 Sep – 3 Oct holds 21 weekdays. The advance buys the first 10 of them;
      // the odd session goes to whoever pays last, so the halves sum to 21.
      expect(built.data.items[0].description).toContain(
        "Covers 10 of 21 scheduled sessions in this cycle",
      );
      expect(built.lines[0].sessionsCovered).toBe(10);
    });

    it("uses the natural month billing uses, not a flat 28 days", async () => {
      const built = await builder.buildForInstallment(
        "inst-1",
        "KL-2026-0001",
        new Date("2026-09-04"),
        UNREGISTERED,
      );

      // 4 Sep – 3 Oct. A 28-day block from the booking start would have said 1 Oct.
      expect(built.data.items[0].description).toContain("4 Sept – 3 October 2026");
      expect(built.periodTo?.toISOString().slice(0, 10)).toBe("2026-10-03");
    });

    it("splits an odd session count without promising one twice", async () => {
      // 21 sessions halved rounds to 11 and 11 — 22 sessions' worth of promise
      // for 21 sessions' money. The running floor makes the parts sum to the whole.
      mockPrisma.bookings.findUnique.mockResolvedValue(
        booking({
          recurring_service_requests: {
            ...PLAN,
            recurrence_pattern: { days: ["Mon", "Wed", "Fri"] },
          },
        }),
      );

      const first = await builder.buildForInstallment(
        "inst-1", "KL-2026-0001", new Date("2026-09-04"), UNREGISTERED,
      );
      const second = await builder.buildForInstallment(
        "inst-2", "KL-2026-0002", new Date("2026-09-18"), UNREGISTERED,
      );

      const total =
        (first.lines[0].sessionsCovered ?? 0) + (second.lines[0].sessionsCovered ?? 0);
      const inCycle = Number(
        /of (\d+) scheduled/.exec(first.data.items[0].description)?.[1],
      );
      expect(total).toBe(inCycle);
    });

    it("is a receipt, because it only exists once the money arrived", async () => {
      const built = await builder.buildForInstallment(
        "inst-1", "KL-2026-0001", new Date("2026-09-04"), UNREGISTERED,
      );

      expect(built.data.paid).toBe(true);
      expect(built.data.grandTotal.label).toBe("Total paid");
      expect(built.data.isProforma).toBe(false);
    });

    it("covers only its own instalment, not the whole cycle", async () => {
      // The failure this design removes: a document that grows as later
      // instalments are billed against the same booking.
      const built = await builder.buildForInstallment(
        "inst-1", "KL-2026-0001", new Date("2026-09-04"), UNREGISTERED,
      );

      expect(built.data.items).toHaveLength(1);
      expect(built.totalAmount).toBe(15000);
    });

    it("titles itself a tax invoice only once registered", async () => {
      const registered = { ...UNREGISTERED, enabled: true, gstin: "27AAAAA0000A1Z5" };
      const built = await builder.buildForInstallment(
        "inst-1", "KL-2026-0001", new Date("2026-09-04"), registered,
      );

      expect(built.data.documentTitle).toBe("Tax Invoice");
      expect(built.lines[0].sacCode).toBe("999599");
    });

    it("does not claim a matching fee bought sessions", async () => {
      // It bought a placement, and is carved out of cycle 1 rather than added on.
      mockPrisma.bookings.findUnique.mockResolvedValue(
        booking({
          payment_installments: [
            instalment(1, {
              id: "inst-fee",
              kind: "matching_fee",
              cycle_number: 0,
              amount: 249,
              subtotal_amount: 211,
              gst_amount: 38,
              total_installments: 1,
              price_snapshot_id: "snap-0",
            }),
          ],
        }),
      );

      const built = await builder.buildForInstallment(
        "inst-fee", "KL-2026-0001", new Date("2026-09-04"), UNREGISTERED,
      );

      expect(built.data.items[0].name).toBe("Matching & placement fee");
      expect(built.lines[0].sessionsCovered).toBeNull();
      expect(built.data.items[0].description).not.toContain("Covers");
    });
  });

  describe("buildProforma", () => {
    beforeEach(() => {
      mockPrisma.bookings.findUnique.mockResolvedValue(booking());
    });

    it("says plainly that it is not a tax invoice", async () => {
      const pro = await builder.buildProforma("anchor-1");

      expect(pro.isProforma).toBe(true);
      expect(pro.documentTitle).toBe("Proforma Invoice");
      expect(pro.notice).toMatch(/not a tax invoice/i);
    });

    it("projects the cycles billing has not opened yet", async () => {
      // On the day a parent signs up only cycle 1 exists as rows. A document
      // showing just that is answering a question nobody asked of a 6-month plan.
      const pro = await builder.buildProforma("anchor-1");

      const scheduled = pro.schedule?.filter((r) => r.status === "Scheduled") ?? [];
      // Cycles 2–6, split in two.
      expect(scheduled).toHaveLength(10);
      expect(pro.hasSchedule).toBe(true);
    });

    it("quotes the whole term, not just what has been billed", async () => {
      const pro = await builder.buildProforma("anchor-1");

      // 6 cycles at ₹30,000.
      expect(pro.facts).toContainEqual({ label: "Plan total", value: "₹ 1,80,000.00" });
    });

    it("counts the sessions the term really contains", async () => {
      const pro = await builder.buildProforma("anchor-1");

      const sessions = pro.facts.find((f) => f.label === "Sessions in term");
      // Off the real calendar, month by month — not `daysPerWeek × 4 × months`.
      expect(Number(sessions?.value)).toBeGreaterThan(120);
    });

    it("shows what is still owed, net of what has been paid", async () => {
      const pro = await builder.buildProforma("anchor-1");

      expect(pro.grandTotal).toEqual({ label: "Balance due", amount: "15,000.00" });
      expect(pro.totals).toContainEqual({
        label: "Already paid",
        amount: "15,000.00",
        negative: true,
      });
    });

    it("never marks a scheduled cycle as due", async () => {
      // Nothing is owed until a cycle is actually opened, and a parent must not
      // be chased for a row that is only a forecast.
      const pro = await builder.buildProforma("anchor-1");

      for (const row of pro.schedule ?? []) {
        if (row.status === "Scheduled") expect(row.due).toBe("—");
      }
    });
  });
});
