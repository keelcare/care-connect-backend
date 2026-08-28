import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { UsersService } from "../users/users.service";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import * as crypto from "node:crypto";
import { SignupDto } from "./dto/signup.dto";
import { PrismaService } from "../prisma/prisma.service";
import { MailService } from "../mail/mail.service";
import { OAUTH_ERROR_UNVERIFIED_ACCOUNT, CONSENT_POLICY_VERSION } from "../constants";
import { ConsentsService } from "../users/consents.service";
import { ConsentPurpose } from "../users/dto/consent.dto";

/**
 * SECURITY: Password Complexity Regex
 * - Min 8 characters
 * - At least one uppercase
 * - At least one lowercase
 * - At least one number
 * - At least one special character
 */
const PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private prisma: PrismaService,
    private mailService: MailService,
    private consentsService: ConsentsService,
  ) {
    if (!this.configService.get<string>("JWT_SECRET")) {
      throw new Error("JWT_SECRET must be configured");
    }
    if (!this.configService.get<string>("JWT_REFRESH_SECRET")) {
      throw new Error("JWT_REFRESH_SECRET must be configured");
    }
  }

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
    // Accounts in the 30-day deletion window are locked. Recovery is
    // support-only (see UsersService.deleteMe), so refuse to issue a session
    // rather than hand back a token every guarded endpoint would then reject.
    if (user.deleted_at) {
      throw new UnauthorizedException(
        "This account is scheduled for deletion. Contact support to restore it.",
      );
    }

    const payload = {
      email: user.email,
      sub: user.id,
      role: user.role,
      is_active: user.is_active,
    };

    const secret = this.configService.get<string>("JWT_SECRET");
    const refreshSecret = this.configService.get<string>("JWT_REFRESH_SECRET");
    if (!secret || !refreshSecret) {
      throw new Error("JWT_SECRET and JWT_REFRESH_SECRET must be configured");
    }

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: "15m",
      secret: secret,
    });

    const refreshToken = this.jwtService.sign(payload, {
      expiresIn: "7d",
      secret: refreshSecret,
    });

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
        // Needed on first render after sign-in: the partner app's verification
        // banner keys off this, and without it the status reads as unknown
        // until something else fetches /users/me.
        identity_verification_status: user.identity_verification_status,
        profiles:
          user.profiles &&
          (Array.isArray(user.profiles) ? user.profiles[0] : user.profiles),
      },
    };
  }

  /**
   * Drop the stored refresh-token hash, invalidating every outstanding refresh
   * token for this account. Used by logout; password reset does the same inline.
   */
  async clearRefreshToken(userId: string) {
    await this.usersService.update(userId, { refresh_token_hash: null });
  }

  async refresh(refreshToken: string) {
    try {
      const refreshSecret = this.configService.get<string>("JWT_REFRESH_SECRET");
      if (!refreshSecret) {
        throw new Error("JWT_REFRESH_SECRET is not configured");
      }
      const payload = this.jwtService.verify(refreshToken, { secret: refreshSecret });
      
      // Check if token was revoked
      const revokedToken = await this.prisma.revoked_tokens.findUnique({
        where: { token: refreshToken },
      });
      if (revokedToken) {
        throw new UnauthorizedException("Refresh token has been revoked");
      }

      // Directly using findUnique to be 100% sure we get the hash
      const user = await this.prisma.users.findUnique({
        where: { email: payload.email },
      });

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

      // Rotate token: revoke the old one
      const expiresAt = new Date((payload.exp || 0) * 1000);
      await this.prisma.revoked_tokens.create({
        data: { token: refreshToken, expires_at: expiresAt },
      }).catch(err => {
        Logger.warn(`Failed to revoke refresh token: ${err.message}`, AuthService.name);
      });

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

    // Send email with reset link
    const frontendUrl =
      origin ||
      this.configService.get("FRONTEND_URL") ||
      "http://localhost:3000";
    await this.mailService.sendPasswordResetEmail(
      user.email,
      resetToken,
      frontendUrl,
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
      // Kill every existing session. People reset passwords precisely *because*
      // they think someone else is in the account; leaving `refresh_token_hash`
      // intact meant an attacker holding a refresh token kept full API access for
      // the remaining 7 days, and the reset only locked them out of a login they
      // were not using anyway.
      refresh_token_hash: null,
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

    // Send email with verification link
    const frontendUrl =
      origin ||
      this.configService.get("FRONTEND_URL") ||
      "http://localhost:3000";
    await this.mailService.sendVerificationEmail(
      user.email,
      verificationToken,
      frontendUrl,
    );

    return { message: "Verification email sent" };
  }

  async sendVerificationEmailByEmail(email: string, origin?: string) {
    const user = await this.usersService.findUserForAuth(email);
    if (!user || user.is_verified) {
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

  async register(userDto: SignupDto, ipAddress?: string) {

    // Categories are collected during nanny onboarding, not at signup, so they
    // are optional here — the onboarding form is what finally writes them onto
    // nanny_details. Older clients that still send them are still honoured, and
    // still validated.
    if (userDto.role === "nanny" && userDto.categories?.length) {
      // Validate categories exist in services table
      const validServices = await this.prisma.services.findMany({
        where: {
          name: { in: userDto.categories },
        },
      });

      if (validServices.length !== userDto.categories.length) {
        const validNames = validServices.map((s) => s.name);
        const invalidNames = userDto.categories.filter(
          (c) => !validNames.includes(c),
        );
        throw new BadRequestException(
          `Invalid categories: ${invalidNames.join(", ")}`,
        );
      }
    }

    // Reject a duplicate before attempting the insert. Case-insensitive, so
    // "User@example.com" cannot create a second account alongside
    // "user@example.com" (the unique index alone is case-sensitive and would
    // happily allow it).
    const existing = await this.usersService.findOneByEmail(userDto.email);
    if (existing) {
      throw new ConflictException("An account with this email already exists");
    }

    const hashedPassword = await bcrypt.hash(userDto.password, 10);
    let user: Awaited<ReturnType<typeof this.usersService.create>>;

    // SECURITY: never honour a privileged role from a public request body. The
    // DTO already restricts this to parent/nanny; this is the second gate, so a
    // future caller that skips the pipe (internal call, changed DTO) still
    // cannot self-provision an admin.
    const requestedRole = userDto.role || "parent";
    const safeRole = requestedRole === "nanny" ? "nanny" : "parent";

    try {
      user = await this.usersService.create({
        email: userDto.email,
        password_hash: hashedPassword,
        role: safeRole,
        profiles: {
          create: {
            first_name: userDto.firstName,
            last_name: userDto.lastName,
          },
        },
        nanny_details:
          userDto.role === "nanny"
            ? {
                create: {
                  categories: userDto.categories ?? [],
                },
              }
            : undefined,
      });
    } catch (err) {
      // Two concurrent signups can both pass the check above; the unique index is
      // what actually decides. Prisma's P2002 was uncaught anywhere in auth/users,
      // so the loser of that race got an opaque 500 instead of "already registered".
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        throw new ConflictException("An account with this email already exists");
      }
      throw err;
    }

    // Record the Terms and Privacy Notice acceptance that the signup screen
    // presented. DPDPA s.5-6 require consent to be recorded against the version
    // of the notice actually shown; the /consents endpoint existed for this but
    // no client ever called it, so the platform held no evidence of consent for
    // any account. Recorded here rather than client-side so it cannot be skipped.
    for (const purpose of [
      ConsentPurpose.TERMS_OF_SERVICE,
      ConsentPurpose.PRIVACY_POLICY,
    ]) {
      await this.consentsService.storeConsentSafe(
        user.id,
        purpose,
        CONSENT_POLICY_VERSION,
        { ipAddress, metadata: { captured_at: "auth.register" } },
      );
    }

    // Send verification email
    try {
      await this.sendVerificationEmail(user.id);
    } catch (error) {
      // Log error but don't fail registration
      console.error("Failed to send welcome verification email", error);
    }

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
        // Account pre-hijacking guard.
        //
        // Anyone can sign up with an email they do not control and set their own
        // password — signup does not require proving ownership of the mailbox. If we
        // then auto-linked a Google identity onto that account by email match, the
        // squatter's password would keep working on an account the real owner has
        // just adopted as their own, handing them a permanent second key to the
        // victim's children, addresses, bookings and payment history.
        //
        // Linking is only safe when the existing account is already proven to belong
        // to whoever holds the mailbox (`is_verified`), or when it has no password to
        // hijack it with.
        const canLink = user.is_verified || !user.password_hash;
        if (!canLink) {
          // The `code` travels to the client: the OAuth callback is a *redirect*,
          // so the only channel back to the app is the error query param. Without a
          // distinguishable code every failure arrives as "auth_failed" and the user
          // is told to try again, when what they actually need to do is click the
          // verification email or use their password.
          throw new UnauthorizedException({
            code: OAUTH_ERROR_UNVERIFIED_ACCOUNT,
            message:
              "An unverified account already exists for this email. Verify it from " +
              "the link we emailed you, or sign in with your password, before " +
              "connecting Google.",
          });
        }

        // Link account. This goes through update()'s Prisma-input branch, which
        // returns the full user row; assert the declared type since update()'s
        // union return now also includes the sanitised findOne() shape.
        user = (await this.usersService.update(user.id, {
          oauth_provider: "google",
          oauth_provider_id: googleUser.oauth_provider_id,
          oauth_access_token: googleUser.oauth_access_token,
          oauth_refresh_token: googleUser.oauth_refresh_token,
          is_verified: true,
        })) as typeof user;
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

      // Blacklist the session token immediately after use to prevent reuse
      const expiresAt = new Date(payload.exp * 1000);
      await this.prisma.revoked_tokens
        .create({
          data: { token, expires_at: expiresAt },
        })
        .catch((err) => {
          Logger.warn(`Session token already revoked or DB error: ${err.message}`, AuthService.name);
        });

      return this.login(user);
    } catch (error) {
      throw new UnauthorizedException("Invalid or expired session token");
    }
  }
}
