import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { CreateTicketDto } from "./dto/create-ticket.dto";
import { UpdateTicketDto } from "./dto/update-ticket.dto";

// Include used to surface both booking parties (parent + nanny) on a ticket.
const bookingParties = {
  users_bookings_parent_idTousers: { include: { profiles: true } },
  users_bookings_nanny_idTousers: { include: { profiles: true } },
} as const;

@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
  ) {}

  async createTicket(userId: string, role: string, dto: CreateTicketDto) {
    if (dto.category === "account") {
      const openBanAppeal = await this.prisma.support_tickets.findFirst({
        where: {
          user_id: userId,
          category: "account",
          status: {
            notIn: ["resolved", "closed"],
          },
        },
      });

      if (openBanAppeal) {
        throw new BadRequestException(
          "You already have an open ban appeal ticket.",
        );
      }
    }

    // If the ticket is linked to a booking, ensure the raiser is a party to it.
    if (dto.bookingId) {
      const booking = await this.prisma.bookings.findUnique({
        where: { id: dto.bookingId },
        select: { parent_id: true, nanny_id: true },
      });
      if (!booking) {
        throw new NotFoundException("Booking not found");
      }
      if (booking.parent_id !== userId && booking.nanny_id !== userId) {
        throw new ForbiddenException(
          "You are not a participant in this booking",
        );
      }
    }

    const ticketCount = await this.prisma.support_tickets.count();
    const ticketNumber = `TIC-${1000 + ticketCount + 1}`;

    const ticket = await this.prisma.support_tickets.create({
      data: {
        ticket_number: ticketNumber,
        user_id: userId,
        booking_id: dto.bookingId ?? null,
        role: role,
        subject: dto.subject,
        description: dto.description,
        category: dto.category,
        priority: dto.priority || "medium",
      },
    });

    // Best-effort: a failed notification must never fail ticket creation.
    try {
      const admins = await this.prisma.users.findMany({
        where: { role: "admin" },
        select: { id: true },
      });
      const bookingRef = dto.bookingId
        ? ` for booking #${dto.bookingId.substring(0, 8)}`
        : "";
      for (const admin of admins) {
        await this.notificationsService.createNotification(
          admin.id,
          `New support ticket ${ticketNumber}`,
          `A ${role} raised a ${dto.priority || "medium"}-priority ${dto.category} ticket${bookingRef}: "${dto.subject}"`,
          dto.priority === "high" || dto.priority === "critical"
            ? "warning"
            : "info",
          "support",
          ticket.id,
        );
      }
    } catch (err) {
      this.logger.error("Failed to notify admins about new ticket", err);
    }

    return ticket;
  }

  async getUserTickets(userId: string) {
    return this.prisma.support_tickets.findMany({
      where: { user_id: userId },
      orderBy: { created_at: "desc" },
    });
  }

  async getAllTickets() {
    return this.prisma.support_tickets.findMany({
      include: {
        users: {
          include: {
            profiles: true,
          },
        },
      },
      orderBy: { created_at: "desc" },
    });
  }

  async getTicketById(id: string, userId?: string, isAdmin = false) {
    const ticket = await this.prisma.support_tickets.findUnique({
      where: { id },
      include: {
        users: {
          include: {
            profiles: true,
          },
        },
      },
    });

    if (!ticket) {
      throw new NotFoundException(`Ticket with ID ${id} not found`);
    }

    if (!isAdmin && ticket.user_id !== userId) {
      throw new NotFoundException(`Ticket with ID ${id} not found`);
    }

    return ticket;
  }

  // Full ticket for the admin detail view: requester + linked booking with
  // both parties + the full message thread.
  async adminGetTicketById(id: string) {
    const ticket = await this.prisma.support_tickets.findUnique({
      where: { id },
      include: {
        users: { include: { profiles: true } },
        bookings: { include: bookingParties },
        support_ticket_messages: {
          orderBy: { created_at: "asc" },
          include: { sender: { include: { profiles: true } } },
        },
      },
    });

    if (!ticket) {
      throw new NotFoundException(`Ticket with ID ${id} not found`);
    }

    return ticket;
  }

  async updateTicket(id: string, dto: UpdateTicketDto) {
    const data: any = { ...dto };

    if (dto.status === "resolved" || dto.status === "closed") {
      data.resolved_at = new Date();
    }

    return this.prisma.support_tickets.update({
      where: { id },
      data,
    });
  }

  // Authorization helper: the ticket owner or an admin may read/write messages.
  private async assertCanAccess(
    ticketId: string,
    userId: string,
    isAdmin: boolean,
  ) {
    const ticket = await this.prisma.support_tickets.findUnique({
      where: { id: ticketId },
      select: { id: true, user_id: true, status: true, first_response_at: true },
    });
    if (!ticket) {
      throw new NotFoundException(`Ticket with ID ${ticketId} not found`);
    }
    if (!isAdmin && ticket.user_id !== userId) {
      // Hide existence from non-owners.
      throw new NotFoundException(`Ticket with ID ${ticketId} not found`);
    }
    return ticket;
  }

  async getMessages(ticketId: string, userId: string, isAdmin: boolean) {
    await this.assertCanAccess(ticketId, userId, isAdmin);
    return this.prisma.support_ticket_messages.findMany({
      where: { ticket_id: ticketId },
      orderBy: { created_at: "asc" },
      include: { sender: { include: { profiles: true } } },
    });
  }

  async addMessage(
    ticketId: string,
    senderId: string,
    isAdmin: boolean,
    content: string,
  ) {
    const ticket = await this.assertCanAccess(ticketId, senderId, isAdmin);

    const message = await this.prisma.support_ticket_messages.create({
      data: {
        ticket_id: ticketId,
        sender_id: senderId,
        is_admin: isAdmin,
        content,
      },
      include: { sender: { include: { profiles: true } } },
    });

    // Keep the ticket fresh; move an untouched ticket into "in_progress" when
    // an admin first replies, and stop the SLA first-response timer.
    const firstAdminReply = isAdmin && !ticket.first_response_at;
    await this.prisma.support_tickets.update({
      where: { id: ticketId },
      data: {
        updated_at: new Date(),
        ...(isAdmin && ticket.status === "open" ? { status: "in_progress" } : {}),
        ...(firstAdminReply ? { first_response_at: new Date() } : {}),
      },
    });

    return message;
  }

  // Ops ownership: an admin claims (or reassigns) a ticket. Pass adminId=null to
  // release it back to the shared queue.
  async assignTicket(ticketId: string, adminId: string | null) {
    await this.prisma.support_tickets.findUniqueOrThrow({
      where: { id: ticketId },
      select: { id: true },
    });
    return this.prisma.support_tickets.update({
      where: { id: ticketId },
      data: { assigned_admin_id: adminId, updated_at: new Date() },
    });
  }

  // Customer satisfaction, submitted by the raiser once the ticket is done.
  async submitCsat(
    ticketId: string,
    userId: string,
    rating: number,
    comment?: string,
  ) {
    if (rating < 1 || rating > 5) {
      throw new BadRequestException("Rating must be between 1 and 5");
    }
    const ticket = await this.prisma.support_tickets.findUnique({
      where: { id: ticketId },
      select: { id: true, user_id: true, status: true },
    });
    if (!ticket || ticket.user_id !== userId) {
      throw new NotFoundException(`Ticket with ID ${ticketId} not found`);
    }
    if (ticket.status !== "resolved" && ticket.status !== "closed") {
      throw new BadRequestException(
        "You can only rate a ticket once it has been resolved.",
      );
    }
    return this.prisma.support_tickets.update({
      where: { id: ticketId },
      data: { csat_rating: rating, csat_comment: comment ?? null },
    });
  }
}
