import {
  Injectable,
  Logger,
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
import { BookingStatus } from "../common/constants/booking-status.enum";

@Injectable()
export class AssignmentsService {
  private readonly logger = new Logger(AssignmentsService.name);

  constructor(
    private prisma: PrismaService,
    private requestsService: RequestsService,
    private notificationsService: NotificationsService,
    private chatService: ChatService,
    private sseService: SseService,
    private mailService: MailService,
  ) {}

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

  async findOne(id: string, userId: string, role: string) {
    const assignment = await this.prisma.assignments.findUnique({
      where: { id },
      include: {
        service_requests: {
          include: { users: { include: { profiles: true } } },
        },
      },
    });

    if (!assignment) throw new NotFoundException("Assignment not found");

    // Scope the read to the assigned nanny, the request's parent, or an admin.
    // Return NotFound for anyone else so the assignment isn't enumerable.
    const isNanny = assignment.nanny_id === userId;
    const isParent = assignment.service_requests?.parent_id === userId;
    if (!isNanny && !isParent && role !== "admin") {
      throw new NotFoundException("Assignment not found");
    }
    return assignment;
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

    // The request window this acceptance would occupy — needed for the in-tx
    // availability re-check below.
    const requestStartTime = TimeUtils.combineDateAndTime(
      assignment.service_requests.date,
      assignment.service_requests.start_time,
    );
    const requestEndTime = TimeUtils.getEndTime(
      requestStartTime,
      Number(assignment.service_requests.duration_hours),
    );

    // Use a transaction to ensure all updates happen atomically and safely
    const { updatedAssignment, updatedBooking } = await this.prisma.$transaction(async (tx) => {
      // 1. Atomically CLAIM the acceptance. The status check above was a stale
      // read: the timeout cron, a concurrent reject, or a parent cancellation
      // can flip this assignment between that read and this write. An unguarded
      // update would overwrite that transition and confirm a booking for an
      // assignment that already timed out or was cancelled. The status guard
      // makes exactly one responder win; a count of 0 means we lost the race.
      const claimed = await tx.assignments.updateMany({
        where: { id, status: "pending" },
        data: {
          status: "accepted",
          responded_at: new Date(),
        },
      });
      if (claimed.count === 0) {
        throw new BadRequestException("Assignment is not pending");
      }

      // 1b. RE-VERIFY AVAILABILITY. Auto-matching re-checks for overlapping
      // bookings inside its transaction, but the manual accept path never did —
      // a nanny holding a pending assignment could get booked for an
      // overlapping slot (auto-match, admin assignment) and still accept this
      // one, double-booking themselves. Throwing rolls the claim back, so the
      // assignment stays pending for them to reject.
      const overlap = await tx.bookings.findFirst({
        where: {
          nanny_id: nannyId,
          status: {
            in: [
              BookingStatus.CONFIRMED,
              BookingStatus.IN_PROGRESS,
              BookingStatus.REQUESTED,
            ],
          },
          start_time: { lt: requestEndTime },
          end_time: { gt: requestStartTime },
        },
      });
      if (overlap) {
        throw new BadRequestException(
          "You already have a booking that overlaps this time slot.",
        );
      }

      const updatedAssignment = await tx.assignments.findUniqueOrThrow({
        where: { id },
        include: {
          service_requests: {
            include: {
              users: { include: { profiles: true } }, // Parent
            },
          },
          users: { include: { profiles: true } }, // Nanny
        },
      });

      // 2. Update request status — guarded, so accepting can never resurrect a
      // request that was cancelled/expired between the read and this write.
      // current_assignment_id is set here for parity with the auto-accept path
      // in triggerMatching(), which has always recorded it.
      const requestClaim = await tx.service_requests.updateMany({
        where: {
          id: assignment.request_id,
          status: { in: ["pending", "accepted", "assigned"] },
        },
        data: { status: "accepted", current_assignment_id: id },
      });
      if (requestClaim.count === 0) {
        throw new BadRequestException(
          "This request is no longer active. It may have been cancelled.",
        );
      }

      // 3. Find and Update Existing Booking
      // We look for any booking associated with this request that isn't cancelled.
      const existingBooking = await tx.bookings.findFirst({
        where: {
          request_id: assignment.request_id,
          status: { not: "CANCELLED" },
        },
      });

      if (!existingBooking) {
        // Instead of creating a duplicate, we throw an error. This identifies a system inconsistency.
        throw new BadRequestException(
          "No active booking found for this request. It may have been cancelled.",
        );
      }

      // Guarded claim: only a booking still awaiting assignment (or already
      // confirmed for this request) may be confirmed here. Without the status
      // guard a booking cancelled/started between the findFirst above and this
      // write would be silently flipped back to CONFIRMED.
      const bookingClaim = await tx.bookings.updateMany({
        where: {
          id: existingBooking.id,
          status: { in: [BookingStatus.REQUESTED, BookingStatus.CONFIRMED] },
        },
        data: {
          nanny_id: nannyId,
          status: BookingStatus.CONFIRMED,
          // Update times from request just in case
          start_time: TimeUtils.combineDateAndTime(
            updatedAssignment.service_requests.date.toISOString().split("T")[0],
            updatedAssignment.service_requests.start_time,
          ),
          end_time: TimeUtils.getEndTime(
            TimeUtils.combineDateAndTime(
              updatedAssignment.service_requests.date
                .toISOString()
                .split("T")[0],
              updatedAssignment.service_requests.start_time,
            ),
            Number(updatedAssignment.service_requests.duration_hours),
          ),
        },
      });
      if (bookingClaim.count === 0) {
        throw new BadRequestException(
          "The booking for this request can no longer be confirmed.",
        );
      }
      const updatedBooking = await tx.bookings.findUniqueOrThrow({
        where: { id: existingBooking.id },
      });

      // 3.5 Create recurring booking record if subscription
      await this.requestsService.createRecurringRecord(
        tx,
        assignment.request_id,
        nannyId,
      );

      // 3.6 Create payment plan if subscription
      await this.requestsService.createPaymentPlan(
        tx,
        assignment.request_id,
        updatedBooking.id,
        updatedAssignment.service_requests.parent_id,
      );

      // 4. Update acceptance rate
      await this.updateAcceptanceRateInternal(nannyId, tx);

      return { updatedAssignment, updatedBooking };
    });

    // ---- Post-commit side effects ----
    // Everything below used to run INSIDE the transaction. Notifications write
    // through the main prisma client (not the tx), and emails/SSE are external
    // sends — none of them roll back. A failure in a later transactional step
    // therefore left the parent with a "Booking Confirmed!" notification and
    // confirmation emails for a booking that was never confirmed. They now run
    // only after the transaction has committed, matching the events-after-commit
    // pattern used across the codebase.

    // Create Chat for this booking
    try {
      await this.chatService.createChat(updatedBooking.id);
    } catch (error) {
      this.logger.error(
        `Failed to create chat for booking ${updatedBooking.id}`,
        (error as Error)?.stack,
      );
    }

    // Notify Parent
    await this.notificationsService.createNotification(
      updatedAssignment.service_requests.parent_id,
      "Booking Confirmed!",
      `A nanny has accepted your request. Tap to view booking details.`,
      "success",
    );

    {
      const parent = updatedAssignment.service_requests.users;
      const nanny = updatedAssignment.users;
      const parentName =
        `${parent.profiles?.first_name || ""} ${parent.profiles?.last_name || ""}`.trim() ||
        "Parent";
      const nannyName =
        `${nanny.profiles?.first_name || ""} ${nanny.profiles?.last_name || ""}`.trim() ||
        "Nanny";

      const bookingDetails = {
        date: updatedAssignment.service_requests.date
          .toISOString()
          .split("T")[0],
        time: updatedAssignment.service_requests.start_time.toLocaleTimeString(
          [],
          { hour: "2-digit", minute: "2-digit" },
        ),
        duration: Number(updatedAssignment.service_requests.duration_hours),
        location: parent.profiles?.address || "Location specified in profile",
      };

      // Email to Parent
      this.mailService
        .sendBookingConfirmationEmail(parent.email, parentName, "parent", {
          ...bookingDetails,
          otherPartyName: nannyName,
        })
        .catch((err) =>
          this.logger.error(
            "Failed to send parent confirmation email",
            err?.stack,
          ),
        );

      // Email to Nanny
      this.mailService
        .sendBookingConfirmationEmail(nanny.email, nannyName, "nanny", {
          ...bookingDetails,
          otherPartyName: parentName,
        })
        .catch((err) =>
          this.logger.error(
            "Failed to send nanny confirmation email",
            err?.stack,
          ),
        );

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
    }

    return { assignment: updatedAssignment, booking: updatedBooking };
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

    // 1. Atomically CLAIM the rejection. Guarded for the same reason as
    // accept(): a concurrent accept, the timeout cron, or a parent cancellation
    // can flip this row after the read above, and an unguarded update would
    // stamp "rejected" over an assignment that was already accepted — and then
    // trigger a re-match against a request that is confirmed.
    const claimed = await this.prisma.assignments.updateMany({
      where: { id, status: "pending" },
      data: {
        status: "rejected",
        rejection_reason: reason,
        responded_at: new Date(),
      },
    });
    if (claimed.count === 0) {
      throw new BadRequestException("Assignment is not pending");
    }

    // 2. Update acceptance rate
    await this.updateAcceptanceRateInternal(nannyId);

    // 3. Trigger re-matching
    this.logger.log(`Assignment ${id} rejected. Triggering re-match...`);
    // Run in background to not block response
    this.requestsService.triggerMatching(assignment.request_id).catch((err) => {
      this.logger.error(
        `Error triggering matching for request ${assignment.request_id}`,
        err?.stack,
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
