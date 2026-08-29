import { Test, TestingModule } from "@nestjs/testing";
import { TasksService } from "./tasks.service";
import { BookingsService } from "../bookings/bookings.service";
import { PaymentsService } from "../payments/payments.service";
import { PayoutsService } from "../payments/payouts.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { SseService } from "../sse/sse.service";
import { MailService } from "../mail/mail.service";
import { PricingEngineService } from "../common/pricing.service";
import { INSTALMENT_PENDING } from "../constants";
import { BookingStatus } from "../common/constants/booking-status.enum";

describe("TasksService", () => {
  let service: TasksService;
  let prisma: any;
  let notificationsService: any;
  let mailService: any;

  beforeEach(async () => {
    prisma = {
      progress_reports: { updateMany: jest.fn() },
      revoked_tokens: { deleteMany: jest.fn() },
      location_updates: { deleteMany: jest.fn() },
      payment_installments: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn(),
      },
      payment_plans: { findMany: jest.fn() },
    };

    notificationsService = {
      createNotification: jest.fn().mockResolvedValue(undefined),
    };

    mailService = {
      sendInstallmentReminderEmail: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: BookingsService, useValue: { checkExpiredBookings: jest.fn() } },
        { provide: PaymentsService, useValue: { reconcileMissingInvoices: jest.fn() } },
        { provide: PayoutsService, useValue: { reconcileStalePayouts: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notificationsService },
        { provide: SseService, useValue: { broadcastToUser: jest.fn() } },
        { provide: MailService, useValue: mailService },
        { provide: PricingEngineService, useValue: { calculateCost: jest.fn() } },
      ],
    }).compile();

    service = module.get<TasksService>(TasksService);
  });

  describe("remindOutstandingInstallments", () => {
    it("guards instalment update with status INSTALMENT_PENDING", async () => {
      prisma.payment_installments.findMany.mockResolvedValue([
        {
          id: "inst-1",
          booking_id: "book-1",
          amount: "500",
          installment_no: 1,
          due_date: new Date(),
          bookings: {
            users_bookings_parent_idTousers: {
              id: "parent-1",
              email: "parent@example.com",
              profiles: { first_name: "Jane" },
            },
          },
        },
      ]);
      prisma.payment_installments.updateMany.mockResolvedValue({ count: 1 });

      await service.remindOutstandingInstallments();

      expect(prisma.payment_installments.updateMany).toHaveBeenCalledWith({
        where: { id: "inst-1", status: INSTALMENT_PENDING },
        data: expect.objectContaining({ reminder_count: { increment: 1 } }),
      });
      expect(notificationsService.createNotification).toHaveBeenCalled();
    });
  });

  describe("checkUpcomingBillingCycles", () => {
    it("excludes cancelled bookings from upcoming billing cycle reminders", async () => {
      prisma.payment_plans.findMany.mockResolvedValue([]);

      await service.checkUpcomingBillingCycles();

      expect(prisma.payment_plans.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: "active",
            bookings: {
              status: {
                not: BookingStatus.CANCELLED,
              },
            },
          }),
        }),
      );
    });
  });
});
