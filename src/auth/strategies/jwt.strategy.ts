import { ExtractJwt, Strategy } from "passport-jwt";
import { PassportStrategy } from "@nestjs/passport";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UsersService } from "../../users/users.service";
import { TokenBlacklistService } from "../token-blacklist.service";

/**
 * Extract the access token from a request.
 * Order: access_token cookie → Bearer header → ?token= query (SSE only).
 *
 * The query-param fallback exists solely for EventSource/SSE connections,
 * which cannot set custom headers. Query strings leak into access logs and
 * Referer headers, so we restrict it to the SSE route.
 */
function extractToken(req: any): string | null {
  if (req?.cookies?.access_token) return req.cookies.access_token;

  const authHeader = req?.headers?.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);

  const url: string = req?.originalUrl || req?.url || "";
  if (req?.query?.token && url.includes("/sse")) {
    return req.query.token as string;
  }

  return null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private usersService: UsersService,
    private tokenBlacklist: TokenBlacklistService,
  ) {
    const secret = configService.get<string>("JWT_SECRET");
    if (!secret) {
      // Fail fast rather than silently signing/verifying with a guessable key.
      throw new Error("JWT_SECRET must be configured");
    }
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([extractToken]),
      // Expired access tokens must be rejected so clients are forced to refresh.
      // The transparent refresh guard catches this rejection and refreshes.
      ignoreExpiration: false,
      secretOrKey: secret,
      passReqToCallback: true,
    });
  }

  async validate(req: any, payload: any) {
    // Reject tokens that were explicitly revoked (logout / ban).
    const token = extractToken(req);
    if (token && (await this.tokenBlacklist.isRevoked(token))) {
      throw new UnauthorizedException("Token has been revoked");
    }

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
