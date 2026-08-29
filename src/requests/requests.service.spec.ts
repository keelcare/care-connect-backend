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

describe("RequestsService", () => {
  let service: RequestsService;
  let prisma: any;
  let tx: any;
  let notificationsService: any;
  let eventEmitter: any;
  let pricingService: any;

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
      },
      payment_installments: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      service_requests: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: "req-1", status: "CANCELLED", parent_id: "parent-1" }),
      },
    };
    prisma = {
      service_requests: { findUnique: jest.fn() },
      bookings: { findUnique: jest.fn() },
      $transaction: jest.fn().mockImplementation((cb) => cb(tx)),
    };
    notificationsService = { createNotification: jest.fn() };
    eventEmitter = { emit: jest.fn() };
    pricingService = {
      calculateCost: jest
        .fn()
        .mockResolvedValue({ totalAmount: 1000, appliedRate: 500 }),
      raiseMatchingFee: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RequestsService,
        { provide: PrismaService, useValue: prisma },
        { provide: UsersService, useValue: { findOne: jest.fn() } },
        { provide: NotificationsService, useValue: notificationsService },
        {
          provide: FavoritesService,
          useValue: { getFavoriteNannyIds: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: SseService,
          useValue: { emitToUser: jest.fn(), emitToUsers: jest.fn() },
        },
        { provide: MailService, useValue: {} },
        {
          provide: AvailabilityService,
          useValue: { doesBlockOverlap: jest.fn() },
        },
        { provide: PricingEngineService, useValue: pricingService },
        { provide: AddressesService, useValue: { resolveForUser: jest.fn() } },
        { provide: EventEmitter2, useValue: eventEmitter },
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
});
