import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { Server, Socket } from "socket.io";
import { JwtService } from "@nestjs/jwt";
import { CallsService, ActiveCall, CallEndReason } from "./calls.service";

/**
 * WebRTC signaling for parent ↔ nanny calls.
 *
 * Rooms: `user_<id>` (joined at connect — invite/end fan-out reaches every
 * device of a user) and `call:<callId>` (SDP/ICE relay between the two live
 * sockets; caller joins at initiate, callee at accept).
 */
@WebSocketGateway({
  namespace: "/calls",
  cors: {
    origin: (origin, callback) => {
      const allowedOrigins = [
        process.env.FRONTEND_URL,
        "http://localhost:3000",
        "https://keelcare.netlify.app",
        "http://127.0.0.1:3000",
        "capacitor://localhost",
        "https://localhost",
      ].filter(Boolean);
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
  },
})
export class CallsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(CallsGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly calls: CallsService,
  ) {}

  afterInit() {
    this.calls.setEndEmitter((call, reason) => this.emitCallEnded(call, reason));
  }

  async handleConnection(client: Socket) {
    try {
      let token = this.extractTokenFromCookies(client.handshake.headers.cookie);
      if (!token) {
        token =
          client.handshake.auth?.token ||
          (client.handshake.headers.authorization as string | undefined);
      }
      if (!token) {
        client.disconnect();
        return;
      }
      const payload = this.jwtService.verify(token.replace("Bearer ", ""));
      client.data.user = payload;
      client.join(`user_${payload.sub}`);
    } catch (error) {
      this.logger.warn(`Calls socket unauthorized: ${error.message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.calls.onParticipantDisconnect(client.data.user?.sub);
  }

  @SubscribeMessage("call:initiate")
  async onInitiate(
    @MessageBody() data: { bookingId?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const userId = client.data.user?.sub as string | undefined;
    if (!userId || !data?.bookingId) return { error: "Invalid request", code: "NOT_FOUND" };

    const eligibility = await this.calls.checkEligibility(data.bookingId, userId);
    if ("error" in eligibility) return eligibility;

    if (this.calls.isBusy(userId) || this.calls.isBusy(eligibility.calleeId)) {
      return { error: "User is on another call", code: "BUSY" };
    }

    const call = await this.calls.createSession(
      data.bookingId,
      userId,
      eligibility.calleeId,
      eligibility.caller,
    );
    client.join(`call:${call.id}`);

    this.server.to(`user_${call.calleeId}`).emit("call:incoming", {
      callId: call.id,
      bookingId: call.bookingId,
      caller: call.caller,
    });
    void this.calls.sendIncomingCallPush(call);

    const sockets = await this.server.in(`user_${call.calleeId}`).fetchSockets();
    return { callId: call.id, delivered: sockets.length > 0 };
  }

  @SubscribeMessage("call:accept")
  async onAccept(
    @MessageBody() data: { callId?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const userId = client.data.user?.sub;
    const call = data?.callId ? this.calls.get(data.callId) : undefined;
    if (!call || call.calleeId !== userId || call.status !== "RINGING") {
      return { error: "Call is no longer available" };
    }
    await this.calls.markOngoing(call.id);
    client.join(`call:${call.id}`);
    // Caller learns the invite was accepted and sends the WebRTC offer next.
    client.to(`call:${call.id}`).emit("call:accepted", { callId: call.id });
    // Any *other* device of the callee that is still ringing stands down
    // (client.to excludes this socket, so the answering device is unaffected).
    client.to(`user_${call.calleeId}`).emit("call:ended", {
      callId: call.id,
      reason: "answered_elsewhere",
    });
    return { success: true };
  }

  @SubscribeMessage("call:reject")
  async onReject(
    @MessageBody() data: { callId?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const call = data?.callId ? this.calls.get(data.callId) : undefined;
    if (!call || call.calleeId !== client.data.user?.sub || call.status !== "RINGING") {
      return { error: "Call is no longer available" };
    }
    this.server.to(`user_${call.callerId}`).emit("call:rejected", {
      callId: call.id,
      reason: "declined",
    });
    await this.calls.endCall(call.id, "reject");
    return { success: true };
  }

  @SubscribeMessage("call:cancel")
  async onCancel(
    @MessageBody() data: { callId?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const call = data?.callId ? this.calls.get(data.callId) : undefined;
    if (!call || call.callerId !== client.data.user?.sub || call.status !== "RINGING") {
      return { error: "Call is no longer available" };
    }
    this.server.to(`user_${call.calleeId}`).emit("call:cancelled", { callId: call.id });
    await this.calls.endCall(call.id, "cancel");
    return { success: true };
  }

  @SubscribeMessage("call:hangup")
  async onHangup(
    @MessageBody() data: { callId?: string },
    @ConnectedSocket() client: Socket,
  ) {
    if (!data?.callId || !this.calls.isParticipant(data.callId, client.data.user?.sub)) {
      return { error: "Call is no longer available" };
    }
    await this.calls.endCall(data.callId, "hangup");
    return { success: true };
  }

  @SubscribeMessage("call:rejoin")
  async onRejoin(
    @MessageBody() data: { callId?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const userId = client.data.user?.sub;
    if (!data?.callId || !userId) return { status: "ENDED" };
    const status = this.calls.rejoin(data.callId, userId);
    if (status !== "ENDED") {
      client.join(`call:${data.callId}`);
      const call = this.calls.get(data.callId);
      return {
        status,
        call: call && {
          callId: call.id,
          bookingId: call.bookingId,
          caller: call.caller,
          isCaller: call.callerId === userId,
        },
      };
    }
    return { status };
  }

  @SubscribeMessage("webrtc:offer")
  onOffer(@MessageBody() data: { callId?: string; sdp?: any }, @ConnectedSocket() client: Socket) {
    this.relay(client, data?.callId, "webrtc:offer", { callId: data?.callId, sdp: data?.sdp });
  }

  @SubscribeMessage("webrtc:answer")
  onAnswer(@MessageBody() data: { callId?: string; sdp?: any }, @ConnectedSocket() client: Socket) {
    this.relay(client, data?.callId, "webrtc:answer", { callId: data?.callId, sdp: data?.sdp });
  }

  @SubscribeMessage("webrtc:ice")
  onIce(
    @MessageBody() data: { callId?: string; candidate?: any },
    @ConnectedSocket() client: Socket,
  ) {
    this.relay(client, data?.callId, "webrtc:ice", {
      callId: data?.callId,
      candidate: data?.candidate,
    });
  }

  @SubscribeMessage("call:media")
  onMedia(
    @MessageBody() data: { callId?: string; video?: boolean; muted?: boolean },
    @ConnectedSocket() client: Socket,
  ) {
    this.relay(client, data?.callId, "call:media", data);
  }

  /** Forward a payload to the other participant only (sender excluded). */
  private relay(client: Socket, callId: string | undefined, event: string, payload: any) {
    if (!callId || !this.calls.isParticipant(callId, client.data.user?.sub)) return;
    client.to(`call:${callId}`).emit(event, payload);
  }

  /**
   * Terminal fan-out. Both *user* rooms are targeted (not just the call room)
   * so a still-ringing callee that never joined the call room also stops.
   */
  private emitCallEnded(call: ActiveCall, reason: CallEndReason) {
    if (!this.server) return;
    const payload = { callId: call.id, reason };
    this.server.to(`user_${call.callerId}`).emit("call:ended", payload);
    this.server.to(`user_${call.calleeId}`).emit("call:ended", payload);
    this.server.in(`call:${call.id}`).socketsLeave(`call:${call.id}`);
  }

  private extractTokenFromCookies(cookieHeader: string | undefined): string | null {
    if (!cookieHeader) return null;
    const cookies = cookieHeader.split(";").reduce(
      (acc, cookie) => {
        const parts = cookie.trim().split("=");
        if (parts.length >= 2) {
          const name = parts.shift()?.trim();
          if (name) acc[name] = parts.join("=");
        }
        return acc;
      },
      {} as Record<string, string>,
    );
    return cookies["access_token"] || null;
  }
}
