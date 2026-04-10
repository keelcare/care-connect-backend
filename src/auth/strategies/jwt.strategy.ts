import { ExtractJwt, Strategy } from "passport-jwt";
import { PassportStrategy } from "@nestjs/passport";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UsersService } from "../../users/users.service";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req) => {
          return (
            req?.cookies?.access_token || (req?.query?.token as string) || null
          );
        },
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: true,
      secretOrKey: configService.get<string>("JWT_SECRET") || "secretKey",
    });
  }

  async validate(payload: any) {
    // Verify the user still exists in the database
    const user = await this.usersService.findOne(payload.sub);
    if (!user) {
      throw new UnauthorizedException("User does not exist");
    }
    // Return is_active so endpoints/guards can decide how to handle banned users.
    // We intentionally do NOT block banned users here — GET /users/me must work
    // for them so the frontend can show the "contest ban" screen.
    return {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      is_active: user.is_active,
    };
  }
}
