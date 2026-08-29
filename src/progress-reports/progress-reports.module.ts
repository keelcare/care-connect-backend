import { Module } from "@nestjs/common";
import { ProgressReportsService } from "./progress-reports.service";
import { ProgressReportsController } from "./progress-reports.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [PrismaModule, AuthModule, NotificationsModule],
  controllers: [ProgressReportsController],
  providers: [ProgressReportsService],
  exports: [ProgressReportsService],
})
export class ProgressReportsModule { }
