import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

import { CreateTemplateDto } from "./dto/create-template.dto";
import { SubmitReportDto } from "./dto/submit-report.dto";
import { PROGRESS_REPORT_DUE_HOURS } from "../common/constants/constants";

@Injectable()
export class ProgressReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async createTemplate(data: CreateTemplateDto, adminId: string) {
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
      include: { report_template_questions: true },
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
    if (status) {
      whereClause.status = status as any;
    }
    return this.prisma.progress_reports.findMany({
      where: whereClause,
      include: {
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

  async getReportById(id: string) {
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
    return report;
  }

  async submitReport(id: string, nannyId: string, dto: SubmitReportDto) {
    const report = await this.prisma.progress_reports.findUnique({
      where: { id },
      include: {
        report_templates: {
          include: { report_template_questions: true },
        },
      },
    });

    if (!report) throw new NotFoundException("Report not found");
    if (report.nanny_id !== nannyId) {
      throw new ForbiddenException("Not authorized to submit this report");
    }
    if (report.status === "SUBMITTED") {
      throw new BadRequestException("Report is already submitted");
    }

    // Validate required questions
    const requiredQuestions = report.report_templates.report_template_questions.filter(
      (q) => q.is_required,
    );
    const answeredQuestionIds = dto.answers.map((a) => a.question_id);
    const missing = requiredQuestions.filter(
      (q) => !answeredQuestionIds.includes(q.id),
    );

    if (missing.length > 0) {
      throw new BadRequestException(
        `Missing answers for required questions: ${missing.map((q) => q.question_text).join(", ")}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Delete any existing answers if resubmitting (just in case)
      await tx.report_answers.deleteMany({
        where: { report_id: id },
      });

      // Create answers
      await tx.report_answers.createMany({
        data: dto.answers.map((a) => ({
          report_id: id,
          question_id: a.question_id,
          answer_text: a.answer_text,
          answer_rating: a.answer_rating,
          answer_choices: a.answer_choices || [],
        })),
      });

      // Update report status
      return tx.progress_reports.update({
        where: { id },
        data: {
          status: "SUBMITTED",
          submitted_at: new Date(),
          personal_remark: dto.personal_remark,
        },
      });
    });
  }

  async generateReportForBooking(bookingId: string) {
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
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
      console.error("Cannot generate report: No active template found");
      return null;
    }

    const dueMs = PROGRESS_REPORT_DUE_HOURS * 60 * 60 * 1000;
    const dueTime = booking.end_time 
      ? new Date(booking.end_time.getTime() + dueMs)
      : new Date(Date.now() + dueMs);

    return this.prisma.progress_reports.create({
      data: {
        booking_id: bookingId,
        nanny_id: booking.nanny_id,
        template_id: template.id,
        due_at: dueTime,
        status: "PENDING",
      },
    });
  }
}
