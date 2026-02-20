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
  namespace: "notifications",
})
export class NotificationsGateway
  implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(NotificationsGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(private readonly jwtService: JwtService) { }

  async handleConnection(client: Socket) {
    try {
      // Try to get token from cookies first (primary method)
      let token = this.extractTokenFromCookies(client.handshake.headers.cookie);

      // Fallback to auth.token or authorization header for backwards compatibility
      if (!token) {
        token = client.handshake.auth.token || client.handshake.headers.authorization;
      }

      if (!token) {
        this.logger.warn('No authentication token found in cookies or headers');
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

  private extractTokenFromCookies(cookieHeader: string | undefined): string | null {
    if (!cookieHeader) return null;

    const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
      const parts = cookie.trim().split('=');
      if (parts.length >= 2) {
        const name = parts.shift()?.trim();
        const value = parts.join('='); // Rejoin in case value had =
        if (name) acc[name] = value;
      }
      return acc;
    }, {} as Record<string, string>);

    return cookies['access_token'] || null;
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
