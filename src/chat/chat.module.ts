import { Module } from "@nestjs/common";
import { ChatService } from "./chat.service";
import { ChatController } from "./chat.controller";
import { ChatGateway } from "./chat.gateway";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TokenBlacklistService } from "../auth/token-blacklist.service";

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>("JWT_SECRET") || "secretKey",
        signOptions: { expiresIn: "60m" },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [ChatController],
  // TokenBlacklistService only depends on the (global) PrismaService, so it is
  // provided directly here rather than importing AuthModule — which would create
  // a cycle via UsersModule → NotificationsModule.
  providers: [ChatService, ChatGateway, TokenBlacklistService],
  exports: [ChatService],
})
export class ChatModule {}
