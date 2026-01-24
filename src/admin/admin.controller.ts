import {
  Controller,
  Get,
  Put,
  Post,
  Param,
  Body,
  UseGuards,
} from "@nestjs/common";
import { AdminService } from "./admin.service";
import { AuthGuard } from "@nestjs/passport";
import { AdminGuard } from "./admin.guard";

@Controller("admin")
@UseGuards(AuthGuard("jwt"), AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // User Management
  @Get("users")
  async getAllUsers() {
    return this.adminService.getAllUsers();
  }

  @Put("users/:id/verify")
  async verifyUser(@Param("id") userId: string) {
    return this.adminService.verifyUser(userId);
  }

  @Put("users/:id/ban")
  async banUser(@Param("id") userId: string, @Body("reason") reason?: string) {
    return this.adminService.banUser(userId, reason);
  }

  @Put("users/:id/unban")
  async unbanUser(@Param("id") userId: string) {
    return this.adminService.unbanUser(userId);
  }

  // Booking Management
  @Get("bookings")
  async getAllBookings() {
    return this.adminService.getAllBookings();
  }

  // Dispute Resolution
  @Get("disputes")
  async getAllDisputes() {
    return this.adminService.getAllDisputes();
  }

  @Get("disputes/:id")
  async getDisputeById(@Param("id") id: string) {
    return this.adminService.getDisputeById(id);
  }

  @Put("disputes/:id/resolve")
  async resolveDispute(
    @Param("id") id: string,
    @Body("resolution") resolution: string,
    @Body("resolvedBy") resolvedBy: string,
  ) {
    return this.adminService.resolveDispute(id, resolution, resolvedBy);
  }

  // Payment Monitoring
  @Get("payments")
  async getAllPayments() {
    return this.adminService.getAllPayments();
  }

  @Get("payments/stats")
  async getPaymentStats() {
    return this.adminService.getPaymentStats();
  }

  // Review Moderation
  @Get("reviews")
  async getAllReviews() {
    return this.adminService.getAllReviews();
  }

  @Put("reviews/:id/approve")
  async approveReview(@Param("id") id: string) {
    return this.adminService.approveReview(id);
  }

  @Put("reviews/:id/reject")
  async rejectReview(@Param("id") id: string) {
    return this.adminService.rejectReview(id);
  }

  // Matching Configuration
  @Get("settings")
  async getSettings() {
    return this.adminService.getSettings();
  }

  @Get("settings/:key")
  async getSetting(@Param("key") key: string) {
    return this.adminService.getSetting(key);
  }

  @Post("settings/:key")
  async updateSetting(@Param("key") key: string, @Body("value") value: any) {
    return this.adminService.updateSetting(key, value);
  }

  // Analytics
  @Get("stats")
  async getStats() {
    return this.adminService.getSystemStats();
  }

  @Get("stats/advanced")
  async getAdvancedStats() {
    return this.adminService.getAdvancedStats();
  }
}
