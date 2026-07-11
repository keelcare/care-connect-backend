import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PushService } from "../notifications/push.service";

const RING_TIMEOUT_MS = 45_000;
const DISCONNECT_GRACE_MS = 30_000;
const ICE_CACHE_MS = 10 * 60_000;

/** Booking statuses during which the two parties may call each other. */
export const CALLABLE_STATUSES = ["CONFIRMED", "IN_PROGRESS"];

export type CallEndReason =
  | "hangup"
  | "timeout"
  | "disconnect"
  | "failed"
  | "reject"
  | "cancel";

export interface CallPeerInfo {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface ActiveCall {
  id: string;
  bookingId: string;
  callerId: string;
  calleeId: string;
  status: "RINGING" | "ONGOING";
  caller: CallPeerInfo;
  ringTimer?: NodeJS.Timeout;
  graceTimers: Map<string, NodeJS.Timeout>;
}

export type EligibilityResult =
  | { calleeId: string; caller: CallPeerInfo }
  | { error: string; code: "NOT_FOUND" | "NOT_ELIGIBLE" };

type EndEmitter = (call: ActiveCall, reason: CallEndReason) => void;

@Injectable()
export class CallsService implements OnModuleInit {
  private readonly logger = new Logger(CallsService.name);

  /** Server-authoritative registry of live calls (RINGING/ONGOING). */
  private readonly calls = new Map<string, ActiveCall>();
  private endEmitter: EndEmitter | null = null;
  private iceCache: { expires: number; servers: any[] } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notificationsService: NotificationsService,
    private readonly pushService: PushService,
  ) {}

  /** Server restarts wipe the in-memory registry; close out orphaned rows. */
  async onModuleInit() {
    try {
      const swept = await this.prisma.call_sessions.updateMany({
        where: { status: { in: ["RINGING", "ONGOING"] } },
        data: { status: "FAILED", ended_at: new Date() },
      });
      if (swept.count > 0) {
        this.logger.warn(`Marked ${swept.count} stale call session(s) FAILED on startup`);
      }
    } catch (error) {
      this.logger.error("Failed to sweep stale call sessions", error.stack);
    }
  }

  /** The gateway registers how `call:ended` reaches clients (avoids circular DI). */
  setEndEmitter(emitter: EndEmitter) {
    this.endEmitter = emitter;
  }

  get(callId: string): ActiveCall | undefined {
    return this.calls.get(callId);
  }

  isParticipant(callId: string, userId: string | undefined): boolean {
    if (!userId) return false;
    const call = this.calls.get(callId);
    return !!call && (call.callerId === userId || call.calleeId === userId);
  }

  isBusy(userId: string): boolean {
    for (const call of this.calls.values()) {
      if (call.callerId === userId || call.calleeId === userId) return true;
    }
    return false;
  }

