import {
  Controller,
  Get,
  Put,
  Post,
  Param,
  Body,
  UseGuards,
  Query,
} from "@nestjs/common";
import { AdminService } from "./admin.service";
import { AuthGuard } from "@nestjs/passport";
import { UserRole } from "../auth/dto/signup.dto";
import { Roles } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";

import { AdminManualAssignmentDto } from "./dto/admin-manual-assignment.dto";

@Controller("admin")
@Roles(UserRole.ADMIN)
@UseGuards(AuthGuard("jwt"), RolesGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // Manual Assignment Management
  @Get("manual-assignment/requests")
  async getManualAssignmentRequests() {
    return this.adminService.getManualAssignmentRequests();
  }

  @Get("manual-assignment/nannies/:requestId")
  async getAvailableNanniesForRequest(@Param("requestId") requestId: string) {
    return this.adminService.getAvailableNanniesForRequest(requestId);
  }

  @Post("manual-assignment/assign")
  async manuallyAssignNanny(@Body() dto: AdminManualAssignmentDto) {
    return this.adminService.manuallyAssignNanny(dto.requestId, dto.nannyId);
  }

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

  // Category Request Management
  @Get("category-requests")
  async getCategoryRequests(@Query("status") status?: string) {
    return this.adminService.getCategoryRequests(status);
  }

  @Put("category-requests/:id/approve")
  async approveCategoryRequest(
    @Param("id") id: string,
    @Body("notes") notes?: string,
  ) {
    return this.adminService.updateCategoryRequestStatus(id, "approved", notes);
  }

  @Put("category-requests/:id/reject")
  async rejectCategoryRequest(
    @Param("id") id: string,
    @Body("notes") notes?: string,
  ) {
    return this.adminService.updateCategoryRequestStatus(id, "rejected", notes);
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

  @Get("payment-plans")
  async getAllPaymentPlans() {
    return this.adminService.getAllPaymentPlans();
  }

  @Get("payment-plans/stats")
  async getPaymentPlanStats() {
    return this.adminService.getPaymentPlanStats();
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
  @Get("dashboard")
  async getDashboardData() {
    return this.adminService.getDashboardData();
  }

  @Get("stats")
  async getStats() {
    return this.adminService.getSystemStats();
  }

  @Get("stats/advanced")
  async getAdvancedStats() {
    return this.adminService.getAdvancedStats();
  }
}
