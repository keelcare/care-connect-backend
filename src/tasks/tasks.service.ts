import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { BookingsService } from "../bookings/bookings.service";

@Injectable()
export class TasksService {
    private readonly logger = new Logger(TasksService.name);

    constructor(private readonly bookingsService: BookingsService) { }

    @Cron(CronExpression.EVERY_30_MINUTES)
    async handleExpiredBookings() {
        this.logger.debug("Running Cron Job: Checking for expired bookings...");
        try {
            const count = await this.bookingsService.checkExpiredBookings();
            if (count > 0) {
                this.logger.log(`Cancelled ${count} expired bookings.`);
            }
        } catch (error) {
            this.logger.error("Error in handleExpiredBookings cron job", error);
        }
    }
}
