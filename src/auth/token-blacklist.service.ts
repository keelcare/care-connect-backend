import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class TokenBlacklistService {
  private readonly logger = new Logger(TokenBlacklistService.name);

  constructor(private prisma: PrismaService) {}

  async revokeToken(token: string, expiresInSeconds: number): Promise<void> {
    try {
      const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
      await this.prisma.revoked_tokens.create({
        data: {
          token,
          expires_at: expiresAt,
        },
      });
    } catch (error) {
      // Ignore duplicate key errors (token already revoked)
      this.logger.warn(
        `Failed to revoke token (likely duplicate): ${token.substring(0, 10)}...`,
      );
    }
  }

  async isRevoked(token: string): Promise<boolean> {
    const revoked = await this.prisma.revoked_tokens.findUnique({
      where: { token },
    });

    // Check if blacklisted AND not yet expired
    // We could clean up expired tokens via cron later
    if (revoked) {
      if (revoked.expires_at > new Date()) {
        return true;
      } else {
        // Technically could delete it here, but read-only is faster
        return false;
      }
    }

    return false;
  }
}
