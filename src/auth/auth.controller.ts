import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { AuthService } from "./auth.service";
import { AuthGuard } from "@nestjs/passport";
import { Response } from "express";

import { GoogleOauthGuard } from "./guards/google-oauth.guard";

import { ConfigService } from "@nestjs/config";

@Controller("auth")
export class AuthController {
  constructor(
    private authService: AuthService,
    private configService: ConfigService,
  ) { }

  @Post("signup")
  async signup(@Body() userDto: any) {
    return this.authService.register(userDto);
  }

  @Post("login")
  async login(@Body() req, @Res({ passthrough: true }) res: Response) {
    const user = await this.authService.validateUser(req.email, req.password);
    if (!user) {
      throw new UnauthorizedException("Invalid credentials");
    }
    const loginData = await this.authService.login(user);

    const isProd = this.configService.get("NODE_ENV") === "production";
    const renderEnv = this.configService.get("RENDER");
    let frontendUrl =
      this.configService.get("FRONTEND_URL") || "http://localhost:3000";
    
   
    if ((isProd || renderEnv) && frontendUrl.includes("localhost")) {
      frontendUrl = "http://localhost:3000";
    }

    const isSecure = isProd || renderEnv || frontendUrl.startsWith("https");

    // Set HttpOnly Cookies
    const cookieOptions = {
      httpOnly: true,
      secure: isSecure,
      sameSite: isSecure ? ("none" as const) : ("lax" as const),
      path: "/",
      // @ts-ignore - Partitioned is a new attribute not yet in all types
      partitioned: isSecure,
    };

    res.cookie("access_token", loginData.access_token, {
      ...cookieOptions,
      maxAge: 15 * 60 * 1000, // 15m
    });

    res.cookie("refresh_token", loginData.refresh_token, {
      ...cookieOptions,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7d
    });

    return { user: loginData.user };
  }

  @Post("logout")
  async logout(@Res({ passthrough: true }) res: Response) {
    const isProd = this.configService.get("NODE_ENV") === "production";
    const renderEnv = this.configService.get("RENDER");
    let frontendUrl =
      this.configService.get("FRONTEND_URL") || "http://localhost:3000";

    if ((isProd || renderEnv) && frontendUrl.includes("localhost")) {
      frontendUrl = "http://localhost:3000";
    }

    const isSecure = isProd || renderEnv || frontendUrl.startsWith("https");

    // Clear all possible variations of the cookie to ensure it is removed
    
    // Variation 1: Secure + SameSite=None + Partitioned
    const optionsSecurePartitioned = {
      httpOnly: true,
      secure: true,
      sameSite: "none" as const,
      path: "/",
      // @ts-ignore
      partitioned: true,
    };

    // Variation 2: Secure + SameSite=None (No Partitioned)
    const optionsSecure = {
      httpOnly: true,
      secure: true,
      sameSite: "none" as const,
      path: "/",
      partitioned: false,
    };

    // Variation 3: Lax + Not Secure (Localhost standard)
    const optionsLax = {
      httpOnly: true,
      secure: false,
      sameSite: "lax" as const,
      path: "/",
      partitioned: false,
    };

    ["access_token", "refresh_token"].forEach((cookie) => {
      res.clearCookie(cookie, optionsSecurePartitioned);
      res.clearCookie(cookie, optionsSecure);
      res.clearCookie(cookie, optionsLax);
    });

    return { success: true };
  }

  @Post("refresh")
  async refresh(@Req() req, @Res({ passthrough: true }) res: Response) {
    console.log("[Auth] Refresh called");
    console.log("[Auth] Cookies:", req.cookies);
    const refreshToken = req.cookies["refresh_token"];
    if (!refreshToken) {
      console.log("[Auth] No refresh token found in cookies");
      throw new UnauthorizedException("No refresh token found");
    }

    const loginData = await this.authService.refresh(refreshToken);

    // Set HttpOnly Cookies
    const isProd = this.configService.get("NODE_ENV") === "production";
    const renderEnv = this.configService.get("RENDER");
    let frontendUrl =
      this.configService.get("FRONTEND_URL") || "http://localhost:3000";

    if ((isProd || renderEnv) && frontendUrl.includes("localhost")) {
      frontendUrl = "http://localhost:3000";
    }

    const isSecure = isProd || renderEnv || frontendUrl.startsWith("https");

    const cookieOptions = {
      httpOnly: true,
      secure: isSecure,
      sameSite: isSecure ? ("none" as const) : ("lax" as const),
      path: "/",
      // @ts-ignore
      partitioned: isSecure,
    };

    res.cookie("access_token", loginData.access_token, {
      ...cookieOptions,
      maxAge: 15 * 60 * 1000, // 15m
    });

    res.cookie("refresh_token", loginData.refresh_token, {
      ...cookieOptions,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7d
    });

    return { message: "Token refreshed successfully" };
  }

