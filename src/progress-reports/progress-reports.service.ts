import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";

import { CreateTemplateDto } from "./dto/create-template.dto";
import { SubmitReportDto } from "./dto/submit-report.dto";
import { PROGRESS_REPORT_DUE_HOURS } from "../common/constants/constants";

@Injectable()
export class ProgressReportsService {
  private readonly logger = new Logger(ProgressReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async createTemplate(data: CreateTemplateDto, adminId: string) {
    if (!data.questions || data.questions.length === 0) {
      throw new BadRequestException("Template must contain at least one question");
    }

    // Validate that MULTI_CHOICE questions have options
    for (const q of data.questions) {
      if (q.input_type === "MULTI_CHOICE" && (!q.options || q.options.length === 0)) {
        throw new BadRequestException(
          `Question "${q.question_text}" is MULTI_CHOICE but has no options configured`,
        );
      }
    }

    return this.prisma.report_templates.create({
      data: {
        created_by: adminId,
        report_template_questions: {
          create: data.questions.map((q) => ({
            question_text: q.question_text,
            input_type: q.input_type,
            options: q.options || [],
            is_required: q.is_required ?? true,
            display_order: q.display_order,
          })),
        },
      },
      include: {
        report_template_questions: {
          orderBy: { display_order: "asc" },
        },
      },
    });
  }

  async getTemplates() {
    return this.prisma.report_templates.findMany({
      where: { is_active: true },
      include: {
        report_template_questions: {
          orderBy: { display_order: "asc" },
        },
      },
      orderBy: { version: "desc" },
    });
  }

  async getReportsForNanny(nannyId: string, status?: string) {
    const whereClause: any = { nanny_id: nannyId };
    if (status === "PENDING") {
      // Pending queue for nanny must include both unexpired PENDING reports and OVERDUE reports
      // that are still awaiting submission, so overdue reports do not vanish from the nanny's action list.
      whereClause.status = { in: ["PENDING", "OVERDUE"] };
    } else if (status) {
      whereClause.status = status as any;
    }

    return this.prisma.progress_reports.findMany({
      where: whereClause,
      include: {
        report_templates: {
          include: {
            report_template_questions: {
              orderBy: { display_order: "asc" },
            },
          },
        },
        bookings: {
          include: {
            users_bookings_parent_idTousers: {
              select: { profiles: true },
            },
            service_requests: true,
          },
        },
      },
      orderBy: { due_at: "asc" },
    });
  }

  async getReportsForParent(parentId: string) {
    return this.prisma.progress_reports.findMany({
      where: {
        bookings: { parent_id: parentId },
        status: "SUBMITTED",
      },
      include: {
        report_templates: {
          include: {
            report_template_questions: {
              orderBy: { display_order: "asc" },
            },
          },
        },
        report_answers: true,
        bookings: {
          include: {
            users_bookings_nanny_idTousers: {
              select: { profiles: true },
            },
          },
        },
      },
      orderBy: { submitted_at: "desc" },
    });
  }

  async getReportById(id: string, userId: string, role: string) {
    const report = await this.prisma.progress_reports.findUnique({
      where: { id },
      include: {
        report_templates: {
          include: {
            report_template_questions: {
              orderBy: { display_order: "asc" },
            },
          },
        },
        report_answers: true,
        bookings: {
          include: {
            users_bookings_parent_idTousers: {
              select: { profiles: true },
            },
            users_bookings_nanny_idTousers: {
              select: { profiles: true },
            },
            service_requests: true,
          },
        },
      },
    });

    if (!report) throw new NotFoundException("Report not found");

    const isNanny = report.nanny_id === userId;
    const isParent = report.bookings?.parent_id === userId;
    const isAdmin = role === "admin";

    if (!isNanny && !isParent && !isAdmin) {
      throw new NotFoundException("Report not found");
    }

    // Parents can only view reports after they have been submitted.
    // An unsubmitted draft (PENDING/OVERDUE) is hidden from parents.
    if (isParent && !isNanny && !isAdmin && report.status !== "SUBMITTED") {
      throw new NotFoundException("Report not found");
    }

    return report;
  }

  async submitReport(id: string, nannyId: string, dto: SubmitReportDto) {
    const report = await this.prisma.progress_reports.findUnique({
      where: { id },
      include: {
        report_templates: {
          include: { report_template_questions: true },
        },
        bookings: true,
      },
    });

    if (!report) throw new NotFoundException("Report not found");
    if (report.nanny_id !== nannyId) {
      throw new ForbiddenException("Not authorized to submit this report");
    }
    if (report.status === "SUBMITTED") {
      throw new BadRequestException("Report is already submitted");
    }

    const templateQuestions = report.report_templates?.report_template_questions || [];
    const questionMap = new Map(templateQuestions.map((q) => [q.id, q]));

    // 1. Validate that all submitted answer question_ids exist on the report's template
    // and that there are no duplicate answers for the same question.
    const seenQuestionIds = new Set<string>();
    for (const answer of dto.answers) {
      if (!questionMap.has(answer.question_id)) {
        throw new BadRequestException(
          `Question ID ${answer.question_id} does not belong to this report template`,
        );
      }
      if (seenQuestionIds.has(answer.question_id)) {
        throw new BadRequestException(
          `Duplicate answer submitted for question ID ${answer.question_id}`,
        );
      }
      seenQuestionIds.add(answer.question_id);
    }

    // 2. Validate required questions and value correctness
    for (const q of templateQuestions) {
      const submittedAnswer = dto.answers.find((a) => a.question_id === q.id);

      if (q.is_required) {
        if (!submittedAnswer) {
          throw new BadRequestException(
            `Missing answer for required question: "${q.question_text}"`,
          );
        }

        if (q.input_type === "TEXT") {
          if (!submittedAnswer.answer_text || !submittedAnswer.answer_text.trim()) {
            throw new BadRequestException(
              `Answer text is required for question: "${q.question_text}"`,
            );
          }
        } else if (q.input_type === "RATING") {
          if (
            submittedAnswer.answer_rating === undefined ||
            submittedAnswer.answer_rating === null ||
            submittedAnswer.answer_rating < 1 ||
            submittedAnswer.answer_rating > 5
          ) {
            throw new BadRequestException(
              `Rating (1-5) is required for question: "${q.question_text}"`,
            );
          }
        } else if (q.input_type === "YES_NO") {
          const val = submittedAnswer.answer_text?.trim().toLowerCase();
          if (val !== "yes" && val !== "no") {
            throw new BadRequestException(
              `Answer must be "yes" or "no" for question: "${q.question_text}"`,
            );
          }
        } else if (q.input_type === "MULTI_CHOICE") {
          if (
            !submittedAnswer.answer_choices ||
            submittedAnswer.answer_choices.length === 0
          ) {
            throw new BadRequestException(
              `At least one choice is required for question: "${q.question_text}"`,
            );
          }
        }
      }

      // If optional answer is provided, validate its format
      if (submittedAnswer) {
        if (
          q.input_type === "RATING" &&
          submittedAnswer.answer_rating !== undefined &&
          submittedAnswer.answer_rating !== null
        ) {
          if (submittedAnswer.answer_rating < 1 || submittedAnswer.answer_rating > 5) {
            throw new BadRequestException(
              `Rating must be between 1 and 5 for question: "${q.question_text}"`,
            );
          }
        }
        if (q.input_type === "YES_NO" && submittedAnswer.answer_text) {
          const val = submittedAnswer.answer_text.trim().toLowerCase();
          if (val !== "yes" && val !== "no") {
            throw new BadRequestException(
              `Answer must be "yes" or "no" for question: "${q.question_text}"`,
            );
          }
        }
        if (
          q.input_type === "MULTI_CHOICE" &&
          submittedAnswer.answer_choices &&
          submittedAnswer.answer_choices.length > 0
        ) {
          const validOptions = new Set(q.options);
          for (const choice of submittedAnswer.answer_choices) {
            if (!validOptions.has(choice)) {
              throw new BadRequestException(
                `Choice "${choice}" is not a valid option for question: "${q.question_text}"`,
              );
            }
          }
        }
      }
    }

    const submittedAt = new Date();

    // Atomic submission claim inside transaction
    const updatedReport = await this.prisma.$transaction(async (tx) => {
      // Guarded atomic state transition
      const claim = await tx.progress_reports.updateMany({
        where: {
          id,
          nanny_id: nannyId,
          status: { in: ["PENDING", "OVERDUE"] },
        },
        data: {
          status: "SUBMITTED",
          submitted_at: submittedAt,
          personal_remark: dto.personal_remark?.trim() || null,
        },
      });

      if (claim.count === 0) {
        throw new BadRequestException("Report is already submitted or not found");
      }

      // Delete any pre-existing answers
      await tx.report_answers.deleteMany({
        where: { report_id: id },
      });

      // Create answers
      await tx.report_answers.createMany({
        data: dto.answers.map((a) => ({
          report_id: id,
          question_id: a.question_id,
          answer_text: a.answer_text?.trim() || null,
          answer_rating: a.answer_rating ?? null,
          answer_choices: a.answer_choices || [],
        })),
      });

      return tx.progress_reports.findUnique({
        where: { id },
        include: {
          report_answers: true,
          report_templates: {
            include: {
              report_template_questions: {
                orderBy: { display_order: "asc" },
              },
            },
          },
        },
      });
    });

    // Notify Parent (after transaction successfully commits)
    if (report.bookings?.parent_id) {
      await this.notificationsService
        .createNotification(
          report.bookings.parent_id,
          "Progress Report Submitted",
          `Your caregiver has submitted the progress report for booking #${report.booking_id}.`,
          "success",
        )
        .catch((err) =>
          this.logger.error(
            `Failed to notify parent about submitted progress report: ${err.message}`,
          ),
        );
    }

    return updatedReport;
  }

  async generateReportForBooking(bookingId: string) {
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      include: {
        booking_children: true,
      },
    });
    if (!booking || !booking.nanny_id) return null;

