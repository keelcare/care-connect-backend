import { PassportStrategy } from "@nestjs/passport";
import { Strategy, VerifyCallback } from "passport-google-oauth20";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, "google") {
  constructor(configService: ConfigService) {
    super({
      clientID: configService.get<string>("GOOGLE_CLIENT_ID") || "client_id",
      clientSecret:
        configService.get<string>("GOOGLE_CLIENT_SECRET") || "client_secret",
      callbackURL:
        configService.get<string>("GOOGLE_CALLBACK_URL") ||
        "http://localhost:4000/auth/google/callback",
      scope: ["email", "profile"],
      passReqToCallback: true,
    });
  }

  async validate(
    req: any,
    accessToken: string,
    refreshToken: string,
    profile: any,
    done: VerifyCallback,
  ): Promise<any> {
    const { id, name, emails, photos } = profile;

    // Extract role from state if present
    let role = "parent"; // Default role
    if (req.query.state) {
      try {
        const state = JSON.parse(req.query.state);
        if (state.role && ["parent", "nanny"].includes(state.role)) {
          role = state.role;
        }
      } catch (e) {
        // Ignore parsing errors
      }
    }

    const user = {
      oauth_provider_id: id,
      email: emails[0].value,
      firstName: name.givenName,
      lastName: name.familyName,
      picture: photos[0].value,
      oauth_access_token: accessToken,
      oauth_refresh_token: refreshToken,
      role: role, // Pass the role to the user object
    };
    done(null, user);
  }
}
