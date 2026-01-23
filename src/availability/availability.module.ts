import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { JwtModule } from "@nestjs/jwt";
import { AvailabilityService } from "./availability.service";
import { AvailabilityController } from "./availability.controller";
import { PrismaModule } from "../prisma/prisma.module";

@Module({
    imports: [
        PrismaModule,
        PassportModule,
        JwtModule.register({}),
    ],
    controllers: [AvailabilityController],
    providers: [AvailabilityService],
    exports: [AvailabilityService],
})
export class AvailabilityModule {}
