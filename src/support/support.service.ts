import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';

@Injectable()
export class SupportService {
    constructor(private prisma: PrismaService) { }

    async createTicket(userId: string, role: string, dto: CreateTicketDto) {
        const ticketCount = await this.prisma.support_tickets.count();
        const ticketNumber = `TIC-${1000 + ticketCount + 1}`;

        return this.prisma.support_tickets.create({
            data: {
                ticket_number: ticketNumber,
                user_id: userId,
                role: role,
                subject: dto.subject,
                description: dto.description,
                category: dto.category,
                priority: dto.priority || 'medium',
            },
        });
    }

    async getUserTickets(userId: string) {
        return this.prisma.support_tickets.findMany({
            where: { user_id: userId },
            orderBy: { created_at: 'desc' },
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
            orderBy: { created_at: 'desc' },
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

    async updateTicket(id: string, dto: UpdateTicketDto) {
        const data: any = { ...dto };

        if (dto.status === 'resolved' || dto.status === 'closed') {
            data.resolved_at = new Date();
        }

        return this.prisma.support_tickets.update({
            where: { id },
            data,
        });
    }
}
