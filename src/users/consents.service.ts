import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ConsentPurpose, ESSENTIAL_PURPOSES } from "./dto/consent.dto";

export interface ConsentContext {
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class ConsentsService {
  private readonly logger = new Logger(ConsentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async storeConsent(
    userId: string,
    purpose: string,
    version: string,
    ipAddress?: string,
    opts: { subjectType?: string; subjectId?: string; metadata?: Record<string, unknown> } = {},
  ) {
    try {
      const consent = await this.prisma.user_consents.create({
        data: {
          user_id: userId,
          purpose,
          version,
          ip_address: ipAddress || null,
          subject_type: opts.subjectType ?? null,
          subject_id: opts.subjectId ?? null,
          metadata: (opts.metadata as any) ?? undefined,
        },
      });
      return { success: true, consentId: consent.id };
    } catch (err) {
      this.logger.error(`Failed to store consent for user ${userId}: ${err.message}`, err.stack);
      throw err;
    }
  }

  /**
   * Records consent without letting a failure break the surrounding action.
   * Used where consent is captured as a side-effect of a user action (adding a
   * child): the action itself is the consent, so we must not fail the write the
   * parent actually asked for — but we do want the miss to be loud in logs.
   */
  async storeConsentSafe(
    userId: string,
    purpose: ConsentPurpose,
    version: string,
    opts: { subjectType?: string; subjectId?: string; ipAddress?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<void> {
    try {
      await this.storeConsent(userId, purpose, version, opts.ipAddress, opts);
    } catch (err) {
      this.logger.error(
        `Consent record MISSED: user=${userId} purpose=${purpose} subject=${opts.subjectId ?? "-"}: ${err.message}`,
      );
    }
  }

  async getUserConsents(userId: string) {
    return this.prisma.user_consents.findMany({
      where: { user_id: userId },
      orderBy: { consented_at: "desc" },
    });
  }

  /**
   * The user's *current* consent state: the latest non-withdrawn grant per
   * (purpose, subject). This is what a settings screen should render — the raw
   * history is an audit trail, not a state.
   */
  async getActiveConsents(userId: string) {
    const rows = await this.prisma.user_consents.findMany({
      where: { user_id: userId, withdrawn_at: null },
      orderBy: { consented_at: "desc" },
    });

    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = `${row.purpose}:${row.subject_id ?? ""}`;
      if (!latest.has(key)) latest.set(key, row);
    }
    return [...latest.values()];
  }

  /**
   * Withdraws consent for a purpose (DPDPA s.6(4)-(6)). Marks every outstanding
   * grant for that purpose withdrawn rather than deleting it, so the record of
   * what was consented to survives the withdrawal.
   *
   * Returns `essential: true` for purposes the service cannot operate without, so
   * the caller can route the user to account deletion instead of silently
   * leaving them in a state where we still process their data.
   */
  async withdrawConsent(userId: string, purpose: ConsentPurpose, subjectId?: string) {
    const isEssential = ESSENTIAL_PURPOSES.includes(purpose);

    const { count } = await this.prisma.user_consents.updateMany({
      where: {
        user_id: userId,
        purpose,
        withdrawn_at: null,
        ...(subjectId ? { subject_id: subjectId } : {}),
      },
      data: { withdrawn_at: new Date() },
    });

    this.logger.log(
      `Consent withdrawn: user=${userId} purpose=${purpose} rows=${count}`,
    );

    return {
      success: true,
      withdrawn: count,
      essential: isEssential,
      ...(isEssential
        ? {
            message:
              "This consent is required to provide the service. To stop all processing, delete your account from Profile → Delete account.",
          }
        : {}),
    };
  }

  /** Whether a live consent exists — used to gate optional processing. */
  async hasActiveConsent(userId: string, purpose: ConsentPurpose, subjectId?: string) {
    const row = await this.prisma.user_consents.findFirst({
      where: {
        user_id: userId,
        purpose,
        withdrawn_at: null,
        ...(subjectId ? { subject_id: subjectId } : {}),
      },
      select: { id: true },
    });
    return !!row;
  }
}
