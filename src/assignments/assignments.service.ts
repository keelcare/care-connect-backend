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
import { SseService } from "../sse/sse.service";
import { SSE_EVENTS } from "../events/sse-event.types";
import { MailService } from "../mail/mail.service";
import { TimeUtils } from "../common/utils/time.utils";

@Injectable()
export class AssignmentsService {
  constructor(
    private prisma: PrismaService,
    private requestsService: RequestsService,
    private notificationsService: NotificationsService,
    private chatService: ChatService,
    private sseService: SseService,
    private mailService: MailService,
  ) { }

  async findAllByNanny(nannyId: string) {
    return this.prisma.assignments.findMany({
      where: { nanny_id: nannyId },
      orderBy: { created_at: "desc" },
      include: {
        service_requests: {
          include: { users: { include: { profiles: true } } },
        },
      },
    });
  }

  async findPendingByNanny(nannyId: string) {
    return this.prisma.assignments.findMany({
      where: {
        nanny_id: nannyId,
        status: "pending",
      },
      orderBy: { created_at: "desc" },
      include: {
        service_requests: {
          include: { users: { include: { profiles: true } } },
        },
      },
    });
  }

  async findOne(id: string) {
    return this.prisma.assignments.findUnique({
      where: { id },
      include: {
        service_requests: {
          include: { users: { include: { profiles: true } } },
        },
      },
    });
  }

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

    // Use a transaction to ensure all updates happen atomically and safely
    return await this.prisma.$transaction(async (tx) => {
      // 1. Update assignment status
      const updatedAssignment = await tx.assignments.update({
        where: { id },
        data: {
          status: "accepted",
          responded_at: new Date(),
        },
        include: {
          service_requests: {
            include: {
              users: { include: { profiles: true } } // Parent
            }
          },
          users: { include: { profiles: true } } // Nanny
        },
      });

      // 2. Update request status
      await tx.service_requests.update({
        where: { id: assignment.request_id },
        data: { status: "accepted" },
      });

      // 3. Find and Update Existing Booking
      // We look for any booking associated with this request that isn't cancelled.
      const existingBooking = await tx.bookings.findFirst({
        where: {
          request_id: assignment.request_id,
          status: { not: "CANCELLED" }
        }
      });

      if (!existingBooking) {
        // Instead of creating a duplicate, we throw an error. This identifies a system inconsistency.
        throw new BadRequestException("No active booking found for this request. It may have been cancelled.");
      }

      const updatedBooking = await tx.bookings.update({
        where: { id: existingBooking.id },
        data: {
          nanny_id: nannyId,
          status: "CONFIRMED",
          // Update times from request just in case
          start_time: TimeUtils.combineDateAndTime(
            updatedAssignment.service_requests.date.toISOString().split("T")[0],
            updatedAssignment.service_requests.start_time
          ),
          end_time: TimeUtils.getEndTime(
            TimeUtils.combineDateAndTime(
              updatedAssignment.service_requests.date.toISOString().split("T")[0],
              updatedAssignment.service_requests.start_time
            ),
            Number(updatedAssignment.service_requests.duration_hours)
          ),
        }
      });

      // 3.5 Create recurring booking record if subscription
      await this.requestsService.createRecurringRecord(tx, assignment.request_id, nannyId);

      // 4. Create Chat for this booking (Atomically)
      try {
        await this.chatService.createChat(updatedBooking.id);
      } catch (error) {
        console.error("Failed to create chat for booking in transaction:", updatedBooking.id, error);
      }

      // 5. Update acceptance rate
      await this.updateAcceptanceRateInternal(nannyId, tx);

      // 6. Notify Parent
      await this.notificationsService.createNotification(
        updatedAssignment.service_requests.parent_id,
        "Booking Confirmed!",
        `A nanny has accepted your request. Tap to view booking details.`,
        "success",
      );

      // 7. Send Emails (Outside the core logic but within the transaction's success scope - actually, better to do after transaction fails, but Nest will rollback if any error occurs here)
      const parent = updatedAssignment.service_requests.users;
      const nanny = updatedAssignment.users;
      const parentName = `${parent.profiles?.first_name || ''} ${parent.profiles?.last_name || ''}`.trim() || 'Parent';
      const nannyName = `${nanny.profiles?.first_name || ''} ${nanny.profiles?.last_name || ''}`.trim() || 'Nanny';

      const bookingDetails = {
        date: updatedAssignment.service_requests.date.toISOString().split('T')[0],
        time: updatedAssignment.service_requests.start_time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        duration: Number(updatedAssignment.service_requests.duration_hours),
        location: parent.profiles?.address || 'Location specified in profile',
      };

      // Email to Parent
      this.mailService.sendBookingConfirmationEmail(
        parent.email,
        parentName,
        'parent',
        { ...bookingDetails, otherPartyName: nannyName }
      ).catch(err => console.error("Failed to send parent confirmation email", err));

      // Email to Nanny
      this.mailService.sendBookingConfirmationEmail(
        nanny.email,
        nannyName,
        'nanny',
        { ...bookingDetails, otherPartyName: parentName }
      ).catch(err => console.error("Failed to send nanny confirmation email", err));

      // Emit SSE to parent
      this.sseService.emitToUser(updatedAssignment.service_requests.parent_id, {
        type: SSE_EVENTS.ASSIGNMENT_ACCEPTED,
        data: { assignment: updatedAssignment, booking: updatedBooking },
        timestamp: new Date().toISOString(),
      });
      // Also emit a booking update so the parent's booking list refreshes
      this.sseService.emitToUser(updatedAssignment.service_requests.parent_id, {
        type: SSE_EVENTS.BOOKING_UPDATED,
        data: updatedBooking,
        timestamp: new Date().toISOString(),
      });

      return { assignment: updatedAssignment, booking: updatedBooking };
    });
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
    await this.updateAcceptanceRateInternal(nannyId);

    // 3. Trigger re-matching
    console.log(`Assignment ${id} rejected. Triggering re-match...`);
    // Run in background to not block response
    this.requestsService.triggerMatching(assignment.request_id).catch((err) => {
      console.error(
        `Error triggering matching for request ${assignment.request_id}:`,
        err,
      );
    });

    // Emit SSE to nanny (their assignment list should update)
    this.sseService.emitToUser(nannyId, {
      type: SSE_EVENTS.ASSIGNMENT_REJECTED,
      data: { assignmentId: id, requestId: assignment.request_id },
      timestamp: new Date().toISOString(),
    });

    return { success: true };
  }

  private async updateAcceptanceRateInternal(nannyId: string, tx?: any) {
    const prisma = tx || this.prisma;
    const assignments = await prisma.assignments.findMany({
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

    await prisma.nanny_details.update({
      where: { user_id: nannyId },
      data: { acceptance_rate: rate },
    });
  }
}
