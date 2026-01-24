import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RequestsService } from "../requests/requests.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ChatService } from "../chat/chat.service";

@Injectable()
export class AssignmentsService {
  constructor(
    private prisma: PrismaService,
    private requestsService: RequestsService,
    private notificationsService: NotificationsService,
    private chatService: ChatService,
  ) { }

  // ... (findAllByNanny, findPendingByNanny, findOne remain same)

  async accept(id: string, nannyId: string) {
    const assignment = await this.prisma.assignments.findUnique({
      where: { id },
      include: { service_requests: true },
    });

    if (!assignment) throw new NotFoundException("Assignment not found");
    if (assignment.nanny_id !== nannyId)
      throw new ForbiddenException("Not authorized");
    if (assignment.status !== "pending")
      throw new BadRequestException("Assignment is not pending");

    // 1. Update assignment status
    const updatedAssignment = await this.prisma.assignments.update({
      where: { id },
      data: {
        status: "accepted",
        responded_at: new Date(),
      },
      include: {
        service_requests: true,
      },
    });

    // 2. Update request status
    await this.prisma.service_requests.update({
      where: { id: assignment.request_id },
      data: { status: "accepted" },
    });

    // 3. Update Existing Booking (that was created when request was made)
    // Find the booking first
    const existingBooking = await this.prisma.bookings.findFirst({
      where: {
        request_id: assignment.request_id,
        status: { in: ['requested', 'pending'] }
      }
    });

    let finalBookingId: string;

    if (!existingBooking) {
      // Fallback: Create if not found (should not happen with new flow, but safe for legacy)
      const newBooking = await this.prisma.bookings.create({
        data: {
          job_id: null,
          request_id: assignment.request_id,
          parent_id: assignment.service_requests.parent_id,
          nanny_id: nannyId,
          status: "CONFIRMED",
          start_time: new Date(
            assignment.service_requests.date.toISOString().split("T")[0] +
            "T" +
            assignment.service_requests.start_time.toISOString().split("T")[1],
          ),
          end_time: new Date(
            new Date(
              assignment.service_requests.date.toISOString().split("T")[0] +
              "T" +
              assignment.service_requests.start_time
                .toISOString()
                .split("T")[1],
            ).getTime() +
            Number(assignment.service_requests.duration_hours) * 60 * 60 * 1000,
          ),
        },
      });
      finalBookingId = newBooking.id;
    } else {
      // Update existing
      const updatedBooking = await this.prisma.bookings.update({
        where: { id: existingBooking.id },
        data: {
          nanny_id: nannyId,
          status: "CONFIRMED",
          // Update times just in case they drifted or were adjusted
          start_time: new Date(
            assignment.service_requests.date.toISOString().split("T")[0] +
            "T" +
            assignment.service_requests.start_time.toISOString().split("T")[1],
          ),
          end_time: new Date(
            new Date(
              assignment.service_requests.date.toISOString().split("T")[0] +
              "T" +
              assignment.service_requests.start_time
                .toISOString()
                .split("T")[1],
            ).getTime() +
            Number(assignment.service_requests.duration_hours) * 60 * 60 * 1000,
          ),
        }
      });
      finalBookingId = updatedBooking.id;
    }

    // 4. Create Chat for this booking (ONLY NOW that a nanny is assigned)
    try {
      await this.chatService.createChat(finalBookingId);
    } catch (error) {
      console.error("Failed to create chat for booking:", finalBookingId, error);
    }

    // Fetch fresh booking for return
    const booking = await this.prisma.bookings.findUnique({
      where: { id: finalBookingId }
    });

    // 5. Update acceptance rate
    await this.updateAcceptanceRate(nannyId);

    // 6. Notify Parent
    await this.notificationsService.createNotification(
      assignment.service_requests.parent_id,
      "Booking Confirmed!",
      `A nanny has accepted your request. Tap to view booking details.`,
      "success"
    );

    return { assignment: updatedAssignment, booking };
  }

  async reject(id: string, nannyId: string, reason?: string) {
    const assignment = await this.prisma.assignments.findUnique({
      where: { id },
      include: { service_requests: true },
    });

    if (!assignment) throw new NotFoundException("Assignment not found");
    if (assignment.nanny_id !== nannyId)
      throw new ForbiddenException("Not authorized");
    if (assignment.status !== "pending")
      throw new BadRequestException("Assignment is not pending");

    // 1. Update assignment status
    await this.prisma.assignments.update({
      where: { id },
      data: {
        status: "rejected",
        rejection_reason: reason,
        responded_at: new Date(),
      },
    });

    // 2. Update acceptance rate
    await this.updateAcceptanceRate(nannyId);

    // 3. Trigger re-matching
    console.log(`Assignment ${id} rejected. Triggering re-match...`);
    // Run in background to not block response
    this.requestsService.triggerMatching(assignment.request_id).catch((err) => {
      console.error(
        `Error triggering matching for request ${assignment.request_id}:`,
        err,
      );
    });

    return { success: true };
  }

  private async updateAcceptanceRate(nannyId: string) {
    const assignments = await this.prisma.assignments.findMany({
      where: {
        nanny_id: nannyId,
        status: { in: ["accepted", "rejected", "timeout"] }, // Only count responded assignments
      },
    });

    if (assignments.length === 0) return;

    const acceptedCount = assignments.filter(
      (a) => a.status === "accepted",
    ).length;
    const rate = (acceptedCount / assignments.length) * 100;

    await this.prisma.nanny_details.update({
      where: { user_id: nannyId },
      data: { acceptance_rate: rate },
    });
  }
}
