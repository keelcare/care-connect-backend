import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { CallsService } from "./calls.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PushService } from "../notifications/push.service";

const PARENT = "11111111-1111-1111-1111-111111111111";
const NANNY = "22222222-2222-2222-2222-222222222222";
const OTHER = "33333333-3333-3333-3333-333333333333";
const BOOKING = "44444444-4444-4444-4444-444444444444";

describe("CallsService", () => {
  let service: CallsService;
  let prisma: any;
  let notifications: any;
  let push: any;
  let config: any;

  const booking = (overrides: Partial<any> = {}) => ({
    parent_id: PARENT,
    nanny_id: NANNY,
    status: "CONFIRMED",
    ...overrides,
  });

  beforeEach(async () => {
    jest.useFakeTimers();
    prisma = {
      bookings: { findUnique: jest.fn() },
      profiles: {
        findUnique: jest.fn().mockResolvedValue({
          first_name: "Asha",
          last_name: "K",
          profile_image_url: null,
        }),
      },
      call_sessions: {
        create: jest
          .fn()
          .mockImplementation(({ data }: any) =>
            Promise.resolve({ id: "call-1", ...data }),
          ),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      chats: { findFirst: jest.fn().mockResolvedValue({ id: "chat-1" }) },
      messages: { create: jest.fn().mockResolvedValue({}) },
      users: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ fcm_token: "tok", push_platform: "android" }),
      },
    };
    notifications = { createNotification: jest.fn().mockResolvedValue({}) };
    push = { send: jest.fn().mockResolvedValue(true) };
    config = { get: jest.fn().mockReturnValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CallsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
        { provide: NotificationsService, useValue: notifications },
        { provide: PushService, useValue: push },
      ],
    }).compile();

    service = module.get<CallsService>(CallsService);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe("checkEligibility", () => {
    it("allows the parent of a CONFIRMED booking", async () => {
      prisma.bookings.findUnique.mockResolvedValue(booking());
      const result = await service.checkEligibility(BOOKING, PARENT);
      expect(result).toMatchObject({ calleeId: NANNY });
      expect((result as any).caller.name).toBe("Asha K");
    });

    it("allows the nanny and targets the parent", async () => {
      prisma.bookings.findUnique.mockResolvedValue(booking());
      const result = await service.checkEligibility(BOOKING, NANNY);
      expect(result).toMatchObject({ calleeId: PARENT });
    });

    it("rejects a user who is not a participant", async () => {
      prisma.bookings.findUnique.mockResolvedValue(booking());
      const result = await service.checkEligibility(BOOKING, OTHER);
      expect(result).toMatchObject({ code: "NOT_ELIGIBLE" });
    });

    it("rejects when no nanny is assigned", async () => {
      prisma.bookings.findUnique.mockResolvedValue(booking({ nanny_id: null }));
      const result = await service.checkEligibility(BOOKING, PARENT);
      expect(result).toMatchObject({ code: "NOT_ELIGIBLE" });
    });

    it("rejects a missing booking", async () => {
      prisma.bookings.findUnique.mockResolvedValue(null);
      const result = await service.checkEligibility(BOOKING, PARENT);
      expect(result).toMatchObject({ code: "NOT_FOUND" });
    });

    it.each(["COMPLETED", "CANCELLED", "requested", "EXPIRED"])(
      "rejects status %s",
      async (status) => {
        prisma.bookings.findUnique.mockResolvedValue(booking({ status }));
        const result = await service.checkEligibility(BOOKING, PARENT);
        expect(result).toMatchObject({ code: "NOT_ELIGIBLE" });
      },
    );

    it("accepts IN_PROGRESS regardless of stored casing", async () => {
      prisma.bookings.findUnique.mockResolvedValue(booking({ status: "in_progress" }));
      const result = await service.checkEligibility(BOOKING, PARENT);
      expect(result).toMatchObject({ calleeId: NANNY });
    });
  });

  describe("call lifecycle", () => {
    const caller = { id: PARENT, name: "Asha K", avatarUrl: null };

    it("registers a busy participant after createSession", async () => {
      await service.createSession(BOOKING, PARENT, NANNY, caller);
      expect(service.isBusy(PARENT)).toBe(true);
      expect(service.isBusy(NANNY)).toBe(true);
      expect(service.isBusy(OTHER)).toBe(false);
    });

    it("times out a ringing call into MISSED with missed-call side effects", async () => {
      const ended: any[] = [];
      service.setEndEmitter((call, reason) => ended.push({ call, reason }));
      await service.createSession(BOOKING, PARENT, NANNY, caller);

      jest.advanceTimersByTime(45_000);
      await jest.runOnlyPendingTimersAsync();

      expect(ended).toEqual([
        expect.objectContaining({ reason: "timeout" }),
      ]);
      expect(prisma.call_sessions.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "MISSED" }),
        }),
      );
      expect(notifications.createNotification).toHaveBeenCalledWith(
        NANNY,
        "Missed call",
        expect.stringContaining("Asha K"),
        "info",
        "call",
        BOOKING,
      );
      expect(prisma.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ content: "Missed voice call" }),
        }),
      );
      expect(service.isBusy(PARENT)).toBe(false);
    });

    it("marks an accepted call ONGOING and clears the ring timer", async () => {
      const call = await service.createSession(BOOKING, PARENT, NANNY, caller);
      await service.markOngoing(call.id);
      expect(prisma.call_sessions.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "ONGOING" }),
        }),
      );
      jest.advanceTimersByTime(60_000);
      // No timeout fired — the call is still live
      expect(service.get(call.id)?.status).toBe("ONGOING");
    });

    it("ends an ONGOING call as ENDED on hangup, idempotently", async () => {
      const call = await service.createSession(BOOKING, PARENT, NANNY, caller);
      await service.markOngoing(call.id);
      expect(await service.endCall(call.id, "hangup")).toBe("ENDED");
      expect(await service.endCall(call.id, "hangup")).toBeNull();
      expect(notifications.createNotification).not.toHaveBeenCalled();
    });

    it("maps reject to REJECTED without missed-call effects", async () => {
      const call = await service.createSession(BOOKING, PARENT, NANNY, caller);
      expect(await service.endCall(call.id, "reject")).toBe("REJECTED");
      expect(notifications.createNotification).not.toHaveBeenCalled();
    });

    it("records a missed call when the caller cancels a ringing call", async () => {
      const call = await service.createSession(BOOKING, PARENT, NANNY, caller);
      expect(await service.endCall(call.id, "cancel")).toBe("CANCELLED");
      await jest.runOnlyPendingTimersAsync();
      expect(notifications.createNotification).toHaveBeenCalled();
    });

    it("ends an ONGOING call after the disconnect grace period unless rejoined", async () => {
      const call = await service.createSession(BOOKING, PARENT, NANNY, caller);
      await service.markOngoing(call.id);

      service.onParticipantDisconnect(NANNY);
      expect(service.rejoin(call.id, NANNY)).toBe("ONGOING"); // rejoined in time
      jest.advanceTimersByTime(31_000);
      expect(service.get(call.id)?.status).toBe("ONGOING");

      service.onParticipantDisconnect(NANNY);
      jest.advanceTimersByTime(31_000);
      await jest.runOnlyPendingTimersAsync();
      expect(service.get(call.id)).toBeUndefined();
      expect(prisma.call_sessions.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "ENDED" }),
        }),
      );
    });

    it("leaves a ringing callee alone on disconnect (push may still land)", async () => {
      const call = await service.createSession(BOOKING, PARENT, NANNY, caller);
      service.onParticipantDisconnect(NANNY);
      jest.advanceTimersByTime(31_000);
      expect(service.get(call.id)?.status).toBe("RINGING");
    });

    it("reports ENDED on rejoin of an unknown call", () => {
      expect(service.rejoin("nope", PARENT)).toBe("ENDED");
    });
  });

  describe("getIceServers", () => {
    it("returns STUN-only when Metered is not configured", async () => {
      const { iceServers } = await service.getIceServers();
      expect(iceServers).toHaveLength(1);
      expect(iceServers[0].urls[0]).toContain("stun:");
    });

    it("appends Metered TURN servers and caches them", async () => {
      config.get.mockImplementation((key: string) =>
        key === "METERED_DOMAIN" ? "keel.metered.live" : "api-key",
      );
      const turn = [{ urls: "turn:relay.metered.ca:80", username: "u", credential: "c" }];
      const fetchSpy = jest
        .spyOn(global, "fetch")
        .mockResolvedValue({ ok: true, json: async () => turn } as any);

      const first = await service.getIceServers();
      const second = await service.getIceServers();
      expect(first.iceServers).toHaveLength(2);
      expect(second.iceServers).toHaveLength(2);
      expect(fetchSpy).toHaveBeenCalledTimes(1); // cached

      fetchSpy.mockRestore();
    });

    it("fails open to STUN-only when Metered errors", async () => {
      config.get.mockImplementation((key: string) =>
        key === "METERED_DOMAIN" ? "keel.metered.live" : "api-key",
      );
      const fetchSpy = jest
        .spyOn(global, "fetch")
        .mockRejectedValue(new Error("network down"));

      const { iceServers } = await service.getIceServers();
      expect(iceServers).toHaveLength(1);

      fetchSpy.mockRestore();
    });
  });

  describe("sweep on startup", () => {
    it("marks orphaned RINGING/ONGOING rows FAILED", async () => {
      prisma.call_sessions.updateMany.mockResolvedValue({ count: 2 });
      await service.onModuleInit();
      expect(prisma.call_sessions.updateMany).toHaveBeenCalledWith({
        where: { status: { in: ["RINGING", "ONGOING"] } },
        data: { status: "FAILED", ended_at: expect.any(Date) },
      });
    });
  });
});