    // Check if report already exists
    const existing = await this.prisma.progress_reports.findUnique({
      where: { booking_id: bookingId },
    });
    if (existing) return existing;

    // Find the active template
    const template = await this.prisma.report_templates.findFirst({
      where: { is_active: true },
      orderBy: { version: "desc" },
    });

    if (!template) {
      this.logger.error("Cannot generate report: No active template found");
      return null;
    }

    // Due time: PROGRESS_REPORT_DUE_HOURS from completion (or scheduled end, whichever is later)
    // to prevent instant overdue status on late completions.
    const completionAnchor = booking.actual_end_time
      ? booking.actual_end_time.getTime()
      : booking.end_time
        ? Math.max(booking.end_time.getTime(), Date.now())
        : Date.now();

    const dueMs = PROGRESS_REPORT_DUE_HOURS * 60 * 60 * 1000;
    const dueTime = new Date(completionAnchor + dueMs);

    const childId = booking.booking_children?.[0]?.child_id ?? null;

    try {
      return await this.prisma.progress_reports.create({
        data: {
          booking_id: bookingId,
          nanny_id: booking.nanny_id,
          child_id: childId,
          template_id: template.id,
          due_at: dueTime,
          status: "PENDING",
        },
      });
    } catch (err: any) {
      // Gracefully handle race condition where concurrent completion calls create the report
      if (err?.code === "P2002") {
        return this.prisma.progress_reports.findUnique({
          where: { booking_id: bookingId },
        });
      }
      throw err;
    }
  }
}
