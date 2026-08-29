import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { RequestsService } from "../requests/requests.service";

@Injectable()
export class AssignmentsTaskService {
  private readonly logger = new Logger(AssignmentsTaskService.name);

  constructor(
    private prisma: PrismaService,
    private requestsService: RequestsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleAssignmentTimeouts() {
    const now = new Date();
    const expiredAssignments = await this.prisma.assignments.findMany({
      where: {
        status: "pending",
        response_deadline: {
          lt: now,
        },
      },
    });

    if (expiredAssignments.length === 0) {
      return;
    }

    this.logger.log(`Found ${expiredAssignments.length} expired assignments.`);

    for (const assignment of expiredAssignments) {
      try {
        // 1. Atomically CLAIM the timeout. The findMany above is a stale read:
        // a nanny can accept (or reject) in the gap before this write, and an
        // unguarded update would stamp "timeout" over that response and then
        // trigger a re-match — assigning a second nanny to a request whose
        // first nanny just accepted it. The status guard makes accept/reject
        // and this cron mutually exclusive: whoever writes first wins, and a
        // count of 0 means someone else already responded, so we skip.
        const claimed = await this.prisma.assignments.updateMany({
          where: { id: assignment.id, status: "pending" },
          data: {
            status: "timeout",
            responded_at: now,
          },
        });

        if (claimed.count === 0) {
          this.logger.log(
            `Assignment ${assignment.id} was responded to before timeout could be applied. Skipping.`,
          );
          continue;
        }

        // 2. Trigger re-matching
        this.logger.log(
          `Assignment ${assignment.id} timed out. Triggering re-match for request ${assignment.request_id}...`,
        );
        await this.requestsService.triggerMatching(assignment.request_id);
      } catch (error) {
        this.logger.error(
          `Error handling timeout for assignment ${assignment.id}`,
          error,
        );
      }
    }
  }
}
