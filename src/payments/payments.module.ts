import { Module } from "@nestjs/common";
import { PaymentsService } from "./payments.service";
import { PaymentsController } from "./payments.controller";
import { PrismaService } from "../prisma/prisma.service";
import { ConfigModule } from "@nestjs/config";

@Module({
  imports: [ConfigModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, PrismaService],
})
export class PaymentsModule {}
