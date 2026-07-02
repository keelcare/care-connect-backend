import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { UsersModule } from "../users/users.module";
import { PassportModule } from "@nestjs/passport";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { GoogleStrategy } from "./strategies/google.strategy";
import { TransparentJwtAuthGuard } from "./guards/transparent-jwt-auth.guard";

import { TokenBlacklistService } from "./token-blacklist.service";
import { MailModule } from "../mail/mail.module";

@Module({
  imports: [
    UsersModule,
    PassportModule,
    ConfigModule,
    MailModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        const secret = configService.get<string>("JWT_SECRET");
        if (!secret) throw new Error("JWT_SECRET must be configured");
        return {
          secret,
          signOptions: { expiresIn: "1h" }, // Extended to 1h
        };
      },
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    GoogleStrategy,
    TokenBlacklistService,
    TransparentJwtAuthGuard,
  ],
  exports: [AuthService, TransparentJwtAuthGuard, JwtModule],
})
export class AuthModule {}