  /**
   * A user may call the other party of a booking they belong to, only while a
   * nanny is assigned and the booking is CONFIRMED / IN_PROGRESS.
   */
  async checkEligibility(bookingId: string, callerId: string): Promise<EligibilityResult> {
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      select: { parent_id: true, nanny_id: true, status: true },
    });
    if (!booking) return { error: "Booking not found", code: "NOT_FOUND" };

    if (booking.parent_id !== callerId && booking.nanny_id !== callerId) {
      return { error: "Not a participant of this booking", code: "NOT_ELIGIBLE" };
    }
    if (!booking.nanny_id || !booking.parent_id) {
      return { error: "No caregiver assigned yet", code: "NOT_ELIGIBLE" };
    }
    // Status casing is mixed in the DB ("requested" vs "CONFIRMED") — normalize.
    const status = String(booking.status ?? "").toUpperCase();
    if (!CALLABLE_STATUSES.includes(status)) {
      return { error: `Calls are not available for ${status.toLowerCase()} bookings`, code: "NOT_ELIGIBLE" };
    }

    const calleeId = booking.parent_id === callerId ? booking.nanny_id : booking.parent_id;
    const profile = await this.prisma.profiles.findUnique({
      where: { user_id: callerId },
      select: { first_name: true, last_name: true, profile_image_url: true },
    });
    const name =
      [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") || "Keel user";
    return {
      calleeId,
      caller: { id: callerId, name, avatarUrl: profile?.profile_image_url ?? null },
    };
  }

  async createSession(
    bookingId: string,
    callerId: string,
    calleeId: string,
    caller: CallPeerInfo,
  ): Promise<ActiveCall> {
    const row = await this.prisma.call_sessions.create({
      data: { booking_id: bookingId, caller_id: callerId, callee_id: calleeId },
    });
    const call: ActiveCall = {
      id: row.id,
      bookingId,
      callerId,
      calleeId,
      status: "RINGING",
      caller,
      graceTimers: new Map(),
    };
    call.ringTimer = setTimeout(() => {
      this.endCall(call.id, "timeout").catch((err) =>
        this.logger.error(`Ring-timeout end failed for call ${call.id}`, err.stack),
      );
    }, RING_TIMEOUT_MS);
    this.calls.set(call.id, call);
    return call;
  }

  async markOngoing(callId: string) {
    const call = this.calls.get(callId);
    if (!call || call.status !== "RINGING") return null;
    if (call.ringTimer) clearTimeout(call.ringTimer);
    call.ringTimer = undefined;
    call.status = "ONGOING";
    await this.prisma.call_sessions.update({
      where: { id: callId },
      data: { status: "ONGOING", started_at: new Date() },
    });
    return call;
  }

  /**
   * Terminal transition — idempotent. Clears timers/registry, persists the
   * final status, emits `call:ended` via the gateway and fires missed-call
   * side effects when the callee never answered.
   */
  async endCall(callId: string, reason: CallEndReason): Promise<string | null> {
    const call = this.calls.get(callId);
    if (!call) return null;
    this.calls.delete(callId);
    if (call.ringTimer) clearTimeout(call.ringTimer);
    for (const timer of call.graceTimers.values()) clearTimeout(timer);

    const wasRinging = call.status === "RINGING";
    const finalStatus = this.finalStatusFor(reason, wasRinging);

    try {
      await this.prisma.call_sessions.update({
        where: { id: callId },
        data: { status: finalStatus, ended_at: new Date() },
      });
    } catch (error) {
      this.logger.error(`Failed to persist end of call ${callId}`, error.stack);
    }

    this.endEmitter?.(call, reason);

    if (wasRinging && (finalStatus === "MISSED" || finalStatus === "CANCELLED")) {
      // Fire-and-forget: never block teardown on notification delivery.
      this.recordMissedCall(call).catch((err) =>
        this.logger.error(`Missed-call side effects failed for ${callId}`, err.stack),
      );
    }
    return finalStatus;
  }

  private finalStatusFor(reason: CallEndReason, wasRinging: boolean): string {
    switch (reason) {
      case "timeout":
        return "MISSED";
      case "reject":
        return "REJECTED";
      case "cancel":
        return "CANCELLED";
      case "failed":
        return "FAILED";
      default:
        // hangup/disconnect while still ringing = caller gave up
        return wasRinging ? "CANCELLED" : "ENDED";
    }
  }

  private async recordMissedCall(call: ActiveCall) {
    await this.notificationsService.createNotification(
      call.calleeId,
      "Missed call",
      `${call.caller.name} tried to call you`,
      "info",
      "call",
      call.bookingId,
    );
    const chat = await this.prisma.chats.findFirst({
      where: { booking_id: call.bookingId },
      select: { id: true },
    });
    if (chat) {
      await this.prisma.messages.create({
        data: { chat_id: chat.id, sender_id: call.callerId, content: "Missed voice call" },
      });
    }
  }

  /**
   * Reconnect / push-tap recovery: report where the call stands and clear the
   * user's disconnect grace timer.
   */
  rejoin(callId: string, userId: string): "RINGING" | "ONGOING" | "ENDED" {
    const call = this.calls.get(callId);
    if (!call || !this.isParticipant(callId, userId)) return "ENDED";
    const grace = call.graceTimers.get(userId);
    if (grace) {
      clearTimeout(grace);
      call.graceTimers.delete(userId);
    }
    return call.status;
  }

  /**
   * A participant's socket dropped. Mid-call we allow a grace window for
   * `call:rejoin`; a caller who drops while ringing cancels the invite.
   * (A ringing callee is left alone — the ring timeout governs.)
   */
  onParticipantDisconnect(userId: string | undefined) {
    if (!userId) return;
    for (const call of this.calls.values()) {
      if (call.callerId !== userId && call.calleeId !== userId) continue;
      if (call.status === "RINGING" && call.calleeId === userId) continue;
      if (call.graceTimers.has(userId)) continue;
      call.graceTimers.set(
        userId,
        setTimeout(() => {
          this.endCall(call.id, call.status === "RINGING" ? "cancel" : "disconnect").catch(
            (err) => this.logger.error(`Grace-period end failed for ${call.id}`, err.stack),
          );
        }, DISCONNECT_GRACE_MS),
      );
    }
  }

  /** High-priority push so a backgrounded callee still rings. */
  async sendIncomingCallPush(call: ActiveCall) {
    try {
      const callee = await this.prisma.users.findUnique({
        where: { id: call.calleeId },
        select: { fcm_token: true, push_platform: true },
      });
      if (!callee?.fcm_token) return;
      await this.pushService.send(
        callee.fcm_token,
        callee.push_platform,
        "Incoming call",
        `${call.caller.name} is calling…`,
        {
          type: "incoming_call",
          callId: call.id,
          bookingId: call.bookingId,
          callerName: call.caller.name,
        },
        {
          highPriority: true,
          ttlSeconds: Math.floor(RING_TIMEOUT_MS / 1000),
          androidChannelId: "calls",
        },
      );
    } catch (error) {
      this.logger.error(`Incoming-call push failed for call ${call.id}`, error.stack);
    }
  }

  /**
   * STUN is always returned; Metered TURN credentials are appended when
   * configured (METERED_DOMAIN + METERED_API_KEY) and cached for ~10 minutes.
   * Fails open to STUN-only so calls on friendly networks still connect.
   */
  async getIceServers(): Promise<{ iceServers: any[] }> {
    if (this.iceCache && this.iceCache.expires > Date.now()) {
      return { iceServers: this.iceCache.servers };
    }
    const servers: any[] = [
      { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    ];
    const domain = this.config.get<string>("METERED_DOMAIN");
    const apiKey = this.config.get<string>("METERED_API_KEY");
    if (domain && apiKey) {
      try {
        const res = await fetch(
          `https://${domain}/api/v1/turn/credentials?apiKey=${apiKey}`,
        );
        if (res.ok) {
          const turn = await res.json();
          if (Array.isArray(turn)) servers.push(...turn);
        } else {
          this.logger.warn(`Metered TURN credential fetch failed: HTTP ${res.status}`);
        }
      } catch (error) {
        this.logger.warn(`Metered TURN credential fetch failed: ${error.message}`);
      }
    }
    this.iceCache = { expires: Date.now() + ICE_CACHE_MS, servers };
    return { iceServers: servers };
  }
}
