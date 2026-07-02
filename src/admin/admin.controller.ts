import {
  Controller,
  Get,
  Put,
  Post,
  Param,
  Body,
  UseGuards,
  Query,
  Req,
} from "@nestjs/common";
import { AdminService } from "./admin.service";
import { AuthGuard } from "@nestjs/passport";
import { UserRole } from "../auth/dto/signup.dto";
import { Roles } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";

import { AdminManualAssignmentDto } from "./dto/admin-manual-assignment.dto";
import { PaginationDto } from "./dto/pagination.dto";

/** Helper: extract the real client IP from the request */
function getClientIp(req: any): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

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

  @Get("manual-assignment/nannies/:id")
  async getAvailableNanniesForRequest(@Param("id") id: string) {
    return this.adminService.getAvailableNanniesForRequest(id);
  }

  @Post("manual-assignment/assign")
  async manuallyAssignNanny(@Body() dto: AdminManualAssignmentDto) {
    return this.adminService.manuallyAssignNanny(dto.requestId, dto.nannyId, dto.bookingId, dto.force);
  }

  // User Management
  @Get("users")
  async getAllUsers(@Query() query: PaginationDto) {
    return this.adminService.getAllUsers(query);
  }

  @Get("users/:id/full-profile")
  async getUserFullProfile(@Param("id") id: string) {
    return this.adminService.getUserFullProfile(id);
  }

  @Put("users/:id/verify")
  async verifyUser(@Param("id") userId: string, @Req() req: any) {
    return this.adminService.verifyUser(userId, req.user.id, getClientIp(req));
  }

  @Put("users/:id/ban")
  async banUser(
    @Param("id") userId: string,
    @Body("reason") reason: string | undefined,
    @Req() req: any,
  ) {
    return this.adminService.banUser(userId, reason, req.user.id, getClientIp(req));
  }

  @Put("users/:id/unban")
  async unbanUser(@Param("id") userId: string, @Req() req: any) {
    return this.adminService.unbanUser(userId, req.user.id, getClientIp(req));
  }

  // Category Request Management
  @Get("category-requests")
  async getCategoryRequests(@Query("status") status?: string) {
    return this.adminService.getCategoryRequests(status);
  }

  @Put("category-requests/:id/approve")
  async approveCategoryRequest(
    @Param("id") id: string,
    @Body("notes") notes: string | undefined,
    @Req() req: any,
  ) {
    return this.adminService.updateCategoryRequestStatus(
      id,
      "approved",
      notes,
      req.user.id,
      getClientIp(req),
    );
  }

  @Put("category-requests/:id/reject")
  async rejectCategoryRequest(
    @Param("id") id: string,
    @Body("notes") notes: string | undefined,
    @Req() req: any,
  ) {
    return this.adminService.updateCategoryRequestStatus(
      id,
      "rejected",
      notes,
      req.user.id,
      getClientIp(req),
    );
  }

  // Booking Management
  @Get("bookings")
  async getAllBookings(@Query() query: PaginationDto) {
    return this.adminService.getAllBookings(query);
  }

  @Get("recurring-requests")
  async getAllRecurringRequests(@Query() query: PaginationDto) {
    return this.adminService.getAllRecurringRequests(query);
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
    @Req() req: any,
  ) {
    return this.adminService.resolveDispute(id, resolution, req.user.id, getClientIp(req));
  }

  // Payment Monitoring
  @Get("payments")
  async getAllPayments(@Query() query: PaginationDto) {
    return this.adminService.getAllPayments(query);
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
  async getAllReviews(@Query() query: PaginationDto) {
    return this.adminService.getAllReviews(query);
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
  async updateSetting(
    @Param("key") key: string,
    @Body("value") value: any,
    @Req() req: any,
  ) {
    return this.adminService.updateSetting(key, value, req.user.id, getClientIp(req));
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
