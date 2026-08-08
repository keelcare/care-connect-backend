import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AttendanceService } from "./attendance.service";
import { AttendanceRollupService } from "./attendance-rollup.service";
import { AttendanceListeners } from "./attendance.listeners";
import { AttendanceController } from "./attendance.controller";

/**
 * Caregiver attendance.
 *
 * Depends on nothing but Prisma and notifications, and reaches the booking
 * lifecycle through the event emitter rather than by importing `BookingsModule`.
 * That keeps the dependency pointing one way — attendance observes bookings,
 * bookings never wait on attendance — and is why recording can safely be
 * best-effort.
 */
@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [AttendanceController],
  providers: [AttendanceService, AttendanceRollupService, AttendanceListeners],
  exports: [AttendanceService],
})
export class AttendanceModule {}
