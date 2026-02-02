import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class DataCleanupService {
    private readonly logger = new Logger(DataCleanupService.name);

    constructor(private readonly prisma: PrismaService) { }

    @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
    async cleanupOldData() {
        this.logger.log('Starting daily data cleanup...');

        try {
            // 1. Delete messages older than 1 year (Data Minimization)
            const messageCutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
            const deletedMessages = await this.prisma.messages.deleteMany({
                where: {
                    created_at: {
                        lt: messageCutoff,
                    },
                },
            });
            this.logger.log(`Deleted ${deletedMessages.count} old messages.`);

            // 2. Delete logs older than 90 days (if we implement audit logs in DB later)
            // Placeholder for future audit log cleanup

            // 3. Anonymize cancelled bookings older than 6 months
            const bookingCutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
            /* 
             * Ideally we don't delete bookings for financial records, 
             * but we can clear PII if needed. For now, let's keep them but maybe archive.
             * Just logging potential candidates for now.
             */

            this.logger.log('Daily cleanup completed successfully.');
        } catch (error) {
            this.logger.error('Data cleanup failed', error);
        }
    }

    /**
     * GDPR: Complete account deletion (Right to be Erasure)
     * This handles the complex cascade deletion to ensures clean removal
     */
    async deleteUserData(userId: string): Promise<void> {
        this.logger.log(`Processing "Right to be Forgotten" for user: ${userId}`);

        await this.prisma.$transaction(async (tx) => {
            // 1. Anonymize reviews (keep data for nanny rating integrity, remove user link)
            await tx.reviews.updateMany({
                where: { reviewer_id: userId },
                data: {
                    reviewer_id: null,
                    comment: '[User deleted account]'
                }
            });

            // 2. Delete PII-heavy related records
            // Note: Cascading deletes usually handle this, but explicit is safer for GDPR
            // Deleting profile triggers cascade for many things if set in schema

            // Delete profile (Trigger cascade)
            await tx.profiles.deleteMany({ where: { user_id: userId } });

            // Delete identity documents
            await tx.identity_documents.deleteMany({ where: { user_id: userId } });

            // Delete the user record itself
            await tx.users.delete({ where: { id: userId } });
        });

        this.logger.log(`Successfully deleted data for user: ${userId}`);
    }
}
