import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

/* 
 * NOTE: In a real production system, audit logs should preferably use a separate database 
 * or a specialized logging service (e.g., ElasticSearch, CloudWatch) to prevent
 * performance impact on the main DB and for immutability.
 * 
 * For this phase, we will log strict audit events to the Logger (which goes to stdout/CloudWatch)
 * and optionally to DB if we create the table.
 */

@Injectable()
export class AuditService {
    private readonly logger = new Logger('AuditLog');

    constructor(private prisma: PrismaService) { }

    async log(entry: {
        userId: string;
        action: string;
        resourceType?: string;
        resourceId?: string;
        ipAddress?: string;
        userAgent?: string;
        details?: any;
    }) {
        // 1. Structure log for structured logging systems (ELK/Datadog)
        this.logger.log({
            type: 'AUDIT_LOG',
            timestamp: new Date().toISOString(),
            ...entry,
        });

        // 2. Future: Store in DB if needed for in-app audit history
        // await this.prisma.auditLog.create({ ... })
    }
}
