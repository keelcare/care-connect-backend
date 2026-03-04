import {
  Controller,
  Post,
  Body,
  UseGuards,
  Get,
  Patch,
  Param,
  Request,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { NotificationsService } from "./notifications.service";
import { AuthGuard } from "@nestjs/passport";
import { PrismaService } from "../prisma/prisma.service";

@Controller("notifications")
@UseGuards(AuthGuard("jwt"))
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post("send")
  async sendNotification(
    @Body()
    body: {
      target: "user" | "parents" | "nannies";
      userId?: string; // Can be a UUID or an email address
      title: string;
      message: string;
      type?: "info" | "success" | "warning" | "error";
    },
  ) {
    if (body.target === "parents") {
      return this.notificationsService.sendToAllParents(
        body.title,
        body.message,
      );
    } else if (body.target === "nannies") {
      return this.notificationsService.sendToAllNannies(
        body.title,
        body.message,
      );
    } else if (body.target === "user" && body.userId) {
      // Resolve email to UUID if necessary
      const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
      let resolvedUserId = body.userId;

      if (!uuidRegex.test(body.userId)) {
        // Treat it as an email — look up the user's actual UUID
        const user = await this.prisma.users.findUnique({
          where: { email: body.userId },
          select: { id: true },
        });
        if (!user) {
          throw new NotFoundException(`No user found with email: ${body.userId}`);
        }
        resolvedUserId = user.id;
      }

      return this.notificationsService.createNotification(
        resolvedUserId,
        body.title,
        body.message,
        body.type,
      );
    } else {
      return { success: false, message: "Invalid target or missing userId" };
    }
  }

  @Get()
  async getUserNotifications(@Request() req) {
    return this.notificationsService.getUserNotifications(req.user.id);
  }

  @Patch(":id/read")
  async markAsRead(@Param("id") id: string) {
    return this.notificationsService.markAsRead(id);
  }

  @Patch("read-all")
  async markAllAsRead(@Request() req) {
    return this.notificationsService.markAllAsRead(req.user.id);
  }
}

