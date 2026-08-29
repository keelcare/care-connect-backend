import { Test } from "@nestjs/testing";
import { AttendanceService, istDateOnly } from "./attendance.service";
import { AttendanceListeners } from "./attendance.listeners";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { BookingCancelledEvent } from "../bookings/events/booking.events";

/**
 * Attendance is a record of what a caregiver did, consumed by a score that
 * decides how often she is matched with families. These tests pin the paths
 * where a race or a mis-attributed event would put a penalty on that record
 * for a session she actually attended — the failure mode the module exists
 * to prevent.
 */

const NANNY = "nanny-1";
const PARENT = "parent-1";

function baseBooking(overrides: any = {}) {
  return {
    id: "booking-1",
    nanny_id: NANNY,
    parent_id: PARENT,
    status: "CONFIRMED",
    start_time: new Date("2026-08-28T03:30:00.000Z"), // 09:00 IST
    end_time: new Date("2026-08-28T07:30:00.000Z"),
    actual_start_time: null,
    actual_end_time: null,
    tags: [],
    ...overrides,
  } as any;
}

async function build(prisma: any) {
  const notifications = { createNotification: jest.fn().mockResolvedValue(undefined) };
  const moduleRef = await Test.createTestingModule({
    providers: [
      AttendanceService,
      AttendanceListeners,
      { provide: PrismaService, useValue: prisma },
      { provide: NotificationsService, useValue: notifications },
    ],
  }).compile();
  return {
    service: moduleRef.get(AttendanceService),
    listeners: moduleRef.get(AttendanceListeners),
    notifications,
  };
}

function prismaMock(overrides: any = {}) {
  return {
    nanny_attendance_events: {
      create: jest.fn().mockResolvedValue({ id: "evt-1" }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    bookings: { findUnique: jest.fn() },
    location_updates: { findMany: jest.fn().mockResolvedValue([]) },
    nanny_details: { update: jest.fn().mockResolvedValue({}) },
    ...overrides,
  };
}

describe("AttendanceService — no-show vs check-in race", () => {
  it("does not record a no-show for a booking that has started since the sweeper's snapshot", async () => {
    const prisma = prismaMock();
    // The sweeper's snapshot said CONFIRMED/unstarted; the live row says the
    // caregiver has checked in. The stale snapshot must lose.
    prisma.bookings.findUnique.mockResolvedValue({
      status: "IN_PROGRESS",
      nanny_id: NANNY,
      actual_start_time: new Date(),
    });
    const { service } = await build(prisma);

    await service.recordNoShow(baseBooking());

    expect(prisma.nanny_attendance_events.create).not.toHaveBeenCalled();
  });

  it("retracts its own no-show when a check-in lands between the re-read and the insert", async () => {
    const prisma = prismaMock();
    // First read: still unstarted. Second read (post-insert verify): started.
    prisma.bookings.findUnique
      .mockResolvedValueOnce({ status: "CONFIRMED", nanny_id: NANNY, actual_start_time: null })
      .mockResolvedValueOnce({ actual_start_time: new Date() });
    const { service, notifications } = await build(prisma);

    await service.recordNoShow(baseBooking());

    // The row was written, then waived — and neither party was alarmed about a
    // caregiver who is standing in the family's home.
    expect(prisma.nanny_attendance_events.create).toHaveBeenCalled();
    expect(prisma.nanny_attendance_events.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { booking_id: "booking-1", type: "NO_SHOW", waived_at: null },
      }),
    );
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });

  it("records and notifies both parties when the booking genuinely has not started", async () => {
    const prisma = prismaMock();
    prisma.bookings.findUnique.mockResolvedValue({
      status: "CONFIRMED",
      nanny_id: NANNY,
      actual_start_time: null,
    });
    const { service, notifications } = await build(prisma);

    await service.recordNoShow(baseBooking());

    expect(prisma.nanny_attendance_events.create).toHaveBeenCalled();
    expect(notifications.createNotification).toHaveBeenCalledTimes(2);
  });

  it("retracts a stale no-show on an on-time check-in, not just a late one", async () => {
    const prisma = prismaMock();
    const { service } = await build(prisma);
    const start = new Date("2026-08-28T03:30:00.000Z");

    await service.recordCheckIn(
      baseBooking({
        status: "IN_PROGRESS",
        actual_start_time: new Date(start.getTime() + 5 * 60 * 1000), // within grace
      }),
    );

    const created = prisma.nanny_attendance_events.create.mock.calls[0][0].data;
    expect(created.type).toBe("CHECK_IN");
    // A delayed STARTED event can arrive after the sweeper has flagged the
    // booking; the retraction must run regardless of punctuality.
    expect(prisma.nanny_attendance_events.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { booking_id: "booking-1", type: "NO_SHOW", waived_at: null },
      }),
    );
  });
});

