import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsGateway } from "./notifications.gateway";
import { FcmService } from "./fcm.service";

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    private notificationsGateway: NotificationsGateway,
    private fcmService: FcmService,
  ) { }

  async createNotification(
    userId: string,
    title: string,
    message: string,
    type: "info" | "success" | "warning" | "error" = "info",
    category?: string,
    relatedId?: string,
  ) {
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

    // Validate userId — this is the primary key for the notification and MUST be a valid UUID
    if (!userId || !uuidRegex.test(userId)) {
      this.logger.error(`createNotification called with an invalid userId: "${userId}". Aborting.`);
      throw new Error(`Invalid userId format: "${userId}". Expected a valid UUID.`);
    }

    // Defensive Check: Validate UUID format for relatedId (optional field — fall back to null if invalid)
    const validRelatedId = relatedId && uuidRegex.test(relatedId) ? relatedId : null;
    if (relatedId && !validRelatedId) {
      this.logger.warn(`Invalid UUID format for relatedId: "${relatedId}". Falling back to null.`);
    }

    // 1. Save to Database
    const notification = await this.prisma.notifications.create({
      data: {
        user_id: userId,
        title,
        message,
        type,
        category,
        related_id: validRelatedId,
      },
    });

    // 2. Send Real-time Update via WebSocket
    this.notificationsGateway.sendToUser(userId, notification);

    // 3. Send Mobile Push Notification if the user has a registered FCM token
    try {
      const user = await this.prisma.users.findUnique({
        where: { id: userId },
        select: { fcm_token: true }
      });

      if (user?.fcm_token) {
        await this.fcmService.sendPushNotification(
          user.fcm_token,
          title,
          message,
          {
            type: category || type,
            relatedId: relatedId || '',
          }
        );
      }
    } catch (err) {
      this.logger.error(`Failed to dispatch push notification for user ${userId}`, err.stack);
    }

    return notification;
  }

  async sendToAllParents(title: string, message: string) {
    const parents = await this.prisma.users.findMany({
      where: { role: "parent" },
      select: { id: true },
    });

    for (const parent of parents) {
      if (parent && parent.id) {
        await this.createNotification(parent.id, title, message, "info");
      }
    }

    return { count: parents.length };
  }

  async sendToAllNannies(title: string, message: string) {
    const nannies = await this.prisma.users.findMany({
      where: { role: "nanny" },
      select: { id: true },
    });

    for (const nanny of nannies) {
      if (nanny && nanny.id) {
        await this.createNotification(nanny.id, title, message, "info");
      }
    }

    return { count: nannies.length };
  }

  async getUserNotifications(userId: string) {
    return this.prisma.notifications.findMany({
      where: { user_id: userId },
      orderBy: { created_at: "desc" },
    });
  }

  async markAsRead(notificationId: string) {
    return this.prisma.notifications.update({
      where: { id: notificationId },
      data: { is_read: true },
    });
  }

  async markAllAsRead(userId: string) {
    return this.prisma.notifications.updateMany({
      where: { user_id: userId, is_read: false },
      data: { is_read: true },
    });
  }

  // Legacy methods adapted
  async sendEmail(to: string, subject: string, text: string) {
    console.log(`[Email] To: ${to}, Subject: ${subject}, Body: ${text}`);
    return { success: true, method: "email" };
  }

  async sendPushNotification(userId: string, title: string, body: string) {
    console.log(`[Push] User: ${userId}, Title: ${title}, Body: ${body}`);
    return { success: true, method: "push" };
  }

  async sendSms(phoneNumber: string, message: string) {
    console.log(`[SMS] To: ${phoneNumber}, Message: ${message}`);
    return { success: true, method: "sms" };
  }

  async notifyBookingConfirmed(
    parentEmail: string,
    nannyEmail: string,
    bookingId: string,
  ) {
    // We need user IDs to create persistent notifications.
    // Assuming the caller might provide IDs or we fetch them.
    // For now, let's look up users by email if possible, or just log if not found.

    const parent = await this.prisma.users.findUnique({
      where: { email: parentEmail },
    });
    const nanny = await this.prisma.users.findUnique({
      where: { email: nannyEmail },
    });

    if (parent) {
      await this.createNotification(
        parent.id,
        "Booking Confirmed",
        `Your booking has been confirmed.`,
        "success",
      );
    }

    if (nanny) {
      await this.createNotification(
        nanny.id,
        "Booking Confirmed",
        `You have a new confirmed booking.`,
        "success",
      );
    }
  }

  async notifyNewMessage(recipientId: string, senderName: string) {
    await this.createNotification(
      recipientId,
      "New Message",
      `You have a new message from ${senderName}`,
      "info",
    );
  }

  async notifyNannyCancellationToParent(parentId: string, bookingId: string, willRematch: boolean, reason?: string) {
    const reasonText = reason ? `Reason: ${reason}` : "No reason provided";
    const rematchText = willRematch
      ? " We are automatically re-matching you."
      : " Please check the app to book another nanny.";

    await this.createNotification(
      parentId,
      "Booking Cancelled by Nanny",
      `The nanny had to cancel your booking. ${reasonText}.${rematchText}`,
      "warning",
      "booking",
      bookingId,
    );
  }
}
