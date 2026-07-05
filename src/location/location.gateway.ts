import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { Server, Socket } from "socket.io";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";

@WebSocketGateway({
  namespace: "/location",
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
export class LocationGateway implements OnGatewayConnection {
  private readonly logger = new Logger(LocationGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
    private jwtService: JwtService,
  ) {}

  /** Authenticate the socket handshake (JWT via cookie, auth.token or header). */
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
    } catch (error) {
      this.logger.warn(`Location socket unauthorized: ${error.message}`);
      client.disconnect();
    }
  }

  private extractTokenFromCookies(
    cookieHeader: string | undefined,
  ): string | null {
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

  private userId(client: Socket): string | undefined {
    return client.data.user?.sub || client.data.user?.id;
  }

  /**
   * Subscribe to a booking's live location room. Only the booking's parent or
   * assigned nanny may join. Emits the most recent known position on join.
   */
  @SubscribeMessage("location:subscribe")
  async handleSubscribe(
    @MessageBody() data: { bookingId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const uid = this.userId(client);
    const booking = await this.prisma.bookings.findUnique({
      where: { id: data.bookingId },
      select: {
        parent_id: true,
        nanny_id: true,
        care_location_lat: true,
        care_location_lng: true,
        geofence_radius: true,
      },
    });
    if (!booking || (uid !== booking.parent_id && uid !== booking.nanny_id)) {
      return { error: "Not authorized for this booking" };
    }

    client.join(`booking:${data.bookingId}`);

    // Send the last known position so the viewer renders immediately.
    const latest = await this.prisma.location_updates.findFirst({
      where: { booking_id: data.bookingId },
      orderBy: { timestamp: "desc" },
    });

    return {
      success: true,
      careLocation:
        booking.care_location_lat != null && booking.care_location_lng != null
          ? {
              lat: Number(booking.care_location_lat),
              lng: Number(booking.care_location_lng),
            }
          : null,
      geofenceRadius: booking.geofence_radius || 100,
      latest: latest
        ? {
            lat: Number(latest.lat),
            lng: Number(latest.lng),
            timestamp: latest.timestamp,
          }
        : null,
    };
  }

  /** Backwards-compatible alias used by existing web/mobile clients. */
  @SubscribeMessage("geofence:subscribe")
  handleGeofenceSubscribe(
    @MessageBody() data: { bookingId: string },
    @ConnectedSocket() client: Socket,
  ) {
    return this.handleSubscribe(data, client);
  }

  @SubscribeMessage("location:unsubscribe")
  handleUnsubscribe(
    @MessageBody() data: { bookingId: string },
    @ConnectedSocket() client: Socket,
  ) {
    client.leave(`booking:${data.bookingId}`);
    return { success: true };
  }

  @SubscribeMessage("geofence:unsubscribe")
  handleGeofenceUnsubscribe(
    @MessageBody() data: { bookingId: string },
    @ConnectedSocket() client: Socket,
  ) {
    return this.handleUnsubscribe(data, client);
  }

  @SubscribeMessage("location:update")
  async handleLocationUpdate(
    @MessageBody() data: { bookingId: string; lat: number; lng: number },
    @ConnectedSocket() client: Socket,
  ) {
    const { bookingId, lat, lng } = data;
    const uid = this.userId(client);

    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      select: {
        nanny_id: true,
        parent_id: true,
        care_location_lat: true,
        care_location_lng: true,
        geofence_radius: true,
      },
    });

    if (!booking) {
      return { error: "Booking not found" };
    }
    // Only the assigned nanny may publish location for a booking.
    if (uid !== booking.nanny_id) {
      return { error: "Only the assigned caregiver can share location" };
    }

    // Persist the point
    await this.prisma.location_updates.create({
      data: { booking_id: bookingId, nanny_id: booking.nanny_id, lat, lng },
    });

    const timestamp = new Date();

    // Geofence distance (if a care location is configured)
    let distance: number | null = null;
    const radius = booking.geofence_radius || 100;
    if (
      booking.care_location_lat != null &&
      booking.care_location_lng != null
    ) {
      distance = this.calculateDistance(
        lat,
        lng,
        Number(booking.care_location_lat),
        Number(booking.care_location_lng),
      );
    }

    // Broadcast the position (include geofence context so viewers can render it)
    this.server.to(`booking:${bookingId}`).emit("location:updated", {
      bookingId,
      lat,
      lng,
      distance,
      radius,
      inside: distance == null ? null : distance <= radius,
      timestamp,
    });

    // Fire a geofence alert + parent notification when outside the boundary
    if (distance != null && distance > radius) {
      this.server.to(`booking:${bookingId}`).emit("geofence:alert", {
        bookingId,
        distance,
        radius,
        timestamp,
        type: "left_geofence",
        message: "Caregiver is outside the designated care location",
      });

      await this.notificationsService.createNotification(
        booking.parent_id,
        "Geofence Alert",
        `The nanny has moved ${Math.round(distance)}m away from the care location (allowed: ${radius}m)`,
        "warning",
      );
    }

    return {
      success: true,
      distance,
      inside: distance == null ? null : distance <= radius,
    };
  }

  /** Nanny signals they've stopped sharing (session ended / paused). */
  @SubscribeMessage("location:stop")
  handleStop(
    @MessageBody() data: { bookingId: string },
    @ConnectedSocket() client: Socket,
  ) {
    if (this.userId(client)) {
      this.server.to(`booking:${data.bookingId}`).emit("location:stopped", {
        bookingId: data.bookingId,
        timestamp: new Date(),
      });
    }
    return { success: true };
  }

  // Haversine formula to calculate distance between two coordinates (metres)
  private calculateDistance(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const R = 6371e3;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lng2 - lng1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }
}
