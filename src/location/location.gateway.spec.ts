import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { LocationGateway } from "./location.gateway";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AttendanceService } from "../attendance/attendance.service";
import { TokenBlacklistService } from "../auth/token-blacklist.service";
import { BookingStatus } from "../constants";

describe("LocationGateway", () => {
  let gateway: LocationGateway;
  let prisma: any;
  let notifications: any;
  let attendance: any;
  let emit: jest.Mock;

  const socket = (uid: string | undefined) =>
    ({ data: { user: uid ? { sub: uid } : undefined } }) as any;

  const activeBooking = {
    nanny_id: "nanny-1",
    parent_id: "parent-1",
    status: BookingStatus.IN_PROGRESS,
    care_location_lat: 19.07,
    care_location_lng: 72.87,
    geofence_radius: 100,
  };

  beforeEach(async () => {
    prisma = {
      bookings: { findUnique: jest.fn() },
      location_updates: {
        create: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn(),
      },
    };
    notifications = { createNotification: jest.fn().mockResolvedValue({}) };
    attendance = { evaluateGeofenceBreach: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocationGateway,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
        { provide: AttendanceService, useValue: attendance },
        { provide: JwtService, useValue: { verify: jest.fn() } },
        { provide: TokenBlacklistService, useValue: { isRevoked: jest.fn() } },
      ],
    }).compile();

    gateway = module.get(LocationGateway);
    emit = jest.fn();
    gateway.server = { to: jest.fn().mockReturnValue({ emit }) } as any;
  });

  describe("location:update", () => {
    it("rejects non-numeric or out-of-range coordinates before touching the DB", async () => {
      for (const [lat, lng] of [
        ["19.07", 72.87],
        [NaN, 72.87],
        [Infinity, 72.87],
        [91, 72.87],
        [19.07, 181],
        [null, 72.87],
      ] as any[]) {
        const res = await gateway.handleLocationUpdate(
          { bookingId: "b1", lat, lng },
          socket("nanny-1"),
        );
        expect(res).toEqual({ error: "Invalid coordinates" });
      }
      expect(prisma.bookings.findUnique).not.toHaveBeenCalled();
      expect(prisma.location_updates.create).not.toHaveBeenCalled();
    });

    it("rejects updates from anyone but the assigned nanny", async () => {
      prisma.bookings.findUnique.mockResolvedValue(activeBooking);
      const res = await gateway.handleLocationUpdate(
        { bookingId: "b1", lat: 19.07, lng: 72.87 },
        socket("parent-1"),
      );
      expect(res).toEqual({
        error: "Only the assigned caregiver can share location",
      });
    });

    it("rejects updates for a booking that is no longer active", async () => {
      prisma.bookings.findUnique.mockResolvedValue({
        ...activeBooking,
        status: BookingStatus.COMPLETED,
      });
      const res = await gateway.handleLocationUpdate(
        { bookingId: "b1", lat: 19.07, lng: 72.87 },
        socket("nanny-1"),
      );
      expect(res).toEqual({ error: "Booking is not active" });
      expect(prisma.location_updates.create).not.toHaveBeenCalled();
    });

    it("persists and broadcasts an in-fence update without alerting", async () => {
      prisma.bookings.findUnique.mockResolvedValue(activeBooking);
      const res = await gateway.handleLocationUpdate(
        { bookingId: "b1", lat: 19.07, lng: 72.87 },
        socket("nanny-1"),
      );
      expect(res).toMatchObject({ success: true, inside: true });
      expect(prisma.location_updates.create).toHaveBeenCalled();
      expect(notifications.createNotification).not.toHaveBeenCalled();
    });

    it("notifies the parent once, then throttles repeat breach pings", async () => {
      prisma.bookings.findUnique.mockResolvedValue(activeBooking);
      // ~1.1km away from the care location — well outside the 100m fence
      const far = { bookingId: "b1", lat: 19.08, lng: 72.87 };

      const first = await gateway.handleLocationUpdate(far, socket("nanny-1"));
      expect(first).toMatchObject({ inside: false });
      expect(notifications.createNotification).toHaveBeenCalledTimes(1);

      // Second breach ping seconds later: live alert still emitted, but no
      // second persistent notification inside the cooldown window.
      await gateway.handleLocationUpdate(far, socket("nanny-1"));
      expect(notifications.createNotification).toHaveBeenCalledTimes(1);
      const alertEmits = emit.mock.calls.filter(
        ([event]) => event === "geofence:alert",
      );
      expect(alertEmits.length).toBe(2);
      expect(attendance.evaluateGeofenceBreach).toHaveBeenCalledTimes(2);
    });
  });

  describe("location:stop", () => {
    it("only lets the assigned nanny broadcast stopped", async () => {
      prisma.bookings.findUnique.mockResolvedValue({ nanny_id: "nanny-1" });
      const denied = await gateway.handleStop(
        { bookingId: "b1" },
        socket("someone-else"),
      );
      expect(denied).toEqual({
        error: "Only the assigned caregiver can stop sharing",
      });
      expect(emit).not.toHaveBeenCalled();

      const ok = await gateway.handleStop({ bookingId: "b1" }, socket("nanny-1"));
      expect(ok).toEqual({ success: true });
      expect(emit).toHaveBeenCalledWith(
        "location:stopped",
        expect.objectContaining({ bookingId: "b1" }),
      );
    });
  });

  describe("location:subscribe", () => {
    it("rejects users who are not party to the booking", async () => {
      prisma.bookings.findUnique.mockResolvedValue({
        parent_id: "parent-1",
        nanny_id: "nanny-1",
      });
      const res = await gateway.handleSubscribe(
        { bookingId: "b1" },
        { ...socket("stranger"), join: jest.fn() } as any,
      );
      expect(res).toEqual({ error: "Not authorized for this booking" });
    });
  });
});