describe("AttendanceService — geofence breach idempotency", () => {
  it("keys the breach row to the cooldown bucket so concurrent pings collide in the database", async () => {
    const prisma = prismaMock();
    const now = Date.now();
    const trail = [0, 3, 6, 9, 11].map((min) => ({
      lat: 20,
      lng: 80,
      timestamp: new Date(now - (11 - min) * 60 * 1000),
    }));
    prisma.location_updates.findMany.mockResolvedValue(trail);
    prisma.bookings.findUnique.mockResolvedValue({
      start_time: new Date(),
      status: "IN_PROGRESS",
      nanny_id: NANNY,
    });
    const { service } = await build(prisma);

    await service.evaluateGeofenceBreach("booking-1", NANNY, 10, 70, 100, 5000);

    const created = prisma.nanny_attendance_events.create.mock.calls[0][0].data;
    expect(created.type).toBe("GEOFENCE_BREACH");
    expect(created.dedupe_key).toMatch(/^booking-1:GEOFENCE_BREACH:\d+$/);
  });
});

describe("AttendanceService — waiver claim", () => {
  const event = {
    id: "evt-1",
    nanny_id: NANNY,
    type: "NO_SHOW",
    booking_id: "booking-1",
    attendance_date: new Date("2026-08-28T00:00:00.000Z"),
    waived_at: null,
  };

  it("runs side effects exactly once when two admins race to waive the same event", async () => {
    const prisma = prismaMock();
    prisma.nanny_attendance_events.findUnique.mockResolvedValue(event);
    // The other admin's write landed first: our guarded claim finds nothing.
    prisma.nanny_attendance_events.updateMany.mockResolvedValue({ count: 0 });
    prisma.nanny_attendance_events.findMany.mockResolvedValue([]);
    const { service, notifications } = await build(prisma);

    await service.waiveEvent("evt-1", "admin-2", "Family cancelled at the door");

    // The losing claim must not refresh the score or notify a second time.
    expect(prisma.nanny_details.update).not.toHaveBeenCalled();
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });

  it("claims with a waived_at: null guard rather than an unconditional update", async () => {
    const prisma = prismaMock();
    prisma.nanny_attendance_events.findUnique.mockResolvedValue(event);
    prisma.nanny_attendance_events.updateMany.mockResolvedValue({ count: 1 });
    const { service } = await build(prisma);

    await service.waiveEvent("evt-1", "admin-1", "Family cancelled at the door");

    expect(prisma.nanny_attendance_events.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "evt-1", waived_at: null } }),
    );
  });
});

describe("AttendanceListeners — cancellation attribution", () => {
  it("does not record a nanny cancellation for a nanny-reported parent no-show", async () => {
    const prisma = prismaMock();
    const { listeners } = await build(prisma);

    // reportNoShow cancels the booking with the *reporter* as the actor. The
    // nanny reporting that nobody was home must not be scored as the canceller.
    await listeners.handleCancelled(
      new BookingCancelledEvent(
        baseBooking({ status: "CANCELLED", tags: ["noshow", "parent_noshow"] }),
        "Nobody home",
        NANNY,
      ),
    );

    expect(prisma.nanny_attendance_events.create).not.toHaveBeenCalled();
  });

  it("still records a genuine nanny cancellation", async () => {
    const prisma = prismaMock();
    const { listeners } = await build(prisma);

    await listeners.handleCancelled(
      new BookingCancelledEvent(
        baseBooking({
          status: "CANCELLED",
          start_time: new Date(Date.now() + 48 * 60 * 60 * 1000),
        }),
        "Family emergency",
        NANNY,
      ),
    );

    const created = prisma.nanny_attendance_events.create.mock.calls[0][0].data;
    expect(created.type).toBe("ADVANCE_CANCEL");
  });

  it("ignores parent and system cancellations", async () => {
    const prisma = prismaMock();
    const { listeners } = await build(prisma);

    await listeners.handleCancelled(
      new BookingCancelledEvent(baseBooking({ status: "CANCELLED" }), "reason", PARENT),
    );
    await listeners.handleCancelled(
      new BookingCancelledEvent(baseBooking({ status: "CANCELLED" }), "expired", undefined),
    );

    expect(prisma.nanny_attendance_events.create).not.toHaveBeenCalled();
  });
});

describe("istDateOnly", () => {
  it("attributes a late-evening IST instant to the same IST day despite UTC lagging", () => {
    // 23:30 IST on Aug 28 is 18:00 UTC Aug 28 — same day either way.
    expect(istDateOnly(new Date("2026-08-28T18:00:00.000Z")).toISOString()).toBe(
      "2026-08-28T00:00:00.000Z",
    );
    // 01:00 IST on Aug 29 is 19:30 UTC Aug 28 — the IST day must win.
    expect(istDateOnly(new Date("2026-08-28T19:30:00.000Z")).toISOString()).toBe(
      "2026-08-29T00:00:00.000Z",
    );
  });
});
