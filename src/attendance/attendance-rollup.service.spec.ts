import { Test } from "@nestjs/testing";
import { AttendanceRollupService } from "./attendance-rollup.service";
import { AttendanceService } from "./attendance.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";

async function build(prisma: any, attendance: any = {}) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      AttendanceRollupService,
      { provide: PrismaService, useValue: prisma },
      { provide: AttendanceService, useValue: attendance },
      {
        provide: NotificationsService,
        useValue: { createNotification: jest.fn().mockResolvedValue(undefined) },
      },
    ],
  }).compile();
  return moduleRef.get(AttendanceRollupService);
}

describe("AttendanceRollupService — deriveStatus", () => {
  const derive = async (input: any) => {
    const svc = await build({});
    return (svc as any).deriveStatus(input);
  };
  const base = { scheduled: 1, attended: 0, late: 0, missed: 0, cancelled: 0, onLeave: false };

  it("marks a day whose only outcome was an advance cancellation as PARTIAL, not ABSENT", async () => {
    // The score credits an advance cancellation +0.5; the day record calling
    // the same fact ABSENT had the two records blaming her differently.
    expect(await derive({ ...base, cancelled: 1 })).toBe("PARTIAL");
  });

  it("still marks a day with an unexcused no-show ABSENT, even alongside a cancellation", async () => {
    expect(await derive({ ...base, missed: 1 })).toBe("ABSENT");
    expect(await derive({ ...base, missed: 1, cancelled: 1 })).toBe("ABSENT");
  });

  it("keeps the existing mapping for the other shapes of day", async () => {
    expect(await derive({ ...base, scheduled: 0 })).toBe("OFF");
    expect(await derive({ ...base, scheduled: 0, onLeave: true })).toBe("LEAVE");
    expect(await derive({ ...base, attended: 1 })).toBe("PRESENT");
    expect(await derive({ ...base, attended: 1, late: 1 })).toBe("LATE");
    expect(await derive({ ...base, scheduled: 2, attended: 1 })).toBe("PARTIAL");
    expect(await derive(base)).toBe("ABSENT"); // scheduled, no outcome yet
  });
});

describe("AttendanceRollupService — no-show sweep window", () => {
  it("only sweeps CONFIRMED, unstarted, assigned bookings past the no-show cutoff", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = await build({ bookings: { findMany } });

    await svc.sweepNoShows();

    const where = findMany.mock.calls[0][0].where;
    expect(where.status).toBe("CONFIRMED");
    expect(where.actual_start_time).toBeNull();
    expect(where.nanny_id).toEqual({ not: null });
    // Bounded on both sides: recent enough to matter, old enough to be a no-show.
    expect(where.start_time.lte).toBeInstanceOf(Date);
    expect(where.start_time.gte).toBeInstanceOf(Date);
    expect(where.start_time.lte.getTime()).toBeGreaterThan(where.start_time.gte.getTime());
  });
});
