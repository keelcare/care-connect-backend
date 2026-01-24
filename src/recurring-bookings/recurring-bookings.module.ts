import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { JwtModule } from "@nestjs/jwt";
import { RecurringBookingsService } from "./recurring-bookings.service";
import { RecurringBookingsController } from "./recurring-bookings.controller";
import { PrismaModule } from "../prisma/prisma.module";

@Module({
    imports: [
        PrismaModule,
        PassportModule,
        JwtModule.register({}),
    ],
    controllers: [RecurringBookingsController],
    providers: [RecurringBookingsService],
    exports: [RecurringBookingsService],
})
export class RecurringBookingsModule {}
