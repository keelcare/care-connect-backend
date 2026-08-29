import { Test, TestingModule } from "@nestjs/testing";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { UsersService } from "./users.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { EncryptionService } from "../common/services/encryption.service";
import { SupabaseStorageService } from "../supabase-storage/supabase-storage.service";
import { AddressesService } from "../addresses/addresses.service";
import {
  BookingStatus,
  INSTALMENT_PENDING,
  INSTALMENT_VOID,
} from "../constants";
import { BOOKING_EVENTS } from "../bookings/events/booking.events";

describe("UsersService", () => {
  let service: UsersService;
  let prisma: any;
  let eventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    prisma = {
      users: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      profiles: {
        upsert: jest.fn(),
        findFirst: jest.fn(),
      },
      nanny_details: {
        upsert: jest.fn(),
      },
      bookings: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
      payment_installments: {
        updateMany: jest.fn(),
      },
      service_requests: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
      },
      assignments: {
        updateMany: jest.fn(),
      },
      reviews: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      identity_documents: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      // Interactive form receives the mock itself as `tx`; array form awaits
      // the already-started promises, mirroring real Prisma closely enough.
      $transaction: jest.fn(async (arg: any) =>
        typeof arg === "function" ? arg(prisma) : Promise.all(arg),
      ),
    };
    eventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: NotificationsService,
          useValue: { createNotification: jest.fn() },
        },
        {
          provide: EncryptionService,
          useValue: { decrypt: jest.fn((v: string) => v) },
        },
        {
          provide: SupabaseStorageService,
          useValue: { uploadPublicImage: jest.fn() },
        },
        {
          provide: AddressesService,
          useValue: {
            getDefault: jest.fn().mockResolvedValue(null),
            create: jest.fn(),
            update: jest.fn(),
          },
        },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("deleteMe", () => {
    const parent = { id: "parent-1", role: "parent", deleted_at: null };

    beforeEach(() => {
      prisma.users.findUnique.mockResolvedValue(parent);
      prisma.users.updateMany.mockResolvedValue({ count: 1 });
      prisma.bookings.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment_installments.updateMany.mockResolvedValue({ count: 1 });
    });

    it("queries live bookings with the real (case-sensitive) status enum values", async () => {
      await service.deleteMe("parent-1");

      expect(prisma.bookings.findMany).toHaveBeenCalledWith({
        where: {
          parent_id: "parent-1",
          status: {
            in: [
              BookingStatus.REQUESTED,
              BookingStatus.CONFIRMED,
              BookingStatus.IN_PROGRESS,
            ],
          },
        },
      });
    });

    it("cancels each booking with a guarded claim, voids its pending instalments, and emits CANCELLED post-commit", async () => {
      const booking = {
        id: "b-1",
        parent_id: "parent-1",
        nanny_id: "nanny-9",
        status: BookingStatus.CONFIRMED,
      };
      prisma.bookings.findMany.mockResolvedValue([booking]);
      prisma.bookings.findUniqueOrThrow.mockResolvedValue({
        ...booking,
        status: BookingStatus.CANCELLED,
      });

      await service.deleteMe("parent-1");

      expect(prisma.bookings.updateMany).toHaveBeenCalledWith({
        where: {
          id: "b-1",
          status: {
            in: [
              BookingStatus.REQUESTED,
              BookingStatus.CONFIRMED,
              BookingStatus.IN_PROGRESS,
            ],
          },
        },
        data: {
          status: BookingStatus.CANCELLED,
          cancellation_reason: "Parent account deleted",
        },
      });
      expect(prisma.payment_installments.updateMany).toHaveBeenCalledWith({
        where: { booking_id: "b-1", status: INSTALMENT_PENDING },
        data: { status: INSTALMENT_VOID, updated_at: expect.any(Date) },
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        BOOKING_EVENTS.CANCELLED,
        expect.objectContaining({
          reason: "Parent account deleted",
          cancelledByUserId: "parent-1",
        }),
      );
    });

    it("skips instalment voiding and events for a booking whose claim was lost to a concurrent transition", async () => {
      prisma.bookings.findMany.mockResolvedValue([
        { id: "b-2", parent_id: "parent-1", status: BookingStatus.CONFIRMED },
      ]);
      prisma.bookings.updateMany.mockResolvedValue({ count: 0 });

      await service.deleteMe("parent-1");

      expect(prisma.payment_installments.updateMany).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it("cancels a deleting nanny's live bookings too", async () => {
      prisma.users.findUnique.mockResolvedValue({
        id: "nanny-1",
        role: "nanny",
        deleted_at: null,
      });

      await service.deleteMe("nanny-1");

      expect(prisma.bookings.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ nanny_id: "nanny-1" }),
      });
      // A nanny's own requests table is parent-owned; must not be touched.
      expect(prisma.service_requests.findMany).not.toHaveBeenCalled();
    });

    it("closes a deleting parent's open service requests and their pending assignments", async () => {
      prisma.service_requests.findMany.mockResolvedValue([{ id: "req-1" }]);
      prisma.service_requests.updateMany.mockResolvedValue({ count: 1 });
      prisma.assignments.updateMany.mockResolvedValue({ count: 1 });

      await service.deleteMe("parent-1");

      expect(prisma.assignments.updateMany).toHaveBeenCalledWith({
        where: {
          request_id: { in: ["req-1"] },
          status: { in: ["pending", "accepted"] },
        },
        data: { status: "cancelled", responded_at: expect.any(Date) },
      });
      expect(prisma.service_requests.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ["req-1"] },
          status: { in: ["pending", "accepted", "assigned"] },
        },
        data: { status: "CANCELLED" },
      });
    });

    it("claims the soft delete with a deleted_at:null guard and does nothing when the claim is lost", async () => {
      prisma.users.updateMany.mockResolvedValue({ count: 0 });

      await service.deleteMe("parent-1");

      expect(prisma.users.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "parent-1", deleted_at: null },
        }),
      );
      expect(prisma.bookings.findMany).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it("is idempotent: an already-deleted account is not re-stamped (retention window must not restart)", async () => {
      prisma.users.findUnique.mockResolvedValue({
        ...parent,
        deleted_at: new Date("2026-08-01"),
      });

      const res = await service.deleteMe("parent-1");

      expect(res.message).toMatch(/scheduled for deletion/i);
      expect(prisma.users.updateMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe("updatePushToken", () => {
    it("evicts the device token from every other account in the same transaction", async () => {
      prisma.users.updateMany.mockResolvedValue({ count: 1 });
      prisma.users.update.mockResolvedValue({ id: "user-2" });

      await service.updatePushToken("user-2", "device-token", "android");

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.users.updateMany).toHaveBeenCalledWith({
        where: { fcm_token: "device-token", id: { not: "user-2" } },
        data: { fcm_token: null },
      });
      expect(prisma.users.update).toHaveBeenCalledWith({
        where: { id: "user-2" },
        data: { fcm_token: "device-token", push_platform: "android" },
      });
    });
  });

  describe("update (profile DTO handling)", () => {
    beforeEach(() => {
      // findOne() is called at the end of the DTO branch
      prisma.users.findUnique.mockResolvedValue({
        id: "u-1",
        role: "parent",
        profiles: {},
      });
    });

    it("persists experienceYears: 0 sent on its own (falsy values are still present values)", async () => {
      await service.update("u-1", { experienceYears: 0 } as any);

      expect(prisma.nanny_details.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ experience_years: 0 }),
        }),
      );
    });

    it("persists lat/lng of 0 rather than dropping the profile write", async () => {
      await service.update("u-1", { lat: 0, lng: 0 } as any);

      expect(prisma.profiles.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ lat: 0, lng: 0 }),
        }),
      );
    });
  });
});
