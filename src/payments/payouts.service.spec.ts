import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PayoutsService } from "./payouts.service";
import { RazorpayxService } from "./razorpayx.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PricingEngineService } from "../common/pricing.service";
import { AdminAuditService } from "../admin/admin-audit.service";

/**
 * These tests are about money not going missing and not going twice. They lean on
 * the same helpers `RevenueService.getOutstandingPayouts` uses, so a payout that
 * disagreed with the balance a caregiver was shown would fail here first.
 */

const NANNY_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const PAYOUT_ID = "44444444-4444-4444-8444-444444444444";

describe("PayoutsService", () => {
  let service: PayoutsService;

  const mockPrisma: any = {
    payments: { findMany: jest.fn(), updateMany: jest.fn() },
    nanny_payout_accounts: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    nanny_payouts: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    nanny_payout_items: {
      createMany: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest
      .fn()
      .mockImplementation((cb: (tx: any) => any) => cb(mockPrisma)),
  };

  const mockRazorpayx = {
    isConfigured: jest.fn().mockReturnValue(true),
    isEnabled: jest.fn().mockReturnValue(true),
    misconfigured: jest.fn().mockReturnValue(false),
    missingConfig: jest.fn().mockReturnValue("RAZORPAYX_ACCOUNT_NUMBER"),
    payoutMode: "IMPS" as const,
    createContact: jest.fn(),
    createFundAccount: jest.fn(),
    createPayout: jest.fn(),
    fetchPayout: jest.fn(),
    verifyWebhookSignature: jest.fn(),
  };

  const mockNotifications = {
    createNotification: jest.fn().mockResolvedValue(undefined),
  };

  const mockPricing = {
    getCommissionConfig: jest.fn().mockResolvedValue({
      percent: 10,
      configured: true,
    }),
  };

  const mockAudit = { logAction: jest.fn().mockResolvedValue(undefined) };

  /** Two payments: ₹1000 with ₹100 GST, ₹500 with no snapshot. */
  const outstandingPayments = [
    {
      id: "p1",
      amount: new Prisma.Decimal(1100),
      price_snapshots: [{ gst_amount: new Prisma.Decimal(100) }],
      payment_installments: [],
    },
    {
      id: "p2",
      amount: new Prisma.Decimal(500),
      price_snapshots: [],
      payment_installments: [],
    },
  ];

  const activeAccount = {
    id: ACCOUNT_ID,
    nanny_id: NANNY_ID,
    account_type: "bank_account",
    beneficiary_name: "A Caregiver",
    account_number_last4: "4321",
    ifsc: "HDFC0001234",
    vpa_address: null,
    razorpay_contact_id: "cont_1",
    razorpay_fund_account_id: "fa_1",
    status: "active",
    rejection_reason: null,
    created_at: new Date("2026-01-01"),
    reviewed_at: new Date("2026-01-02"),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RazorpayxService, useValue: mockRazorpayx },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: PricingEngineService, useValue: mockPricing },
        { provide: AdminAuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get<PayoutsService>(PayoutsService);

    mockRazorpayx.isConfigured.mockReturnValue(true);
    mockRazorpayx.isEnabled.mockReturnValue(true);
    mockRazorpayx.misconfigured.mockReturnValue(false);
    mockPricing.getCommissionConfig.mockResolvedValue({
      percent: 10,
      configured: true,
    });
  });

  // ─── Amount ────────────────────────────────────────────────────────────────

  describe("releasePayoutForNanny — the amount", () => {
    beforeEach(() => {
      mockPrisma.nanny_payouts.findFirst.mockResolvedValue(null);
      mockPrisma.payments.findMany.mockResolvedValue(outstandingPayments);
      mockPrisma.nanny_payout_accounts.findFirst.mockResolvedValue(activeAccount);
      mockPrisma.nanny_payouts.create.mockImplementation(({ data }: any) => ({
        ...data,
        id: PAYOUT_ID,
        created_at: new Date("2026-02-01"),
        processed_at: null,
        utr: null,
        failure_reason: null,
        razorpay_payout_id: null,
        currency: "INR",
      }));
      mockPrisma.nanny_payouts.update.mockImplementation(({ data }: any) => ({
        ...activePayoutRow(),
        ...data,
      }));
      mockRazorpayx.createPayout.mockResolvedValue({
        id: "pout_1",
        status: "processing",
        mode: "IMPS",
        reference_id: PAYOUT_ID,
        utr: null,
      });
    });

    it("pays the pre-tax service fee less commission, GST excluded", async () => {
      await service.releasePayoutForNanny(NANNY_ID, ADMIN_ID);

      // (1100 - 100) * 0.9 = 900, plus 500 * 0.9 = 450 → 1350
      const created = mockPrisma.nanny_payouts.create.mock.calls[0][0].data;
      expect(Number(created.amount)).toBe(1350);
    });

    it("sends an amount equal to the sum of its items, so it can be reconciled", async () => {
      await service.releasePayoutForNanny(NANNY_ID, ADMIN_ID);

      const created = mockPrisma.nanny_payouts.create.mock.calls[0][0].data;
      const items = mockPrisma.nanny_payout_items.createMany.mock.calls[0][0].data;
      const itemTotal = items.reduce(
        (sum: number, item: any) => sum + Number(item.amount),
        0,
      );

      expect(itemTotal).toBe(Number(created.amount));
      expect(items).toHaveLength(2);
    });

    it("freezes the commission rate on each item", async () => {
      await service.releasePayoutForNanny(NANNY_ID, ADMIN_ID);

      const items = mockPrisma.nanny_payout_items.createMany.mock.calls[0][0].data;
      for (const item of items) {
        expect(Number(item.commission_percent)).toBe(10);
      }
    });

    it("converts to paise for the gateway", async () => {
      await service.releasePayoutForNanny(NANNY_ID, ADMIN_ID);

      expect(mockRazorpayx.createPayout).toHaveBeenCalledWith(
        expect.objectContaining({ amountPaise: 135000 }),
      );
    });

    it("reserves the earnings by stamping released_at", async () => {
      await service.releasePayoutForNanny(NANNY_ID, ADMIN_ID);

      expect(mockPrisma.payments.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ["p1", "p2"] } },
          data: expect.objectContaining({ released_by: ADMIN_ID }),
        }),
      );
    });
  });

  // ─── Refusals ──────────────────────────────────────────────────────────────

  describe("releasePayoutForNanny — refusals", () => {
    it("refuses while another payout is still in flight", async () => {
      mockPrisma.nanny_payouts.findFirst.mockResolvedValue({
        id: "other",
        status: "processing",
        amount: new Prisma.Decimal(500),
      });

      await expect(
        service.releasePayoutForNanny(NANNY_ID, ADMIN_ID),
      ).rejects.toThrow(ConflictException);

      expect(mockRazorpayx.createPayout).not.toHaveBeenCalled();
    });

    it("refuses when the caregiver has no approved payout account", async () => {
      mockPrisma.nanny_payouts.findFirst.mockResolvedValue(null);
      mockPrisma.payments.findMany.mockResolvedValue(outstandingPayments);
      mockPrisma.nanny_payout_accounts.findFirst.mockResolvedValue(null);

      await expect(
        service.releasePayoutForNanny(NANNY_ID, ADMIN_ID),
      ).rejects.toThrow(BadRequestException);

      expect(mockPrisma.nanny_payouts.create).not.toHaveBeenCalled();
    });

    it("refuses when there is nothing outstanding", async () => {
      mockPrisma.nanny_payouts.findFirst.mockResolvedValue(null);
      mockPrisma.payments.findMany.mockResolvedValue([]);

      await expect(
        service.releasePayoutForNanny(NANNY_ID, ADMIN_ID),
      ).rejects.toThrow(/No outstanding payouts/);
    });

    it("turns a claimed-payment collision into a conflict rather than a double pay", async () => {
      mockPrisma.nanny_payouts.findFirst.mockResolvedValue(null);
      mockPrisma.payments.findMany.mockResolvedValue(outstandingPayments);
      mockPrisma.nanny_payout_accounts.findFirst.mockResolvedValue(activeAccount);
      mockPrisma.$transaction.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002",
          clientVersion: "6",
        }),
      );

      await expect(
        service.releasePayoutForNanny(NANNY_ID, ADMIN_ID),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ─── Unwinding ─────────────────────────────────────────────────────────────

  describe("a payout that does not go through", () => {
    beforeEach(() => {
      mockPrisma.nanny_payouts.findFirst.mockResolvedValue(null);
      mockPrisma.payments.findMany.mockResolvedValue(outstandingPayments);
      mockPrisma.nanny_payout_accounts.findFirst.mockResolvedValue(activeAccount);
      mockPrisma.nanny_payouts.create.mockResolvedValue({
        id: PAYOUT_ID,
        amount: new Prisma.Decimal(1350),
      });
      mockPrisma.nanny_payout_items.findMany.mockResolvedValue([
        { payment_id: "p1" },
        { payment_id: "p2" },
      ]);
    });

    it("puts the earnings back on the outstanding list when the gateway rejects it", async () => {
      mockRazorpayx.createPayout.mockRejectedValue(
        new BadRequestException("Insufficient balance"),
      );

      await expect(
        service.releasePayoutForNanny(NANNY_ID, ADMIN_ID),
      ).rejects.toThrow(/Insufficient balance/);

      // released_at cleared → the money is owed again, not silently settled.
      expect(mockPrisma.payments.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { released_at: null, released_by: null },
        }),
      );
    });

    it("voids the items rather than deleting them, keeping the attempt auditable", async () => {
      mockRazorpayx.createPayout.mockRejectedValue(
        new BadRequestException("Beneficiary bank offline"),
      );

      await expect(
        service.releasePayoutForNanny(NANNY_ID, ADMIN_ID),
      ).rejects.toThrow();

      const voidCall = mockPrisma.nanny_payout_items.updateMany.mock.calls[0][0];
      expect(voidCall.where).toEqual({ payout_id: PAYOUT_ID, voided_at: null });
      expect(voidCall.data.voided_at).toBeInstanceOf(Date);
    });
  });

  // ─── Status transitions ────────────────────────────────────────────────────

  describe("applyPayoutStatus", () => {
    it("stamps the UTR and notifies the caregiver when money lands", async () => {
      mockPrisma.nanny_payouts.findUnique.mockResolvedValue({
        id: PAYOUT_ID,
        nanny_id: NANNY_ID,
        status: "processing",
        amount: new Prisma.Decimal(1350),
      });

      const result = await service.applyPayoutStatus(PAYOUT_ID, {
        status: "processed",
        utr: "UTR123",
        fees: 590,
        tax: 90,
        mode: "IMPS",
        failure_reason: null,
        status_details: null,
      });

      expect(result.applied).toBe(true);
      const update = mockPrisma.nanny_payouts.update.mock.calls[0][0].data;
      expect(update.utr).toBe("UTR123");
      // Paise on the wire, rupees in the ledger.
      expect(Number(update.fees)).toBe(5.9);
      expect(Number(update.tax)).toBe(0.9);
      expect(mockNotifications.createNotification).toHaveBeenCalled();
    });

    it("is a no-op on a replayed terminal status, so nobody is notified twice", async () => {
      mockPrisma.nanny_payouts.findUnique.mockResolvedValue({
        id: PAYOUT_ID,
        nanny_id: NANNY_ID,
        status: "processed",
        amount: new Prisma.Decimal(1350),
      });

      const result = await service.applyPayoutStatus(PAYOUT_ID, {
        status: "processed",
        utr: "UTR123",
        fees: null,
        tax: null,
        mode: "IMPS",
        failure_reason: null,
        status_details: null,
      });

      expect(result.applied).toBe(false);
      expect(result.reason).toBe("already_terminal");
      expect(mockPrisma.nanny_payouts.update).not.toHaveBeenCalled();
      expect(mockNotifications.createNotification).not.toHaveBeenCalled();
    });

    it("cannot undo a failure with a late-arriving in-flight status", async () => {
      mockPrisma.nanny_payouts.findUnique.mockResolvedValue({
        id: PAYOUT_ID,
        nanny_id: NANNY_ID,
        status: "failed",
        amount: new Prisma.Decimal(1350),
      });

      const result = await service.applyPayoutStatus(PAYOUT_ID, {
        status: "processing",
        utr: null,
        fees: null,
        tax: null,
        mode: "IMPS",
        failure_reason: null,
        status_details: null,
      });

      expect(result.applied).toBe(false);
      expect(mockPrisma.nanny_payouts.update).not.toHaveBeenCalled();
    });

    it("unwinds a reversal so the earnings become outstanding again", async () => {
      mockPrisma.nanny_payouts.findUnique.mockResolvedValue({
        id: PAYOUT_ID,
        nanny_id: NANNY_ID,
        status: "processing",
        amount: new Prisma.Decimal(1350),
      });
      mockPrisma.nanny_payout_items.findMany.mockResolvedValue([
        { payment_id: "p1" },
      ]);

      await service.applyPayoutStatus(PAYOUT_ID, {
        status: "reversed",
        utr: null,
        fees: null,
        tax: null,
        mode: "IMPS",
        failure_reason: "Account closed",
        status_details: null,
      });

      expect(mockPrisma.payments.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { released_at: null, released_by: null },
        }),
      );
      expect(mockNotifications.createNotification).toHaveBeenCalledWith(
        NANNY_ID,
        expect.stringContaining("could not be completed"),
        expect.stringContaining("Account closed"),
        "error",
        "payout",
      );
    });
  });

  // ─── Manual settlement ─────────────────────────────────────────────────────

  describe("manual settlement", () => {
    beforeEach(() => {
      mockPrisma.nanny_payouts.findFirst.mockResolvedValue(null);
      mockPrisma.payments.findMany.mockResolvedValue(outstandingPayments);
      mockPrisma.nanny_payout_accounts.findFirst.mockResolvedValue(activeAccount);
      mockPrisma.nanny_payouts.create.mockResolvedValue({
        id: PAYOUT_ID,
        amount: new Prisma.Decimal(1350),
      });
      mockPrisma.nanny_payouts.update.mockResolvedValue(activePayoutRow());
    });

    it("records without calling the gateway when RazorpayX is switched off", async () => {
      mockRazorpayx.isEnabled.mockReturnValue(false);

      const payout = await service.releasePayoutForNanny(NANNY_ID, ADMIN_ID);

      expect(mockRazorpayx.createPayout).not.toHaveBeenCalled();
      expect(payout.status).toBe("processed");
      const created = mockPrisma.nanny_payouts.create.mock.calls[0][0].data;
      expect(created.provider).toBe("manual");
    });

    it("does not need an approved account, since no money moves through us", async () => {
      mockRazorpayx.isEnabled.mockReturnValue(false);
      mockPrisma.nanny_payout_accounts.findFirst.mockResolvedValue(null);

      await expect(
        service.releasePayoutForNanny(NANNY_ID, ADMIN_ID, { manual: true }),
      ).resolves.toBeDefined();
    });

    it("refuses rather than settling manually when RazorpayX is half-configured", async () => {
      // The dangerous case: RAZORPAYX_ENABLED=true with no account number. Quietly
      // recording a manual payout would mark these earnings paid with nothing
      // behind them, which is the exact outcome this feature exists to prevent.
      mockRazorpayx.isEnabled.mockReturnValue(false);
      mockRazorpayx.misconfigured.mockReturnValue(true);

      await expect(
        service.releasePayoutForNanny(NANNY_ID, ADMIN_ID),
      ).rejects.toThrow(/not fully configured/);

      expect(mockPrisma.nanny_payouts.create).not.toHaveBeenCalled();
      expect(mockPrisma.payments.updateMany).not.toHaveBeenCalled();
    });

    it("still allows an explicit manual settlement while half-configured", async () => {
      mockRazorpayx.isEnabled.mockReturnValue(false);
      mockRazorpayx.misconfigured.mockReturnValue(true);

      await expect(
        service.releasePayoutForNanny(NANNY_ID, ADMIN_ID, { manual: true }),
      ).resolves.toBeDefined();
    });
  });

  // ─── Account review ────────────────────────────────────────────────────────

  describe("submitPayoutAccount", () => {
    beforeEach(() => {
      mockPrisma.nanny_payout_accounts.create.mockImplementation(({ data }: any) => ({
        ...data,
        id: ACCOUNT_ID,
        account_number_last4: data.account_number_last4 ?? null,
        ifsc: data.ifsc ?? null,
        vpa_address: data.vpa_address ?? null,
        razorpay_fund_account_id: null,
        rejection_reason: null,
        created_at: new Date(),
        reviewed_at: null,
      }));
    });

    it("stores only the last four digits, never the account number", async () => {
      await service.submitPayoutAccount(NANNY_ID, {
        accountType: "bank_account",
        beneficiaryName: "A Caregiver",
        accountNumber: "123456784321",
        confirmAccountNumber: "123456784321",
        ifsc: "hdfc0001234",
      });

      const written = mockPrisma.nanny_payout_accounts.create.mock.calls[0][0].data;
      expect(written.account_number_last4).toBe("4321");
      expect(JSON.stringify(written)).not.toContain("123456784321");
      // IFSC is normalised, since banks print it either way.
      expect(written.ifsc).toBe("HDFC0001234");
    });

    it("rejects a mistyped confirmation before it can reach a stranger's account", async () => {
      await expect(
        service.submitPayoutAccount(NANNY_ID, {
          accountType: "bank_account",
          beneficiaryName: "A Caregiver",
          accountNumber: "123456784321",
          confirmAccountNumber: "123456781234",
          ifsc: "HDFC0001234",
        }),
      ).rejects.toThrow(/do not match/);
    });

    it("rejects a malformed IFSC", async () => {
      await expect(
        service.submitPayoutAccount(NANNY_ID, {
          accountType: "bank_account",
          beneficiaryName: "A Caregiver",
          accountNumber: "123456784321",
          confirmAccountNumber: "123456784321",
          ifsc: "NOTANIFSC",
        }),
      ).rejects.toThrow(/IFSC/);
    });

    it("leaves an active account alone so a rejected change cannot strand her", async () => {
      await service.submitPayoutAccount(NANNY_ID, {
        accountType: "vpa",
        beneficiaryName: "A Caregiver",
        vpaAddress: "caregiver@okbank",
      });

      const archived =
        mockPrisma.nanny_payout_accounts.updateMany.mock.calls[0][0];
      expect(archived.where.status.in).toEqual(["pending_review", "rejected"]);
      expect(archived.where.status.in).not.toContain("active");
    });
  });

  describe("approvePayoutAccount", () => {
    const pendingAccount = {
      ...activeAccount,
      status: "pending_review",
      razorpay_contact_id: null,
      razorpay_fund_account_id: null,
      nanny: {
        id: NANNY_ID,
        email: "caregiver@example.com",
        profiles: { first_name: "A", last_name: "Caregiver", phone: "9000000000" },
      },
    };

    beforeEach(() => {
      mockPrisma.nanny_payout_accounts.findUnique.mockResolvedValue(pendingAccount);
      mockPrisma.nanny_payout_accounts.update.mockImplementation(({ data }: any) => ({
        ...pendingAccount,
        ...data,
      }));
      mockRazorpayx.createContact.mockResolvedValue("cont_new");
      mockRazorpayx.createFundAccount.mockResolvedValue("fa_new");
    });

    it("creates the fund account with the re-keyed number and activates the row", async () => {
      mockPrisma.nanny_payout_accounts.findFirst.mockResolvedValue(null);

      await service.approvePayoutAccount(ACCOUNT_ID, ADMIN_ID, "123456784321");

      expect(mockRazorpayx.createFundAccount).toHaveBeenCalledWith("cont_new", {
        type: "bank_account",
        bank: expect.objectContaining({ accountNumber: "123456784321" }),
      });
      const update = mockPrisma.nanny_payout_accounts.update.mock.calls[0][0].data;
      expect(update.status).toBe("active");
      expect(update.razorpay_fund_account_id).toBe("fa_new");
    });

    it("reuses an existing contact rather than duplicating the caregiver", async () => {
      mockPrisma.nanny_payout_accounts.findFirst.mockResolvedValue({
        razorpay_contact_id: "cont_existing",
      });

      await service.approvePayoutAccount(ACCOUNT_ID, ADMIN_ID, "123456784321");

      expect(mockRazorpayx.createContact).not.toHaveBeenCalled();
      expect(mockRazorpayx.createFundAccount).toHaveBeenCalledWith(
        "cont_existing",
        expect.anything(),
      );
    });

    it("refuses an account number whose last four do not match what she submitted", async () => {
      await expect(
        service.approvePayoutAccount(ACCOUNT_ID, ADMIN_ID, "999999999999"),
      ).rejects.toThrow(/does not match/);

      expect(mockRazorpayx.createFundAccount).not.toHaveBeenCalled();
    });

    it("refuses to approve a bank account without the full number", async () => {
      await expect(
        service.approvePayoutAccount(ACCOUNT_ID, ADMIN_ID, undefined),
      ).rejects.toThrow(/full account number is required/);
    });
  });

  // ─── Webhook routing ───────────────────────────────────────────────────────

  describe("handlePayoutWebhook", () => {
    it("resolves a payout by our own reference when the gateway id has not landed yet", async () => {
      mockPrisma.nanny_payouts.findFirst.mockResolvedValue({
        id: PAYOUT_ID,
        razorpay_payout_id: null,
      });
      mockPrisma.nanny_payouts.findUnique.mockResolvedValue({
        id: PAYOUT_ID,
        nanny_id: NANNY_ID,
        status: "created",
        amount: new Prisma.Decimal(1350),
      });

      const result = await service.handlePayoutWebhook({
        event: "payout.processed",
        payload: {
          payout: {
            entity: {
              id: "pout_1",
              status: "processed",
              reference_id: PAYOUT_ID,
              utr: "UTR999",
            },
          },
        },
      });

      expect(result.status).toBe("processed");
      // Backfilled, so later webhooks resolve directly.
      expect(mockPrisma.nanny_payouts.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { razorpay_payout_id: "pout_1" },
        }),
      );
    });

    it("ignores a webhook for a payout it does not recognise", async () => {
      mockPrisma.nanny_payouts.findFirst.mockResolvedValue(null);

      const result = await service.handlePayoutWebhook({
        event: "payout.processed",
        payload: { payout: { entity: { id: "pout_unknown", status: "processed" } } },
      });

      expect(result.status).toBe("unknown_payout");
    });

    it("ignores a payload with no payout entity", async () => {
      const result = await service.handlePayoutWebhook({ event: "payout.updated" });
      expect(result.status).toBe("ignored");
    });
  });

  // ─── Readiness ─────────────────────────────────────────────────────────────

  describe("payoutReadinessFor", () => {
    it("marks a caregiver un-releasable while a payout is in flight", async () => {
      mockPrisma.nanny_payout_accounts.findMany.mockResolvedValue([activeAccount]);
      mockPrisma.nanny_payouts.findMany.mockResolvedValue([
        { id: "in_flight", nanny_id: NANNY_ID, status: "processing" },
      ]);

      const readiness = await service.payoutReadinessFor([NANNY_ID]);

      expect(readiness.get(NANNY_ID)?.payoutReady).toBe(false);
      expect(readiness.get(NANNY_ID)?.inFlightPayoutId).toBe("in_flight");
    });

    it("is ready with an active account and nothing in flight", async () => {
      mockPrisma.nanny_payout_accounts.findMany.mockResolvedValue([activeAccount]);
      mockPrisma.nanny_payouts.findMany.mockResolvedValue([]);

      const readiness = await service.payoutReadinessFor([NANNY_ID]);

      expect(readiness.get(NANNY_ID)?.payoutReady).toBe(true);
      expect(readiness.get(NANNY_ID)?.payoutAccount?.last4).toBe("4321");
    });

    it("is not ready on an account still awaiting review", async () => {
      mockPrisma.nanny_payout_accounts.findMany.mockResolvedValue([
        { ...activeAccount, status: "pending_review" },
      ]);
      mockPrisma.nanny_payouts.findMany.mockResolvedValue([]);

      const readiness = await service.payoutReadinessFor([NANNY_ID]);

      expect(readiness.get(NANNY_ID)?.payoutReady).toBe(false);
    });
  });
});

function activePayoutRow() {
  return {
    id: PAYOUT_ID,
    amount: new Prisma.Decimal(1350),
    currency: "INR",
    status: "processed",
    provider: "razorpayx",
    mode: "IMPS",
    utr: null,
    failure_reason: null,
    razorpay_payout_id: "pout_1",
    processed_at: new Date("2026-02-01"),
    created_at: new Date("2026-02-01"),
  };
}
