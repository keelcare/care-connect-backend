import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class ConsentsService {
  private readonly logger = new Logger(ConsentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async storeConsent(
    userId: string,
    purpose: string,
    version: string,
    ipAddress?: string,
  ) {
    try {
      const consent = await this.prisma.user_consents.create({
        data: {
          user_id: userId,
          purpose,
          version,
          ip_address: ipAddress || null,
        },
      });
      return { success: true, consentId: consent.id };
    } catch (err) {
      this.logger.error(`Failed to store consent for user ${userId}: ${err.message}`, err.stack);
      throw err;
    }
  }

  async getUserConsents(userId: string) {
    return this.prisma.user_consents.findMany({
      where: { user_id: userId },
      orderBy: { consented_at: "desc" },
    });
  }
}
