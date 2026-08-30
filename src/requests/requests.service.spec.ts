import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { RequestsService } from "./requests.service";
import { PrismaService } from "../prisma/prisma.service";
import { UsersService } from "../users/users.service";
import { NotificationsService } from "../notifications/notifications.service";
import { FavoritesService } from "../favorites/favorites.service";
import { SseService } from "../sse/sse.service";
import { MailService } from "../mail/mail.service";
import { AvailabilityService } from "../availability/availability.service";
import { PricingEngineService } from "../common/pricing.service";
import { AddressesService } from "../addresses/addresses.service";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { BOOKING_EVENTS } from "../bookings/events/booking.events";

import { PaymentGatewayService } from "../payments/payment-gateway.service";
import { PaymentAuditService } from "../payments/payment-audit.service";
import { DocumentIssuerService } from "../invoices/document-issuer.service";

describe("RequestsService", () => {
  let service: RequestsService;
  let prisma: any;
  let tx: any;
  let notificationsService: any;
  let eventEmitter: any;
  let pricingService: any;
  let paymentGateway: any;
  let paymentAudit: any;
  let documents: any;

  const futureStart = (hours: number) =>
    new Date(Date.now() + hours * 60 * 60 * 1000);

  const baseRequest = {
    id: "req-1",
    parent_id: "parent-1",
    status: "accepted",
    category: "CC",
    assignments: [{ id: "as-1", status: "accepted" }],
    bookings: null as any,
  };

  beforeEach(async () => {
    tx = {
      assignments: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      bookings: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: "bk-1", status: "CANCELLED", nanny_id: "nanny-1", parent_id: "parent-1" }),
        create: jest.fn().mockResolvedValue({ id: "bk-1", status: "requested" }),
      },
      payment_installments: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: "inst-1", amount: 249, status: "paid" }),
      },
      price_snapshots: {
        create: jest.fn().mockResolvedValue({ id: "snap-1" }),
        update: jest.fn().mockResolvedValue({ id: "snap-1" }),
      },
      payments: {
        create: jest.fn().mockResolvedValue({ id: "pay-1", order_id: "ord-1", status: "captured" }),
      },
      booking_children: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      service_requests: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: "req-1", status: "CANCELLED", parent_id: "parent-1" }),
        create: jest.fn().mockResolvedValue({ id: "req-1", status: "pending" }),
      },
    };
    prisma = {
      service_requests: { findUnique: jest.fn() },
      bookings: { findUnique: jest.fn() },
      services: { findUnique: jest.fn().mockResolvedValue({ name: "CC" }) },
      payments: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockImplementation((cb) => cb(tx)),
    };
    notificationsService = { createNotification: jest.fn() };
    eventEmitter = { emit: jest.fn() };
    pricingService = {
      calculateCost: jest
        .fn()
        .mockResolvedValue({ totalAmount: 1000, appliedRate: 500 }),
      getMatchingFeeConfig: jest.fn().mockResolvedValue({ enabled: false, amount: 0 }),
      effectiveGstPercent: jest.fn().mockReturnValue(18),
      raiseMatchingFee: jest.fn().mockResolvedValue(null),
    };
    paymentGateway = {
      verifySignature: jest.fn().mockReturnValue(true),
    };
    paymentAudit = {
      writeLog: jest.fn().mockResolvedValue(undefined),
    };
    documents = {
      issueForInstallment: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RequestsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: UsersService,
          useValue: {
            findOne: jest.fn().mockResolvedValue({
              id: "parent-1",
              profiles: { lat: 12.97, lng: 77.59, first_name: "Test" },
              email: "test@example.com",
            }),
          },
        },
        { provide: NotificationsService, useValue: notificationsService },
        {
          provide: FavoritesService,
          useValue: { getFavoriteNannyIds: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: SseService,
          useValue: { emitToUser: jest.fn(), emitToUsers: jest.fn() },
        },
        { provide: MailService, useValue: { sendPaymentReceiptEmail: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: AvailabilityService,
          useValue: { doesBlockOverlap: jest.fn() },
        },
        { provide: PricingEngineService, useValue: pricingService },
        {
          provide: AddressesService,
          useValue: {
            resolveForUser: jest.fn().mockResolvedValue({
              id: "addr-1",
              lat: 12.97,
              lng: 77.59,
            }),
          },
        },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: PaymentGatewayService, useValue: paymentGateway },
        { provide: PaymentAuditService, useValue: paymentAudit },
        { provide: DocumentIssuerService, useValue: documents },
      ],
    }).compile();

    service = module.get(RequestsService);
  });

  describe("cancelRequest", () => {
    it("voids pending instalments so a cancelled request keeps no collectible balance", async () => {
      prisma.service_requests.findUnique.mockResolvedValue({
        ...baseRequest,
        bookings: {
          id: "bk-1",
          status: "CONFIRMED",
          nanny_id: "nanny-1",
          start_time: futureStart(72),
        },
      });

      await service.cancelRequest("req-1", "parent-1");

      expect(tx.payment_installments.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ booking_id: "bk-1", status: "pending" }),
          data: expect.objectContaining({ status: "void" }),
        }),
      );
    });

    it("emits BOOKING_EVENTS.CANCELLED after commit so the caregiver is notified downstream", async () => {
      prisma.service_requests.findUnique.mockResolvedValue({
        ...baseRequest,
        bookings: {
          id: "bk-1",
          status: "CONFIRMED",
          nanny_id: "nanny-1",
          start_time: futureStart(72),
        },
      });

      await service.cancelRequest("req-1", "parent-1");

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        BOOKING_EVENTS.CANCELLED,
        expect.objectContaining({
          cancelledByUserId: "parent-1",
          reason: "Request cancelled by parent",
        }),
      );
    });

    it("records the <24h cancellation fee as owed, matching cancelBooking's policy", async () => {
      prisma.service_requests.findUnique.mockResolvedValue({
        ...baseRequest,
        bookings: {
          id: "bk-1",
          status: "CONFIRMED",
          nanny_id: "nanny-1",
          start_time: futureStart(3), // inside the fee window
        },
      });

      await service.cancelRequest("req-1", "parent-1");

      expect(pricingService.calculateCost).toHaveBeenCalledWith("CC", 1);
      expect(tx.bookings.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cancellation_fee: 500,
            cancellation_fee_status: "owed",
          }),
        }),
      );
    });

    it("charges no fee when no caregiver was ever attached", async () => {
      prisma.service_requests.findUnique.mockResolvedValue({
        ...baseRequest,
        status: "pending",
        bookings: {
          id: "bk-1",
          status: "requested",
          nanny_id: null,
          start_time: futureStart(3),
        },
      });

      await service.cancelRequest("req-1", "parent-1");

      expect(tx.bookings.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cancellation_fee: 0,
            cancellation_fee_status: "no_fee",
          }),
        }),
      );
    });

    it("refuses to cancel once the session is in progress", async () => {
      prisma.service_requests.findUnique.mockResolvedValue({
        ...baseRequest,
        bookings: {
          id: "bk-1",
          status: "IN_PROGRESS",
          nanny_id: "nanny-1",
          start_time: futureStart(-1),
        },
      });

      await expect(
        service.cancelRequest("req-1", "parent-1"),
      ).rejects.toThrow(/already started/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it("aborts (and emits nothing) when the guarded booking claim loses a race", async () => {
      prisma.service_requests.findUnique.mockResolvedValue({
        ...baseRequest,
        bookings: {
          id: "bk-1",
          status: "CONFIRMED",
          nanny_id: "nanny-1",
          start_time: futureStart(72),
        },
      });
      tx.bookings.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.cancelRequest("req-1", "parent-1"),
      ).rejects.toThrow(BadRequestException);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
      expect(notificationsService.createNotification).not.toHaveBeenCalled();
    });

    it("rejects a caller who does not own the request", async () => {
      prisma.service_requests.findUnique.mockResolvedValue({ ...baseRequest });
      await expect(
        service.cancelRequest("req-1", "someone-else"),
      ).rejects.toThrow(/not authorized/);
    });
  });

  describe("triggerMatching", () => {
    it("returns immediately for a non-pending request without notifying the parent", async () => {
      prisma.service_requests.findUnique.mockResolvedValue({
        id: "req-1",
        parent_id: "parent-1",
        status: "CANCELLED",
        assignments: [],
      });

      const result = await service.triggerMatching("req-1");

      expect(result).toBeNull();
      // Previously this fell through to the "No Matches Found" warning even
      // though the parent had just cancelled the request.
      expect(notificationsService.createNotification).not.toHaveBeenCalled();
    });
  });

  describe("create", () => {
    const validDto: any = {
      date: "2026-09-01",
      start_time: "10:00:00",
      duration_hours: 4,
      num_children: 1,
      category: "CC",
      address_id: "addr-1",
    };

    it("creates a request directly when matching fee is not required", async () => {
      pricingService.getMatchingFeeConfig.mockResolvedValue({ enabled: false, amount: 0 });

      const result = await service.create("parent-1", validDto);

      expect(result).toBeDefined();
      expect(result.matching_fee).toBeNull();
      expect(tx.service_requests.create).toHaveBeenCalled();
      expect(tx.bookings.create).toHaveBeenCalled();
      expect(tx.payment_installments.create).not.toHaveBeenCalled();
    });

    it("rejects booking creation when matching fee is enabled but no payment is provided", async () => {
      pricingService.getMatchingFeeConfig.mockResolvedValue({ enabled: true, amount: 249 });

      await expect(service.create("parent-1", validDto)).rejects.toThrow(
        /Matching fee payment is required/,
      );
      expect(tx.service_requests.create).not.toHaveBeenCalled();
      expect(tx.bookings.create).not.toHaveBeenCalled();
    });

    it("rejects booking creation when payment signature is invalid", async () => {
      pricingService.getMatchingFeeConfig.mockResolvedValue({ enabled: true, amount: 249 });
      paymentGateway.verifySignature.mockReturnValue(false);

      const dtoWithPayment = {
        ...validDto,
        payment: {
          razorpay_order_id: "ord-1",
          razorpay_payment_id: "pay-1",
          razorpay_signature: "invalid-sig",
        },
      };

      await expect(service.create("parent-1", dtoWithPayment)).rejects.toThrow(
        /Invalid payment signature/,
      );
      expect(tx.service_requests.create).not.toHaveBeenCalled();
    });

    it("creates booking and marks matching fee as paid when payment is verified", async () => {
      pricingService.getMatchingFeeConfig.mockResolvedValue({ enabled: true, amount: 249 });
      paymentGateway.verifySignature.mockReturnValue(true);

      const dtoWithPayment = {
        ...validDto,
        payment: {
          razorpay_order_id: "ord-1",
          razorpay_payment_id: "pay-1",
          razorpay_signature: "valid-sig",
        },
      };

      const result = await service.create("parent-1", dtoWithPayment);

      expect(result).toBeDefined();
      expect(result.matching_fee).toEqual({
        bookingId: "bk-1",
        installmentId: "inst-1",
        amount: 249,
        paid: true,
      });
      expect(tx.service_requests.create).toHaveBeenCalled();
      expect(tx.bookings.create).toHaveBeenCalled();
      expect(tx.price_snapshots.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            final_amount: 249,
            status: "charged",
          }),
        }),
      );
      expect(tx.payment_installments.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            amount: 249,
            status: "paid",
            kind: "matching_fee",
          }),
        }),
      );
      expect(tx.payments.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            amount: 249,
            status: "captured",
            order_id: "ord-1",
            payment_id: "pay-1",
          }),
        }),
      );
      expect(documents.issueForInstallment).toHaveBeenCalledWith("inst-1", prisma, expect.any(Date));
    });
  });
});
