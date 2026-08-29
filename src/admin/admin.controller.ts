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
import {
  RevenueQueryDto,
  UpdateCommissionDto,
  UpdateMatchingFeeDto,
} from "./dto/revenue-query.dto";
import { RevenueService } from "./revenue.service";
import { BookingStatusLogService } from "../bookings/booking-status-log.service";
import { AdminAuditService } from "./admin-audit.service";
import { AuditLogQueryDto } from "./dto/audit-log-query.dto";
import { ReviewQueryDto } from "./dto/review-query.dto";
import { ResolveDisputeDto } from "../disputes/dto/resolve-dispute.dto";

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
  constructor(
    private readonly adminService: AdminService,
    private readonly revenueService: RevenueService,
    private readonly bookingStatusLog: BookingStatusLogService,
    private readonly adminAuditService: AdminAuditService,
  ) {}

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

  // Support-initiated recovery of an account within its 30-day deletion window.
  @Put("users/:id/restore")
  async restoreUser(@Param("id") userId: string, @Req() req: any) {
    return this.adminService.restoreUser(userId, req.user.id, getClientIp(req));
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

  // Admin action audit trail. Every logAction() write across the admin and
  // revenue services lands here; this is the read side.
  @Get("audit-log")
  async getAuditLog(@Query() query: AuditLogQueryDto) {
    return this.adminAuditService.findAll(query);
  }

  // Booking Management
  @Get("bookings")
  async getAllBookings(@Query() query: PaginationDto) {
    return this.adminService.getAllBookings(query);
  }

  // Full status-transition history for one booking (audit trail for ops).
  @Get("bookings/:id/history")
  async getBookingStatusHistory(@Param("id") id: string) {
    return this.bookingStatusLog.getHistory(id);
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
    // Full DTO rather than @Body("resolution"): the financial outcome is now an
    // explicit, validated field instead of being guessed from the note text.
    @Body() dto: ResolveDisputeDto,
    @Req() req: any,
  ) {
    return this.adminService.resolveDispute(id, dto, req.user.id, getClientIp(req));
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
  async getAllReviews(@Query() query: ReviewQueryDto) {
    return this.adminService.getAllReviews(query);
  }

  @Put("reviews/:id/approve")
  async approveReview(@Param("id") id: string, @Req() req: any) {
    return this.adminService.approveReview(id, req.user.id, getClientIp(req));
  }

  @Put("reviews/:id/reject")
  async rejectReview(@Param("id") id: string, @Req() req: any) {
    return this.adminService.rejectReview(id, req.user.id, getClientIp(req));
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

  // Revenue & Payouts
  @Get("revenue/summary")
  async getRevenueSummary(@Query() query: RevenueQueryDto) {
    return this.revenueService.getSummary(query);
  }

  @Get("revenue/trend")
  async getRevenueTrend(@Query() query: RevenueQueryDto) {
    return this.revenueService.getTrend(query);
  }

  @Get("revenue/payouts")
  async getOutstandingPayouts(@Query() query: RevenueQueryDto) {
    return this.revenueService.getOutstandingPayouts(query);
  }

  @Post("revenue/payouts/:paymentId/release")
  async releasePayout(@Param("paymentId") paymentId: string, @Req() req: any) {
    return this.revenueService.releasePayout(paymentId, req.user.id, getClientIp(req));
  }

  /**
   * Sends the caregiver everything she is owed. **This moves real money** — it is no
   * longer a bookkeeping flag. Body accepts `{ manual: true }` to record a
   * settlement made outside the platform instead.
   */
  @Post("revenue/payouts/nanny/:nannyId/release")
  async releasePayoutsForNanny(
    @Param("nannyId") nannyId: string,
    @Req() req: any,
    @Body() body: { manual?: boolean; note?: string } = {},
  ) {
    return this.revenueService.releasePayoutsForNanny(
      nannyId,
      req.user.id,
      getClientIp(req),
      { manual: body?.manual, note: body?.note },
    );
  }

  @Get("revenue/commission")
  async getCommission() {
    return { percent: await this.revenueService.getCommissionPercent() };
  }

  @Post("revenue/commission")
  async updateCommission(@Body() body: UpdateCommissionDto, @Req() req: any) {
    return this.revenueService.setCommissionPercent(
      body.percent,
      req.user.id,
      getClientIp(req),
    );
  }

  @Get("revenue/matching-fee")
  async getMatchingFee() {
    return this.revenueService.getMatchingFee();
  }

  @Post("revenue/matching-fee")
  async updateMatchingFee(@Body() body: UpdateMatchingFeeDto, @Req() req: any) {
    return this.revenueService.setMatchingFee(
      body.enabled,
      body.amount,
      req.user.id,
      getClientIp(req),
    );
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
