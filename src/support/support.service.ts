import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateTicketDto } from "./dto/create-ticket.dto";
import { UpdateTicketDto } from "./dto/update-ticket.dto";

// Include used to surface both booking parties (parent + nanny) on a ticket.
const bookingParties = {
  users_bookings_parent_idTousers: { include: { profiles: true } },
  users_bookings_nanny_idTousers: { include: { profiles: true } },
} as const;

@Injectable()
export class SupportService {
  constructor(private prisma: PrismaService) {}

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

    return this.prisma.support_tickets.create({
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
      select: { id: true, user_id: true, status: true },
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
    // an admin first replies.
    await this.prisma.support_tickets.update({
      where: { id: ticketId },
      data: {
        updated_at: new Date(),
        ...(isAdmin && ticket.status === "open"
          ? { status: "in_progress" }
          : {}),
      },
    });

    return message;
  }
}
