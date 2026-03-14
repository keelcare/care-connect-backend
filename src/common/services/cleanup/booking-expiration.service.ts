import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { TimeUtils } from '../../utils/time.utils';
import { BookingsService } from '../../../bookings/bookings.service';

@Injectable()
export class BookingExpirationService {
  private readonly logger = new Logger(BookingExpirationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bookingsService: BookingsService
  ) {}

  /**
   * Cron job that runs every hour to handle stale bookings.
   * 1. Marks unstarted CONFIRMED bookings as EXPIRED if 4 hours past start_time.
   * 2. Auto-completes IN_PROGRESS bookings if 8 hours past end_time.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handleStaleBookings() {
    this.logger.log('Running stale bookings expiration check...');
    const now = TimeUtils.nowIST();

    try {
      // 1. Handle Unstarted Bookings (CONFIRMED -> EXPIRED)
      const unstartedCutoff = new Date(now.getTime() - 4 * 60 * 60 * 1000);
      
      const unstartedBookings = await this.prisma.bookings.findMany({
        where: {
          status: 'CONFIRMED',
          start_time: {
            lt: unstartedCutoff,
          },
        },
      });

      for (const booking of unstartedBookings) {
        await this.bookingsService.handleNoShow(booking.id, "Automatically expired due to no start");
      }

      if (unstartedBookings.length > 0) {
        this.logger.log(`Expired ${unstartedBookings.length} unstarted confirmed bookings.`);
      }

      // 2. Handle Stuck In-Progress (IN_PROGRESS -> COMPLETED)
      const inProgressCutoff = new Date(now.getTime() - 8 * 60 * 60 * 1000);

      const stuckResult = await this.prisma.bookings.updateMany({
        where: {
          status: 'IN_PROGRESS',
          end_time: {
            lt: inProgressCutoff,
          },
        },
        data: {
          status: 'COMPLETED',
          actual_end_time: now, 
        },
      });

      if (stuckResult.count > 0) {
        this.logger.log(`Auto-completed ${stuckResult.count} stuck in-progress bookings.`);
      }

    } catch (error) {
      this.logger.error('Error during stale bookings expiration check', error.stack);
    }
  }

  /**
   * Manual trigger for marking a Parent No-Show.
   */
  async markParentNoShow(bookingId: string) {
    return this.bookingsService.handleNoShow(bookingId, "Manual Parent No-Show");
  }
}
