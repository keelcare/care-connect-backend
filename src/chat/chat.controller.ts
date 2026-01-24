import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Request,
  Query,
  ForbiddenException,
} from "@nestjs/common";
import { ChatService } from "./chat.service";
import { AuthGuard } from "@nestjs/passport";

@Controller("chat")
@UseGuards(AuthGuard("jwt"))
export class ChatController {
  constructor(private readonly chatService: ChatService) { }

  @Post()
  async createChat(@Body("bookingId") bookingId: string) {
    return this.chatService.createChat(bookingId);
  }

  @Get("booking/:bookingId")
  async getChatByBooking(
    @Param("bookingId") bookingId: string,
    @Request() req
  ) {
    const userId = req.user.id;
    const chat = await this.chatService.getChatByBookingId(bookingId);

    // Check if user is authorized to participate in this booking's chat
    const isAuthorized = await this.chatService.isUserInBooking(bookingId, userId);
    if (!isAuthorized) {
      throw new ForbiddenException("Not authorized to access this chat");
    }

    return chat;
  }

  @Get(":chatId/messages")
  async getMessages(
    @Param("chatId") chatId: string,
    @Query("page") page: number = 1,
    @Query("limit") limit: number = 50,
    @Request() req
  ) {
    const userId = req.user.id;

    // Authorization check
    const isAuthorized = await this.chatService.isUserInChat(chatId, userId);
    if (!isAuthorized) {
      throw new ForbiddenException("Not authorized to access these messages");
    }

    return this.chatService.getMessages(chatId, Number(page), Number(limit));
  }

  @Post(":chatId/message")
  async sendMessage(
    @Param("chatId") chatId: string,
    @Body() body: { content: string; attachmentUrl?: string },
    @Request() req,
  ) {
    // req.user is populated by JwtStrategy
    const userId = req.user.id;
    return this.chatService.sendMessage(
      chatId,
      userId,
      body.content,
      body.attachmentUrl,
    );
  }
}
