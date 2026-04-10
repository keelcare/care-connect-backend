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
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { AuthService } from "./auth.service";
import { AuthGuard } from "@nestjs/passport";
import { Response } from "express";
import { GoogleOauthGuard } from "./guards/google-oauth.guard";
import { ConfigService } from "@nestjs/config";
import { StrictThrottle } from "../common/decorators/throttle.decorator";
import { SignupDto } from "./dto/signup.dto";
import { LoginDto } from "./dto/login.dto";
import { ForgotPasswordDto } from "./dto/forgot-password.dto";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { SessionDto } from "./dto/session.dto";

@ApiTags("Authentication")
@Controller("auth")
export class AuthController {
  constructor(
    private authService: AuthService,
    private configService: ConfigService,
  ) {}

  /**
   * SECURITY: Strict rate limiting (10 req/min) to prevent automated account creation
   */
  @Post("signup")
  @StrictThrottle()
  @ApiOperation({ summary: "Register a new user" })
  @ApiResponse({ status: 201, description: "User successfully registered" })
  @ApiResponse({ status: 400, description: "Invalid input" })
  async signup(@Body() userDto: SignupDto, @Req() req) {
    const user = await this.authService.register(userDto);
    const origin = req.headers.origin || req.headers.referer;
    try {
      await this.authService.sendVerificationEmail(user.id, origin);
    } catch (e) {
      console.error("[Auth] Failed to send initial verification email:", e);
    }
    return user;
  }

  private getCookieOptions(res: Response) {
    const isProd = this.configService.get("NODE_ENV") === "production";
    const renderEnv = this.configService.get("RENDER");

    // In production (Render/Netlify), we must use secure/none for cross-site cookies
    if (isProd || renderEnv) {
      return {
        httpOnly: true,
        secure: true,
        sameSite: "none" as const,
        path: "/",
        // Partitioned cookies for cross-site support in Chrome 114+
        partitioned: true,
      };
    }

    // In local development, we use more relaxed settings to support mobile testing via IP
    return {
      httpOnly: true,
      secure: false, // Allow non-HTTPS for mobile testing
      sameSite: "lax" as const,
      path: "/",
    };
  }

  /**
   * SECURITY: Strict rate limiting (10 req/min) to prevent brute force attacks
   */
  @Post("login")
  @StrictThrottle()
  @ApiOperation({ summary: "User login" })
  @ApiResponse({
    status: 200,
    description:
      "Successfully logged in, tokens set in cookies and returned in body",
  })
  @ApiResponse({ status: 401, description: "Invalid credentials" })
  async login(
    @Body() loginDto: LoginDto,
    @Req() req,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.authService.validateUser(
      loginDto.email,
      loginDto.password,
    );
    if (!user) {
      throw new UnauthorizedException("Invalid credentials");
    }
    const loginData = await this.authService.login(user);

    const cookieOptions = this.getCookieOptions(res);

    res.cookie("access_token", loginData.access_token, {
      ...cookieOptions,
      maxAge: 15 * 60 * 1000, // 15m
    });

    res.cookie("refresh_token", loginData.refresh_token, {
      ...cookieOptions,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7d
    });

    return {
      user: loginData.user,
      access_token: loginData.access_token,
      refresh_token: loginData.refresh_token,
    };
  }

  @Post("logout")
  @ApiOperation({ summary: "Logout and clear session cookies" })
  @ApiResponse({ status: 200, description: "Successfully logged out" })
  async logout(@Res({ passthrough: true }) res: Response) {
    const optionsSecure = this.getCookieOptions(res);

    ["access_token", "refresh_token"].forEach((cookie) => {
      res.clearCookie(cookie, optionsSecure);
    });

    return { success: true };
  }

  @Post("refresh")
  @ApiOperation({
    summary: "Refresh access tokens using refresh cookie or body",
  })
  @ApiResponse({ status: 200, description: "Tokens refreshed successfully" })
  @ApiResponse({
    status: 401,
    description: "No refresh token provided or token invalid",
  })
  async refresh(
    @Req() req,
    @Body() body: { refresh_token?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    // Check cookie first, then body (for mobile apps)
    const refreshToken = req.cookies["refresh_token"] || body.refresh_token;
    if (!refreshToken) {
      throw new UnauthorizedException("No refresh token found");
    }

    const loginData = await this.authService.refresh(refreshToken);

    const cookieOptions = this.getCookieOptions(res);

    res.cookie("access_token", loginData.access_token, {
      ...cookieOptions,
      maxAge: 15 * 60 * 1000, // 15m
    });

    res.cookie("refresh_token", loginData.refresh_token, {
      ...cookieOptions,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7d
    });

    return {
      access_token: loginData.access_token,
      refresh_token: loginData.refresh_token,
      message: "Token refreshed successfully",
    };
  }

  /**
   * SECURITY: Strict rate limiting (10 req/min) to prevent email bombing
   */
  @Post("forgot-password")
  @StrictThrottle()
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req) {
    const origin = req.headers.origin || req.headers.referer;
    return this.authService.forgotPassword(dto.email, origin);
  }