  @Post("forgot-password")
  async forgotPassword(@Body("email") email: string) {
    return this.authService.forgotPassword(email);
  }

  @Post("reset-password")
  async resetPassword(
    @Body("token") token: string,
    @Body("password") password: string,
  ) {
    return this.authService.resetPassword(token, password);
  }

  @Get("verify")
  async verifyEmail(@Req() req) {
    const token = req.query.token;
    return this.authService.verifyEmail(token);
  }

  @Get("google")
  @UseGuards(GoogleOauthGuard)
  async googleAuth(@Req() req) { }

  @Get("google/callback")
  @UseGuards(AuthGuard("google"))
  async googleAuthRedirect(@Req() req, @Res() res: Response) {
    try {
      console.log("[Auth] Google Callback Received");
      console.log("[Auth] Request User:", JSON.stringify(req.user));

      if (!req.user) {
        console.error("[Auth] No user found in request");
        throw new UnauthorizedException("Google authentication failed");
      }

      const result = await this.authService.googleLogin(req.user);
      console.log("[Auth] Google Login Result:", JSON.stringify(result));

      // Generate a short-lived session token
      const sessionToken = await this.authService.generateSessionToken(result.user);
      console.log("[Auth] Session Token Generated");

      const isProd = this.configService.get("NODE_ENV") === "production";
      const renderEnv = this.configService.get("RENDER");
      let frontendUrl =
        this.configService.get("FRONTEND_URL") || "http://localhost:3000";

      if (req.query.state) {
        try {
          const state = JSON.parse(req.query.state as string);
          if (state.origin &&
            (state.origin.includes('localhost') ||
              state.origin.includes('keelcare.netlify.app') ||
              state.origin.includes('care-connect-dev.vercel.app') ||
              state.origin.includes('127.0.0.1'))) {
            frontendUrl = state.origin;
            // Remove trailing slash if present
            if (frontendUrl.endsWith('/')) {
              frontendUrl = frontendUrl.slice(0, -1);
            }
          }
        } catch (e) {
          console.error("[Auth] Failed to parse state origin:", e);
        }
      }

      if ((isProd || renderEnv) && frontendUrl.includes("localhost")) {
        frontendUrl = "http://localhost:3000";
      }

      let redirectUrl = frontendUrl.includes('/auth/callback') 
        ? frontendUrl 
        : `${frontendUrl}/auth/callback`;

      console.log("[Auth] Redirecting to:", redirectUrl);

      // Redirect to frontend with the session token
      res.redirect(`${redirectUrl}?token=${sessionToken}`);
    } catch (error) {
      console.error("[Auth] Google Callback Error:", error);
      // Redirect to frontend with error
      const isProd = this.configService.get("NODE_ENV") === "production";
      const renderEnv = this.configService.get("RENDER");
      let frontendUrl =
        this.configService.get("FRONTEND_URL") || "http://localhost:3000";
       if ((isProd || renderEnv) && frontendUrl.includes("localhost")) {
        frontendUrl = "http://localhost:3000";
      }
      res.redirect(`${frontendUrl}/auth/callback?error=auth_failed`);
    }
  }

  @Post("session")
  async exchangeSession(@Body("token") token: string, @Res({ passthrough: true }) res: Response) {
    if (!token) {
      throw new UnauthorizedException("No token provided");
    }

    const loginData = await this.authService.exchangeSessionToken(token);

    const isProd = this.configService.get("NODE_ENV") === "production";
    const renderEnv = this.configService.get("RENDER");
    let frontendUrl =
      this.configService.get("FRONTEND_URL") || "http://localhost:3000";

    if ((isProd || renderEnv) && frontendUrl.includes("localhost")) {
      frontendUrl = "http://localhost:3000";
    }

    const isSecure = isProd || renderEnv || frontendUrl.startsWith("https");

    // Set cookies with Partitioned attribute for cross-site support
    const cookieOptions = {
      httpOnly: true,
      secure: isSecure,
      sameSite: isSecure ? ("none" as const) : ("lax" as const),
      path: "/",
      // @ts-ignore
      partitioned: isSecure,
    };

    res.cookie("access_token", loginData.access_token, {
      ...cookieOptions,
      maxAge: 15 * 60 * 1000,
    });

    res.cookie("refresh_token", loginData.refresh_token, {
      ...cookieOptions,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return { user: loginData.user };
  }
}
