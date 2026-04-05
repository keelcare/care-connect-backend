import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { Server, Socket } from "socket.io";
import { ChatService } from "./chat.service";
import { JwtService } from "@nestjs/jwt";

@WebSocketGateway({
  cors: {
    origin: [
      process.env.FRONTEND_URL || "http://localhost:3000",
      "http://localhost:3000",
      "https://keelcare.netlify.app",
      "https://care-connect-dev.vercel.app",
      "http://127.0.0.1:3000",
      "capacitor://localhost",
      "https://localhost",
    ],
    credentials: true,
  },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
  ) { }

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
      // Connection successful - no need to log every connection
    } catch (error) {
      this.logger.warn(`WebSocket connection unauthorized: ${error.message}`);
      client.disconnect();
    }
  }

  private extractTokenFromCookies(cookieHeader: string | undefined): string | null {
    if (!cookieHeader) return null;

    const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
      const parts = cookie.trim().split('=');
      if (parts.length >= 2) {
        const name = parts.shift()?.trim();
        const value = parts.join('=');
        if (name) acc[name] = value;
      }
      return acc;
    }, {} as Record<string, string>);

    return cookies['access_token'] || null;
  }

  handleDisconnect(client: Socket) {
    // Normal disconnection - no need to log
  }

  @SubscribeMessage("joinRoom")
  handleJoinRoom(
    @MessageBody() chatId: string,
    @ConnectedSocket() client: Socket,
  ) {
    client.join(chatId);
    return { event: "joinedRoom", data: chatId };
  }

  @SubscribeMessage("leaveRoom")
  handleLeaveRoom(
    @MessageBody() chatId: string,
    @ConnectedSocket() client: Socket,
  ) {
    client.leave(chatId);
    return { event: "leftRoom", data: chatId };
  }

  @SubscribeMessage("sendMessage")
  async handleSendMessage(
    @MessageBody()
    payload: { chatId: string; content: string; attachmentUrl?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const userId = client.data.user.sub; // Assuming 'sub' is the user ID in JWT payload
    const message = await this.chatService.sendMessage(
      payload.chatId,
      userId,
      payload.content,
      payload.attachmentUrl,
    );

    // Emit to all in the room
    this.server.to(payload.chatId).emit("newMessage", message);
    return message;
  }

  @SubscribeMessage("typing")
  handleTyping(
    @MessageBody() payload: { chatId: string; isTyping: boolean },
    @ConnectedSocket() client: Socket,
  ) {
    client.to(payload.chatId).emit("typing", {
      userId: client.data.user.sub,
      isTyping: payload.isTyping,
    });
  }

  @SubscribeMessage("markAsRead")
  async handleMarkAsRead(
    @MessageBody() messageId: string,
    @ConnectedSocket() client: Socket,
  ) {
    const message = await this.chatService.markMessageAsRead(messageId);
    if (message && message.chat_id) {
      this.server.to(message.chat_id).emit("messageRead", message);
    }
  }
}
