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

  /**
   * Paginated read of the audit trail. Optional filters narrow by the admin who
   * acted, the action name, or the entity that was acted on.
   */
  async findAll(params: {
    page?: number;
    limit?: number;
    adminId?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 50));

    const where = {
      ...(params.adminId ? { admin_id: params.adminId } : {}),
      ...(params.action ? { action: params.action } : {}),
      ...(params.targetType ? { target_type: params.targetType } : {}),
      ...(params.targetId ? { target_id: params.targetId } : {}),
    };

    const [total, entries] = await Promise.all([
      this.prisma.admin_audit_log.count({ where }),
      this.prisma.admin_audit_log.findMany({
        where,
        orderBy: { created_at: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          users: {
            select: {
              id: true,
              email: true,
              profiles: { select: { first_name: true, last_name: true } },
            },
          },
        },
      }),
    ]);

    return {
      data: entries,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }
}
