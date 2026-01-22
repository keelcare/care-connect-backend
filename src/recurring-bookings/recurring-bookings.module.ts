import { Module } from "@nestjs/common";
import { RecurringBookingsService } from "./recurring-bookings.service";
import { RecurringBookingsController } from "./recurring-bookings.controller";
import { PrismaModule } from "../prisma/prisma.module";

@Module({
  imports: [PrismaModule],
  controllers: [RecurringBookingsController],
  providers: [RecurringBookingsService],
  exports: [RecurringBookingsService],
})
export class RecurringBookingsModule {}
