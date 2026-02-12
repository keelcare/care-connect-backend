import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { UsersService } from "../users/users.service";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
  ) { }

  async validateUser(email: string, pass: string): Promise<any> {
    const user = await this.usersService.findUserForAuth(email);
    if (
      user &&
      user.password_hash &&
      (await bcrypt.compare(pass, user.password_hash))
    ) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { password_hash, ...result } = user;
      return result;
    }
    return null;
  }

  async login(user: any) {
    const payload = {
      email: user.email,
      sub: user.id,
      role: user.role,
      is_active: user.is_active,
    };
    const accessToken = this.jwtService.sign(payload, { expiresIn: "15m" });
    const refreshToken = this.jwtService.sign(payload, { expiresIn: "7d" });

    // Hash and store refresh token
    const refreshTokenHash = await bcrypt.hash(refreshToken, 10);
    await this.usersService.update(user.id, {
      refresh_token_hash: refreshTokenHash,
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        is_verified: user.is_verified,
        is_active: user.is_active,
        ban_reason: user.ban_reason,
        oauth_provider: user.oauth_provider,
        profiles:
          user.profiles &&
          (Array.isArray(user.profiles) ? user.profiles[0] : user.profiles),
      },
    };
  }

  async refresh(refreshToken: string) {
    try {
      const payload = this.jwtService.verify(refreshToken);
      const user = await this.usersService.findOne(payload.sub);

      if (!user || !user.refresh_token_hash) {
        throw new UnauthorizedException("Invalid refresh token");
      }

      const isValid = await bcrypt.compare(
        refreshToken,
        user.refresh_token_hash,
      );
      if (!isValid) {
        throw new UnauthorizedException("Invalid refresh token");
      }

      // Generate new tokens
      return this.login(user);
    } catch (error) {
      throw new UnauthorizedException("Invalid refresh token");
    }
  }

  async forgotPassword(email: string, origin?: string) {
    const user = await this.usersService.findUserForAuth(email);
    if (!user) {
      // Don't reveal if user exists
      return { message: "If the email exists, a reset link has been sent" };
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenExpires = new Date(Date.now() + 3600000); // 1 hour

    await this.usersService.update(user.id, {
      reset_password_token: resetToken,
      reset_password_token_expires: resetTokenExpires,
    });

    // TODO: Send email with reset link
    const frontendUrl = origin || process.env.FRONTEND_URL || "http://localhost:3000";
    console.log(
      `Password reset link: ${frontendUrl}/reset-password?token=${resetToken}`,
    );

    return { message: "If the email exists, a reset link has been sent" };
  }

  async resetPassword(token: string, newPassword: string) {
    const user = await this.usersService.findByResetToken(token);

    if (
      !user ||
      !user.reset_password_token_expires ||
      user.reset_password_token_expires < new Date()
    ) {
      throw new BadRequestException("Invalid or expired reset token");
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await this.usersService.update(user.id, {
      password_hash: hashedPassword,
      reset_password_token: null,
      reset_password_token_expires: null,
    });

    return { message: "Password reset successful" };
  }

  async sendVerificationEmail(userId: string, origin?: string) {
    const user = await this.usersService.findOne(userId);
    if (!user) {
      throw new BadRequestException("User not found");
    }

    if (user.is_verified) {
      return { message: "Email already verified" };
    }

    const verificationToken = crypto.randomBytes(32).toString("hex");
    const verificationTokenExpires = new Date(Date.now() + 86400000); // 24 hours

    await this.usersService.update(user.id, {
      verification_token: verificationToken,
      verification_token_expires: verificationTokenExpires,
    });

    // TODO: Send email with verification link
    const frontendUrl = origin || process.env.FRONTEND_URL || "http://localhost:3000";
    console.log(
      `Verification link: ${frontendUrl}/verify?token=${verificationToken}`,
    );

    return { message: "Verification email sent" };
  }

  async sendVerificationEmailByEmail(email: string, origin?: string) {
    const user = await this.usersService.findUserForAuth(email);
    if (!user) {
      // Don't reveal user existence
      return { message: "Verification email sent if account exists" };
    }
    return this.sendVerificationEmail(user.id, origin);
  }

  async verifyEmail(token: string) {
    const user = await this.usersService.findByVerificationToken(token);

    if (
      !user ||
      !user.verification_token_expires ||
      user.verification_token_expires < new Date()
    ) {
      throw new BadRequestException("Invalid or expired verification token");
    }

    await this.usersService.update(user.id, {
      is_verified: true,
      verification_token: null,
      verification_token_expires: null,
    });

    return { message: "Email verified successfully" };
  }

  async register(userDto: any) {
    const hashedPassword = await bcrypt.hash(userDto.password, 10);
    const user = await this.usersService.create({
      email: userDto.email,
      password_hash: hashedPassword,
      role: userDto.role || "parent", // Use provided role or default to parent
      profiles: {
        create: {
          first_name: userDto.firstName,
          last_name: userDto.lastName,
        },
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password_hash, ...result } = user;
    return result;
  }

  async googleLogin(googleUser: any) {
    let user = await this.usersService.findByOAuth(
      "google",
      googleUser.oauth_provider_id,
    );

    if (!user) {
      // Check if user exists by email
      user = await this.usersService.findUserForAuth(googleUser.email);

      if (user) {
        // Link account
        user = await this.usersService.update(user.id, {
          oauth_provider: "google",
          oauth_provider_id: googleUser.oauth_provider_id,
          oauth_access_token: googleUser.oauth_access_token,
          oauth_refresh_token: googleUser.oauth_refresh_token,
          is_verified: true,
        });
      } else {
        // Create new user with profile
        user = await this.usersService.create({
          email: googleUser.email,
          role: googleUser.role || "parent", // Use role from state or default
          is_verified: true,
          oauth_provider: "google",
          oauth_provider_id: googleUser.oauth_provider_id,
          oauth_access_token: googleUser.oauth_access_token,
          oauth_refresh_token: googleUser.oauth_refresh_token,
          profiles: {
            create: {
              first_name: googleUser.firstName,
              last_name: googleUser.lastName,
              profile_image_url: googleUser.picture,
            },
          },
        });
      }
    }

    return this.login(user);
  }

  async generateSessionToken(user: any) {
    const payload = { sub: user.id };
    // Short-lived token specifically for the exchange
    return this.jwtService.sign(payload, { expiresIn: "1m" });
  }

  async exchangeSessionToken(token: string) {
    try {
      const payload = this.jwtService.verify(token);
      const user = await this.usersService.findOne(payload.sub);

      if (!user) {
        throw new UnauthorizedException("Invalid session token");
      }

      return this.login(user);
    } catch (error) {
      throw new UnauthorizedException("Invalid or expired session token");
    }
  }
}
