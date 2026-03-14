import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDisputeDto } from './dto/create-dispute.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';

@Injectable()
export class DisputesService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateDisputeDto) {
    // Validate booking ownership
    const booking = await this.prisma.bookings.findUnique({
      where: { id: dto.bookingId },
    });

    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.parent_id !== userId && booking.nanny_id !== userId) {
      throw new BadRequestException('You can only raise disputes for your own bookings');
    }

    return this.prisma.disputes.create({
      data: {
        booking_id: dto.bookingId,
        raised_by: userId,
        reason: dto.reason,
        description: dto.description,
        status: 'open',
      },
    });
  }

  async findAll() {
    return this.prisma.disputes.findMany({
      orderBy: { created_at: 'desc' },
      include: {
        bookings: true,
        users_disputes_raised_byTousers: {
          select: { email: true, profiles: true },
        },
      },
    });
  }

  async findByUserId(userId: string) {
    return this.prisma.disputes.findMany({
      where: { raised_by: userId },
      orderBy: { created_at: 'desc' },
      include: {
        bookings: true,
      },
    });
  }

  async findOne(id: string) {
    const dispute = await this.prisma.disputes.findUnique({
      where: { id },
      include: {
        bookings: true,
        users_disputes_raised_byTousers: {
          select: { email: true, profiles: true },
        },
      },
    });
    if (!dispute) throw new NotFoundException('Dispute not found');
    return dispute;
  }

  async resolve(id: string, adminId: string, dto: ResolveDisputeDto) {
    const dispute = await this.prisma.disputes.findUnique({ where: { id } });
    if (!dispute) throw new NotFoundException('Dispute not found');
    if (dispute.status !== 'open') throw new BadRequestException('Dispute is already resolved');

    return this.prisma.disputes.update({
      where: { id },
      data: {
        status: 'resolved',
        resolution: dto.resolution,
        resolved_by: adminId,
        updated_at: new Date(),
      },
    });
  }
}