  /**
   * SECURITY: Strict rate limiting (10 req/min) to prevent brute force token attacks
   */
  @Post("reset-password")
  @StrictThrottle()
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.password);
  }

  @Get("verify")
  async verifyEmail(@Req() req) {
    const token = req.query.token;
    return this.authService.verifyEmail(token);
  }

  /**
   * SECURITY: Strict rate limiting (10 req/min) to prevent email bombing
   */
  @Post("resend-verification")
  @StrictThrottle()
  async resendVerification(@Body() dto: ForgotPasswordDto, @Req() req) {
    const origin = req.headers.origin || req.headers.referer;
    return this.authService.sendVerificationEmailByEmail(dto.email, origin);
  }

  @Get("google")
  @UseGuards(GoogleOauthGuard)
  async googleAuth(@Req() req) {}

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
      const sessionToken = await this.authService.generateSessionToken(
        result.user,
      );
      console.log("[Auth] Session Token Generated");

      // Parse origin from state
      let redirectUrl = `${this.configService.get("FRONTEND_URL") || "http://localhost:3000"}/auth/callback`;

      if (req.query.state) {
        try {
          const state = JSON.parse(req.query.state as string);
          if (state.origin) {
            // Frontend explicitly passed full destination URI (e.g. careconnect://auth/callback or http://localhost:3000/auth/callback)
            if (
              state.origin.startsWith("careconnect://") ||
              state.origin.startsWith("keel://")
            ) {
              redirectUrl = state.origin;
            } else if (
              state.origin.includes("localhost") ||
              state.origin.includes("192.168.") ||
              state.origin.includes("10.0.") ||
              state.origin.includes("172.") ||
              state.origin.includes("care-connect-dev.vercel.app") ||
              state.origin.includes("keel-care.vercel.app") ||
              state.origin.includes("127.0.0.1")
            ) {
              let urlToUse = state.origin;
              if (urlToUse.endsWith("/")) {
                urlToUse = urlToUse.slice(0, -1);
              }

              if (urlToUse.includes("/auth/callback")) {
                redirectUrl = urlToUse;
              } else {
                redirectUrl = `${urlToUse}/auth/callback`;
              }
            }
          } else if (state.platform === "mobile") {
            redirectUrl = "keel://auth/callback";
          }
        } catch (e) {
          console.error("[Auth] Failed to parse state origin:", e);
        }
      }

      const isProd = this.configService.get("NODE_ENV") === "production";
      const renderEnv = this.configService.get("RENDER");

      if (
        (isProd || renderEnv) &&
        redirectUrl.includes("localhost") &&
        !req.query.state
      ) {
        // Fallback to production frontend if redirect is accidentally localhost
        redirectUrl = `${this.configService.get("FRONTEND_URL")}/auth/callback`;
        console.log("[Auth] Fallback redirect to production FRONTEND_URL");
      }

      console.log(`[Auth] Redirecting to: ${redirectUrl}`);
      return res.redirect(`${redirectUrl}?token=${sessionToken}`);
    } catch (error) {
      console.error("[Auth] Google Callback Error:", error);

      let frontendUrl =
        this.configService.get("FRONTEND_URL") || "http://localhost:3000";
      if (req.query.state) {
        try {
          const state = JSON.parse(req.query.state as string);
          if (state.origin) frontendUrl = state.origin;
        } catch (e) {}
      }

      res.redirect(`${frontendUrl}/auth/callback?error=auth_failed`);
    }
  }

  /**
   * SECURITY: Strict rate limiting (10 req/min) for OAuth session exchange
   */
  @Post("session")
  @StrictThrottle()
  async exchangeSession(
    @Req() req,
    @Body() dto: SessionDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const loginData = await this.authService.exchangeSessionToken(dto.token);

    const cookieOptions = this.getCookieOptions(res);

    res.cookie("access_token", loginData.access_token, {
      ...cookieOptions,
      maxAge: 15 * 60 * 1000,
    });

    res.cookie("refresh_token", loginData.refresh_token, {
      ...cookieOptions,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return {
      user: loginData.user,
      access_token: loginData.access_token,
      refresh_token: loginData.refresh_token,
    };
  }
}
