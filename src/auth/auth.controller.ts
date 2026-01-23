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
  ) {}

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

    // Set HttpOnly Cookies
    const isProd = this.configService.get("NODE_ENV") === "production";
    const cookieOptions = {
      httpOnly: true,
      secure: isProd,
      sameSite: (isProd ? "strict" : "lax") as "strict" | "lax", // Lax needed for extensive dev testing usually, but Strict requested. Using conditional for safety during dev.
      path: "/",
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
    const cookieOptions = {
      httpOnly: true,
      secure: isProd,
      sameSite: (isProd ? "strict" : "lax") as "strict" | "lax",
      path: "/",
    };

    res.clearCookie("access_token", cookieOptions);
    res.clearCookie("refresh_token", cookieOptions);

    return { message: "Logged out successfully" };
  }

  @Post("refresh")
  async refresh(@Req() req, @Res({ passthrough: true }) res: Response) {
    const refreshToken = req.cookies["refresh_token"];
    if (!refreshToken) {
      throw new UnauthorizedException("No refresh token found");
    }

    const loginData = await this.authService.refresh(refreshToken);

    // Set HttpOnly Cookies
    const isProd = this.configService.get("NODE_ENV") === "production";
    const cookieOptions = {
      httpOnly: true,
      secure: isProd,
      sameSite: (isProd ? "strict" : "lax") as "strict" | "lax",
      path: "/",
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
  async googleAuth(@Req() req) {}

  @Get("google/callback")
  @UseGuards(AuthGuard("google"))
  async googleAuthRedirect(@Req() req, @Res() res: Response) {
    const result = await this.authService.googleLogin(req.user);

    const isProd = this.configService.get("NODE_ENV") === "production";
    const cookieOptions = {
      httpOnly: true,
      secure: isProd,
      sameSite: (isProd ? "strict" : "lax") as "strict" | "lax",
      path: "/",
    };

    res.cookie("access_token", result.access_token, {
      ...cookieOptions,
      maxAge: 15 * 60 * 1000,
    });

    res.cookie("refresh_token", result.refresh_token, {
      ...cookieOptions,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    // Redirect to frontend without token in URL
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    res.redirect(`${frontendUrl}/auth/callback`); // Logic on frontend: check cookies
  }
}
