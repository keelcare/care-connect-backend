import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { Server, Socket } from "socket.io";
import { JwtService } from "@nestjs/jwt";

@WebSocketGateway({
  cors: {
    origin: "*",
  },
  namespace: "notifications",
})
export class NotificationsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(NotificationsGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(private readonly jwtService: JwtService) {}

  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth.token || client.handshake.headers.authorization;
      if (!token) {
        client.disconnect();
        return;
      }

      const cleanToken = token.replace("Bearer ", "");
      const payload = this.jwtService.verify(cleanToken);

      // Store user info in socket
      client.data.user = payload;

      // Join a room based on user ID for targeted notifications
      client.join(`user_${payload.sub}`);

      this.logger.log(`User connected to notifications: ${payload.sub}`);
    } catch (error) {
      this.logger.warn(`Notification WebSocket unauthorized: ${error.message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    // this.logger.log(`User disconnected from notifications: ${client.id}`);
  }

  sendToUser(userId: string, payload: any) {
    if (this.server) {
      this.server.to(`user_${userId}`).emit("notification", payload);
    } else {
      this.logger.warn(
        "WebSocket server not initialized. Skipping real-time update.",
      );
    }
  }

  sendToAll(payload: any) {
    if (this.server) {
      this.server.emit("notification", payload);
    } else {
      this.logger.warn(
        "WebSocket server not initialized. Skipping real-time update.",
      );
    }
  }
}
