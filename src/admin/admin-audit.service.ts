import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export interface LogActionParams {
  adminId: string;
  action: string;
  targetType: string;
  targetId?: string;
  metadata?: Record<string, any>;
  ipAddress?: string;
}

@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async logAction(params: LogActionParams): Promise<void> {
    try {
      await this.prisma.admin_audit_log.create({
        data: {
          admin_id: params.adminId,
          action: params.action,
          target_type: params.targetType,
          target_id: params.targetId ?? null,
          metadata: params.metadata ?? null,
          ip_address: params.ipAddress ?? null,
        },
      });
    } catch (err) {
      // Audit logging must never crash the primary action
      this.logger.error(`Failed to write admin audit log: ${err?.message}`, err?.stack);
    }
  }
}
