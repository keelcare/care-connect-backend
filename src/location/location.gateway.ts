import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";

@WebSocketGateway({
  namespace: "/location",
  cors: {
    origin: process.env.FRONTEND_URL || "https://keel-care.vercel.app",
    credentials: true,
  },
})
export class LocationGateway {
  @WebSocketServer()
  server: Server;

  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
  ) { }

  @SubscribeMessage("location:subscribe")
  async handleSubscribe(
    @MessageBody() data: { bookingId: string },
    @ConnectedSocket() client: Socket,
  ) {
    // Join room for this booking
    client.join(`booking:${data.bookingId}`);
    return { success: true };
  }

  @SubscribeMessage("location:update")
  async handleLocationUpdate(
    @MessageBody() data: { bookingId: string; lat: number; lng: number },
    @ConnectedSocket() client: Socket,
  ) {
    const { bookingId, lat, lng } = data;

    // Get booking details
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

    // Save location update
    await this.prisma.location_updates.create({
      data: {
        booking_id: bookingId,
        nanny_id: booking.nanny_id,
        lat,
        lng,
      },
    });

    // Broadcast to parent
    this.server.to(`booking:${bookingId}`).emit("location:updated", {
      bookingId,
      lat,
      lng,
      timestamp: new Date(),
    });

    // Check geofencing if care location is set
    if (booking.care_location_lat && booking.care_location_lng) {
      const distance = this.calculateDistance(
        lat,
        lng,
        Number(booking.care_location_lat),
        Number(booking.care_location_lng),
      );

      const radius = booking.geofence_radius || 100; // Default 100 meters

      if (distance > radius) {
        // Nanny is outside geofence
        this.server.to(`booking:${bookingId}`).emit("geofence:alert", {
          bookingId,
          distance,
          radius,
          message: "Nanny is outside the designated care location",
        });

        // Send notification to parent
        await this.notificationsService.createNotification(
          booking.parent_id,
          "Geofence Alert",
          `The nanny has moved ${Math.round(distance)}m away from the care location (allowed: ${radius}m)`,
          "warning",
        );
      }
    }

    return { success: true };
  }

  // Haversine formula to calculate distance between two coordinates
  private calculateDistance(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const R = 6371e3; // Earth's radius in meters
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lng2 - lng1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // Distance in meters
  }
}
