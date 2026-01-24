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
import { BookingsService } from "./bookings.service";
import { AuthGuard } from "@nestjs/passport";

@Controller("bookings")
@UseGuards(AuthGuard("jwt"))
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) { }

  // Temporary endpoint for testing creation until Feature 5 is ready
  @Post()
  async createBooking(
    @Body()
    body: {
      jobId?: string;
      nannyId: string;
      date?: string;
      startTime?: string;
      endTime?: string;
    },
    @Request() req,
  ) {
    console.log("Received booking request body:", body);
    // Assuming the creator is the parent
    return this.bookingsService.createBooking(
      body.jobId,
      req.user.id,
      body.nannyId,
      body.date,
      body.startTime,
      body.endTime,
    );
  }

  @Get("active")
  async getActiveBookings(@Request() req) {
    const role = req.user.role === "nanny" ? "nanny" : "parent";
    return this.bookingsService.getActiveBookings(req.user.id, role);
  }

  @Get("parent/me")
  async getMyParentBookings(@Request() req) {
    if (req.user.role !== "parent") {
      // In a real app, maybe allow admin or check logic. For now strict.
      // Actually, a user might be both? Let's just trust the token's ID.
    }
    return this.bookingsService.getBookingsByParent(req.user.id);
  }

  @Get("nanny/me")
  async getMyNannyBookings(@Request() req) {
    return this.bookingsService.getBookingsByNanny(req.user.id);
  }

  @Get(":id")
  async getBooking(@Param("id") id: string, @Request() req) {
    const booking = await this.bookingsService.getBookingById(id);
    // Security check: ensure user is part of the booking
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
  async startBooking(@Param("id") id: string, @Request() req) {
    // Only nanny can start? Or maybe parent too? Usually nanny upon arrival.
    const booking = await this.bookingsService.getBookingById(id);
    if (booking.nanny_id !== req.user.id) {
      throw new ForbiddenException(
        "Only the assigned nanny can start the booking",
      );
    }
    return this.bookingsService.startBooking(id);
  }

  @Put(":id/complete")
  async completeBooking(@Param("id") id: string, @Request() req) {
    // Only nanny can complete? Or parent?
    const booking = await this.bookingsService.getBookingById(id);
    if (booking.nanny_id !== req.user.id && booking.parent_id !== req.user.id) {
      throw new ForbiddenException("Not authorized to complete this booking");
    }
    return this.bookingsService.completeBooking(id);
  }

  @Put(":id/cancel")
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
}
