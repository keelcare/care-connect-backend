import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class ChatService {
  constructor(private prisma: PrismaService) {}

  async createChat(bookingId: string) {
    return this.prisma.chats.create({
      data: {
        booking_id: bookingId,
      },
    });
  }

  async getChatByBookingId(bookingId: string) {
    return this.prisma.chats.findFirst({
      where: {
        booking_id: bookingId,
      },
      include: {
        messages: {
          orderBy: {
            created_at: "asc",
          },
        },
      },
    });
  }

  async getMessages(chatId: string, page: number = 1, limit: number = 50) {
    const skip = (page - 1) * limit;
    return this.prisma.messages.findMany({
      where: {
        chat_id: chatId,
      },
      orderBy: {
        created_at: "desc", // Usually chat history is fetched newest first for pagination, then reversed on client, or oldest first if just loading all. Let's stick to desc for pagination.
      },
      skip,
      take: limit,
      include: {
        users: {
          select: {
            id: true,
            profiles: {
              select: {
                first_name: true,
                last_name: true,
                profile_image_url: true,
              },
            },
          },
        },
      },
    });
  }

  async sendMessage(
    chatId: string,
    senderId: string,
    content: string,
    attachmentUrl?: string,
  ) {
    return this.prisma.messages.create({
      data: {
        chat_id: chatId,
        sender_id: senderId,
        content: content,
        attachment_url: attachmentUrl,
      },
      include: {
        users: {
          select: {
            id: true,
            email: true,
          },
        },
      },
    });
  }

  async markMessageAsRead(messageId: string) {
    return this.prisma.messages.update({
      where: {
        id: messageId,
      },
      data: {
        read_status: true,
      },
    });
  }

  async deleteChatByBookingId(bookingId: string) {
    // Delete all messages first (Prisma might handle this if cascade is set, but let's be safe or just delete the chat)
    const chat = await this.prisma.chats.findFirst({
      where: { booking_id: bookingId },
    });

    if (chat) {
      await this.prisma.chats.delete({
        where: { id: chat.id },
      });
    }
  }

  async isUserInBooking(bookingId: string, userId: string): Promise<boolean> {
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
    });
    if (!booking) return false;
    return booking.parent_id === userId || booking.nanny_id === userId;
  }

  async isUserInChat(chatId: string, userId: string): Promise<boolean> {
    const chat = await this.prisma.chats.findUnique({
      where: { id: chatId },
      include: { bookings: true },
    });
    if (!chat || !chat.bookings) return false;
    return (
      chat.bookings.parent_id === userId || chat.bookings.nanny_id === userId
    );
  }
}
