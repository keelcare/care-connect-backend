import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  UseGuards,
  Request,
  ForbiddenException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiBody } from '@nestjs/swagger';
import { BookingsService } from "./bookings.service";
import { AuthGuard } from "@nestjs/passport";
import { ActiveUserGuard } from "../common/guards/active-user.guard";

@ApiTags('Bookings')
@ApiBearerAuth()
@Controller("bookings")
@UseGuards(AuthGuard("jwt"), ActiveUserGuard)
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) { }

  @Get("active")
  @ApiOperation({ summary: 'Get all active bookings for the current user' })
  @ApiResponse({ status: 200, description: 'Return list of active bookings' })
  async getActiveBookings(@Request() req) {
    const role = req.user.role === "nanny" ? "nanny" : "parent";
    return this.bookingsService.getActiveBookings(req.user.id, role);
  }

  @Get("parent/me")
  @ApiOperation({ summary: 'Get all bookings for the current parent' })
  @ApiResponse({ status: 200, description: 'Return list of parent bookings' })
  async getMyParentBookings(@Request() req) {
    return this.bookingsService.getBookingsByParent(req.user.id);
  }

  @Get("nanny/me")
  @ApiOperation({ summary: 'Get all bookings for the current nanny' })
  @ApiResponse({ status: 200, description: 'Return list of nanny bookings' })
  async getMyNannyBookings(@Request() req) {
    return this.bookingsService.getBookingsByNanny(req.user.id);
  }

  @Get(":id")
  @ApiOperation({ summary: 'Get detailed information about a specific booking' })
  @ApiResponse({ status: 200, description: 'Return booking details' })
  @ApiResponse({ status: 403, description: 'Forbidden - not apart of this booking' })
  async getBooking(@Param("id") id: string, @Request() req) {
    const booking = await this.bookingsService.getBookingById(id);
    if (
      booking.parent_id !== req.user.id &&
      booking.nanny_id !== req.user.id &&
      req.user.role !== "admin"
    ) {
      throw new ForbiddenException(
        "You are not authorized to view this booking",
      );
    }
    return booking;
  }

  @Put(":id/start")
  @ApiOperation({ summary: 'Start a booking (Nanny only)' })
  @ApiResponse({ status: 200, description: 'Booking started successfully' })
  @ApiResponse({ status: 403, description: 'Forbidden - only the assigned nanny can start' })
  async startBooking(@Param("id") id: string, @Request() req) {
    const booking = await this.bookingsService.getBookingById(id);
    if (booking.nanny_id !== req.user.id) {
      throw new ForbiddenException(
        "Only the assigned nanny can start the booking",
      );
    }
    return this.bookingsService.startBooking(id);
  }

  @Put(":id/complete")
  @ApiOperation({ summary: 'Mark a booking as completed' })
  @ApiResponse({ status: 200, description: 'Booking completed successfully' })
  async completeBooking(@Param("id") id: string, @Request() req) {
    const booking = await this.bookingsService.getBookingById(id);
    if (booking.nanny_id !== req.user.id && booking.parent_id !== req.user.id) {
      throw new ForbiddenException("Not authorized to complete this booking");
    }
    return this.bookingsService.completeBooking(id);
  }

  @Put(":id/cancel")
  @ApiOperation({ summary: 'Cancel a booking' })
  @ApiBody({ schema: { properties: { reason: { type: 'string' } } } })
  @ApiResponse({ status: 200, description: 'Booking cancelled successfully' })
  async cancelBooking(
    @Param("id") id: string,
    @Body("reason") reason: string,
    @Request() req,
  ) {
    const booking = await this.bookingsService.getBookingById(id);
    if (booking.nanny_id !== req.user.id && booking.parent_id !== req.user.id) {
      throw new ForbiddenException("Not authorized to cancel this booking");
    }
    return this.bookingsService.cancelBooking(id, reason, req.user.id);
  }

  @Put(":id/reschedule")
  @ApiOperation({ summary: 'Reschedule a booking' })
  @ApiResponse({ status: 200, description: 'Booking rescheduled successfully' })
  async rescheduleBooking(
    @Param("id") id: string,
    @Body()
    body: {
      date: string;
      startTime: string;
      endTime: string;
    },
    @Request() req,
  ) {
    return this.bookingsService.rescheduleBooking(
      id,
      body.date,
      body.startTime,
      body.endTime,
      req.user.id,
    );
  }

  @Post("check-expired")
  @ApiOperation({ summary: 'Manually trigger a check for expired bookings' })
  @ApiResponse({ status: 200, description: 'Expired bookings checked and processed' })
  async checkExpired() {
    const result = await this.bookingsService.checkExpiredBookings();
    return {
      message: `Checked for expired bookings successfully`,
      data: result,
    };
  }

  @Put(":id/no-show")
  @ApiOperation({ summary: 'Mark a booking as a parent no-show (Nanny only)' })
  @ApiResponse({ status: 200, description: 'Booking marked as no-show successfully' })
  async markNoShow(@Param("id") id: string, @Request() req) {
    const booking = await this.bookingsService.getBookingById(id);
    if (booking.nanny_id !== req.user.id) {
      throw new ForbiddenException("Only the assigned nanny can mark a no-show");
    }
    return this.bookingsService.handleNoShow(id);
  }
}
