import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { JwtModule } from "@nestjs/jwt";
import { UsersService } from "./users.service";
import { UsersController } from "./users.controller";
import { ConsentsService } from "./consents.service";
import { ConsentsController } from "./consents.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { SupabaseStorageModule } from "../supabase-storage/supabase-storage.module";
import { AddressesModule } from "../addresses/addresses.module";

@Module({
  imports: [PrismaModule, PassportModule, JwtModule.register({}), NotificationsModule, SupabaseStorageModule, AddressesModule],
  providers: [UsersService, ConsentsService],
  controllers: [UsersController, ConsentsController],
  exports: [UsersService, ConsentsService],
})
export class UsersModule {}
