import {
  Controller,
  Post,
  Body,
  UseGuards,
  Get,
  Patch,
  Param,
  Request,
} from "@nestjs/common";
import { NotificationsService } from "./notifications.service";
import { AuthGuard } from "@nestjs/passport";

@Controller("notifications")
@UseGuards(AuthGuard("jwt"))
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post("send")
  async sendNotification(
    @Body()
    body: {
      target: "user" | "parents" | "nannies";
      userId?: string; // Required if target is 'user'
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
      return this.notificationsService.createNotification(
        body.userId,
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
