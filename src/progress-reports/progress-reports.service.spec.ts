import { Test, TestingModule } from "@nestjs/testing";
import { ProgressReportsService } from "./progress-reports.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { report_input_type } from "@prisma/client";

describe("ProgressReportsService", () => {
  let service: ProgressReportsService;
  let prisma: any;
  let notificationsService: NotificationsService;

  beforeEach(async () => {
    prisma = {
      report_templates: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
      progress_reports: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      report_answers: {
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      },
      bookings: {
        findUnique: jest.fn(),
      },
      $transaction: jest.fn((callback) => callback(prisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProgressReportsService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
        {
          provide: NotificationsService,
          useValue: {
            createNotification: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<ProgressReportsService>(ProgressReportsService);
    notificationsService =
      module.get<NotificationsService>(NotificationsService);
  });

  describe("createTemplate", () => {
    it("rejects empty questions array", async () => {
      await expect(
        service.createTemplate({ questions: [] }, "admin-1"),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects MULTI_CHOICE question without options", async () => {
      await expect(
        service.createTemplate(
          {
            questions: [
              {
                question_text: "Favorite activity?",
                input_type: report_input_type.MULTI_CHOICE,
                options: [],
                display_order: 1,
              },
            ],
          },
          "admin-1",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("creates template successfully", async () => {
      const mockCreated = { id: "t-1", version: 1 };
      prisma.report_templates.create.mockResolvedValue(mockCreated);

      const result = await service.createTemplate(
        {
          questions: [
            {
              question_text: "Child mood",
              input_type: report_input_type.TEXT,
              display_order: 1,
              is_required: true,
            },
          ],
        },
        "admin-1",
      );

      expect(prisma.report_templates.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            created_by: "admin-1",
          }),
        }),
      );
      expect(result).toEqual(mockCreated);
    });
  });

  describe("getReportsForNanny", () => {
    it("includes both PENDING and OVERDUE when status is PENDING", async () => {
      prisma.progress_reports.findMany.mockResolvedValue([]);
      await service.getReportsForNanny("nanny-1", "PENDING");

      expect(prisma.progress_reports.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            nanny_id: "nanny-1",
            status: { in: ["PENDING", "OVERDUE"] },
          },
        }),
      );
    });

    it("queries exact status when not PENDING", async () => {
      prisma.progress_reports.findMany.mockResolvedValue([]);
      await service.getReportsForNanny("nanny-1", "SUBMITTED");

      expect(prisma.progress_reports.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            nanny_id: "nanny-1",
            status: "SUBMITTED",
          },
        }),
      );
    });
  });

  describe("getReportsForParent", () => {
    it("filters status SUBMITTED and includes report_templates with questions", async () => {
      prisma.progress_reports.findMany.mockResolvedValue([]);
      await service.getReportsForParent("parent-1");

      expect(prisma.progress_reports.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            bookings: { parent_id: "parent-1" },
            status: "SUBMITTED",
          },
          include: expect.objectContaining({
            report_templates: expect.any(Object),
            report_answers: true,
          }),
        }),
      );
    });
  });

  describe("getReportById", () => {
    it("throws NotFoundException when report does not exist", async () => {
      prisma.progress_reports.findUnique.mockResolvedValue(null);
      await expect(
        service.getReportById("rep-1", "user-1", "nanny"),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException for unauthorized users", async () => {
      prisma.progress_reports.findUnique.mockResolvedValue({
        id: "rep-1",
        nanny_id: "nanny-1",
        status: "SUBMITTED",
        bookings: { parent_id: "parent-1" },
      });

      await expect(
        service.getReportById("rep-1", "stranger", "parent"),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when parent attempts to read unsubmitted report", async () => {
      prisma.progress_reports.findUnique.mockResolvedValue({
        id: "rep-1",
        nanny_id: "nanny-1",
        status: "PENDING",
        bookings: { parent_id: "parent-1" },
      });

      await expect(
        service.getReportById("rep-1", "parent-1", "parent"),
      ).rejects.toThrow(NotFoundException);
    });

    it("allows parent to read SUBMITTED report", async () => {
      const mockReport = {
        id: "rep-1",
        nanny_id: "nanny-1",
        status: "SUBMITTED",
        bookings: { parent_id: "parent-1" },
      };
      prisma.progress_reports.findUnique.mockResolvedValue(mockReport);

      const result = await service.getReportById("rep-1", "parent-1", "parent");
      expect(result).toEqual(mockReport);
    });

    it("allows nanny to read their own report in any status", async () => {
      const mockReport = {
        id: "rep-1",
        nanny_id: "nanny-1",
        status: "PENDING",
        bookings: { parent_id: "parent-1" },
      };
      prisma.progress_reports.findUnique.mockResolvedValue(mockReport);

      const result = await service.getReportById("rep-1", "nanny-1", "nanny");
      expect(result).toEqual(mockReport);
    });

    it("allows admin to read report in any status", async () => {
      const mockReport = {
        id: "rep-1",
        nanny_id: "nanny-1",
        status: "PENDING",
        bookings: { parent_id: "parent-1" },
      };
      prisma.progress_reports.findUnique.mockResolvedValue(mockReport);

      const result = await service.getReportById("rep-1", "admin-1", "admin");
      expect(result).toEqual(mockReport);
    });
  });

  describe("submitReport", () => {
    const mockReport = {
      id: "rep-1",
      booking_id: "book-1",
      nanny_id: "nanny-1",
      status: "PENDING",
      bookings: { parent_id: "parent-1" },
      report_templates: {
        report_template_questions: [
          {
            id: "q-text",
            question_text: "Daily summary",
            input_type: "TEXT",
            is_required: true,
          },
          {
            id: "q-rating",
            question_text: "Behavior rating",
            input_type: "RATING",
            is_required: true,
          },
          {
            id: "q-yesno",
            question_text: "Medication taken",
            input_type: "YES_NO",
            is_required: false,
          },
          {
            id: "q-multi",
            question_text: "Meals eaten",
            input_type: "MULTI_CHOICE",
            options: ["Breakfast", "Lunch", "Snack"],
            is_required: true,
          },
        ],
      },
    };

    it("throws NotFoundException if report not found", async () => {
      prisma.progress_reports.findUnique.mockResolvedValue(null);
      await expect(
        service.submitReport("rep-1", "nanny-1", { answers: [] }),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException if not the assigned nanny", async () => {
      prisma.progress_reports.findUnique.mockResolvedValue(mockReport);
      await expect(
        service.submitReport("rep-1", "imposter-nanny", { answers: [] }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws BadRequestException if report is already submitted", async () => {
      prisma.progress_reports.findUnique.mockResolvedValue({
        ...mockReport,
        status: "SUBMITTED",
      });
      await expect(
        service.submitReport("rep-1", "nanny-1", { answers: [] }),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException for foreign question IDs", async () => {
      prisma.progress_reports.findUnique.mockResolvedValue(mockReport);
      await expect(
        service.submitReport("rep-1", "nanny-1", {
          answers: [{ question_id: "foreign-q-id", answer_text: "hi" }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException for duplicate question answers", async () => {
      prisma.progress_reports.findUnique.mockResolvedValue(mockReport);
      await expect(
        service.submitReport("rep-1", "nanny-1", {
          answers: [
            { question_id: "q-text", answer_text: "First answer" },
            { question_id: "q-text", answer_text: "Duplicate answer" },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException if required question is missing", async () => {
      prisma.progress_reports.findUnique.mockResolvedValue(mockReport);
      await expect(
        service.submitReport("rep-1", "nanny-1", {
          answers: [
            { question_id: "q-text", answer_text: "Done well" },
            // missing q-rating and q-multi
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException if required text is blank", async () => {
      prisma.progress_reports.findUnique.mockResolvedValue(mockReport);
      await expect(
        service.submitReport("rep-1", "nanny-1", {
          answers: [
            { question_id: "q-text", answer_text: "   " },
            { question_id: "q-rating", answer_rating: 5 },
            { question_id: "q-multi", answer_choices: ["Lunch"] },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException if rating is out of bounds", async () => {
      prisma.progress_reports.findUnique.mockResolvedValue(mockReport);
      await expect(
        service.submitReport("rep-1", "nanny-1", {
          answers: [
            { question_id: "q-text", answer_text: "Good day" },
            { question_id: "q-rating", answer_rating: 6 },
            { question_id: "q-multi", answer_choices: ["Lunch"] },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException if multi choice answer contains invalid option", async () => {
      prisma.progress_reports.findUnique.mockResolvedValue(mockReport);
      await expect(
        service.submitReport("rep-1", "nanny-1", {
          answers: [
            { question_id: "q-text", answer_text: "Good day" },
            { question_id: "q-rating", answer_rating: 5 },
            { question_id: "q-multi", answer_choices: ["InvalidOption"] },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("submits report atomically and notifies parent", async () => {
      prisma.progress_reports.findUnique
        .mockResolvedValueOnce(mockReport) // initial read
        .mockResolvedValueOnce({ ...mockReport, status: "SUBMITTED" }); // post-tx read
      prisma.progress_reports.updateMany.mockResolvedValue({ count: 1 });
      prisma.report_answers.deleteMany.mockResolvedValue({ count: 0 });
      prisma.report_answers.createMany.mockResolvedValue({ count: 4 });

      const result = await service.submitReport("rep-1", "nanny-1", {
        answers: [
          { question_id: "q-text", answer_text: "Great day with kid!" },
          { question_id: "q-rating", answer_rating: 5 },
          { question_id: "q-yesno", answer_text: "yes" },
          { question_id: "q-multi", answer_choices: ["Lunch", "Snack"] },
        ],
        personal_remark: "Had a wonderful time.",
      });

      // Assert atomic claim
      expect(prisma.progress_reports.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: "rep-1",
            nanny_id: "nanny-1",
            status: { in: ["PENDING", "OVERDUE"] },
          },
          data: expect.objectContaining({
            status: "SUBMITTED",
            personal_remark: "Had a wonderful time.",
          }),
        }),
      );

      // Assert answers inserted
      expect(prisma.report_answers.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({
            report_id: "rep-1",
            question_id: "q-text",
            answer_text: "Great day with kid!",
          }),
        ]),
      });

      // Assert parent notified
      expect(notificationsService.createNotification).toHaveBeenCalledWith(
        "parent-1",
        "Progress Report Submitted",
        expect.stringContaining("book-1"),
        "success",
      );

      expect(result).toBeDefined();
    });

    it("fails cleanly if atomic updateMany claim races (count = 0)", async () => {
      prisma.progress_reports.findUnique.mockResolvedValue(mockReport);
      prisma.progress_reports.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.submitReport("rep-1", "nanny-1", {
          answers: [
            { question_id: "q-text", answer_text: "Great day!" },
            { question_id: "q-rating", answer_rating: 5 },
            { question_id: "q-multi", answer_choices: ["Lunch"] },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("generateReportForBooking", () => {
    it("returns null if booking does not exist or has no nanny", async () => {
      prisma.bookings.findUnique.mockResolvedValue(null);
      const res = await service.generateReportForBooking("b-1");
      expect(res).toBeNull();
    });

    it("returns existing report if one already exists", async () => {
      prisma.bookings.findUnique.mockResolvedValue({
        id: "b-1",
        nanny_id: "n-1",
      });
      prisma.progress_reports.findUnique.mockResolvedValue({ id: "rep-1" });

      const res = await service.generateReportForBooking("b-1");
      expect(res).toEqual({ id: "rep-1" });
    });

    it("attaches child_id and sets due_at from completion time anchor", async () => {
      const now = new Date();
      prisma.bookings.findUnique.mockResolvedValue({
        id: "b-1",
        nanny_id: "n-1",
        actual_end_time: now,
        booking_children: [{ child_id: "child-123" }],
      });
      prisma.progress_reports.findUnique.mockResolvedValue(null);
      prisma.report_templates.findFirst.mockResolvedValue({ id: "tmpl-1" });
      prisma.progress_reports.create.mockResolvedValue({
        id: "rep-new",
        child_id: "child-123",
      });

      const res = await service.generateReportForBooking("b-1");

      expect(prisma.progress_reports.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            booking_id: "b-1",
            nanny_id: "n-1",
            child_id: "child-123",
            template_id: "tmpl-1",
            status: "PENDING",
          }),
        }),
      );
      expect(res).toEqual({ id: "rep-new", child_id: "child-123" });
    });

    it("gracefully catches P2002 race condition on concurrent generation", async () => {
      prisma.bookings.findUnique.mockResolvedValue({
        id: "b-1",
        nanny_id: "n-1",
      });
      prisma.progress_reports.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "rep-from-race" });
      prisma.report_templates.findFirst.mockResolvedValue({ id: "tmpl-1" });
      prisma.progress_reports.create.mockRejectedValue({ code: "P2002" });

      const res = await service.generateReportForBooking("b-1");
      expect(res).toEqual({ id: "rep-from-race" });
    });
  });
});
