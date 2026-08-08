import { Module } from "@nestjs/common";
import { NanniesService } from "./nannies.service";
import { NanniesController } from "./nannies.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { AttendanceModule } from "../attendance/attendance.module";

@Module({
  imports: [PrismaModule, AttendanceModule],
  controllers: [NanniesController],
  providers: [NanniesService],
  exports: [NanniesService],
})
export class NanniesModule {}
