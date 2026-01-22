import { Test, TestingModule } from "@nestjs/testing";
import { BookingsService } from "./bookings.service";
import { PrismaService } from "../prisma/prisma.service";
import { ChatService } from "../chat/chat.service";
import { NotificationsService } from "../notifications/notifications.service";
import { NotFoundException, BadRequestException } from "@nestjs/common";

describe("BookingsService", () => {
  let service: BookingsService;
  let prisma: PrismaService;
  let notificationsService: NotificationsService;

  const mockPrisma = {
    bookings: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    payments: {
      create: jest.fn(),
    },
    jobs: {
      findUnique: jest.fn(),
    },
  };

  const mockNotificationsService = {
    createNotification: jest.fn(),
  };

  const mockChatService = {
    createChat: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: ChatService, useValue: mockChatService },
      ],
    }).compile();

    service = module.get<BookingsService>(BookingsService);
    prisma = module.get<PrismaService>(PrismaService);
    notificationsService =
      module.get<NotificationsService>(NotificationsService);

    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("cancelBooking", () => {
    it("should cancel with fee if < 24 hours", async () => {
      const bookingId = "1";
      const start = new Date(Date.now() + 1000 * 60 * 60 * 5); // 5 hours from now
      const hourlyRate = 20;

      mockPrisma.bookings.findUnique.mockResolvedValue({
        id: bookingId,
        status: "CONFIRMED",
        start_time: start,
        nanny_id: "nanny1",
        parent_id: "parent1",
        users_bookings_nanny_idTousers: {
          nanny_details: { hourly_rate: hourlyRate },
        },
      });

      mockPrisma.bookings.update.mockResolvedValue({
        id: bookingId,
        status: "CANCELLED",
      });

      await service.cancelBooking(bookingId, "Emergency");

      expect(mockPrisma.bookings.update).toHaveBeenCalledWith({
        where: { id: bookingId },
        data: expect.objectContaining({
          status: "CANCELLED",
          cancellation_fee: hourlyRate,
          cancellation_fee_status: "pending",
        }),
      });
    });

    it("should cancel without fee if > 24 hours", async () => {
      const bookingId = "2";
      const start = new Date(Date.now() + 1000 * 60 * 60 * 25); // 25 hours from now
      const hourlyRate = 20;

      mockPrisma.bookings.findUnique.mockResolvedValue({
        id: bookingId,
        status: "CONFIRMED",
        start_time: start,
        nanny_id: "nanny1",
        parent_id: "parent1",
        users_bookings_nanny_idTousers: {
          nanny_details: { hourly_rate: hourlyRate },
        },
      });

      await service.cancelBooking(bookingId, "Changed plans");

      expect(mockPrisma.bookings.update).toHaveBeenCalledWith({
        where: { id: bookingId },
        data: expect.objectContaining({
          status: "CANCELLED",
          cancellation_fee: 0,
          cancellation_fee_status: "no_fee",
        }),
      });
    });
  });

  describe("completeBooking", () => {
    it("should complete booking and create payment", async () => {
      const bookingId = "3";
      const start = new Date(Date.now() - 1000 * 60 * 60 * 2); // Started 2 hours ago
      const hourlyRate = 25;

      mockPrisma.bookings.findUnique.mockResolvedValue({
        id: bookingId,
        status: "IN_PROGRESS",
        start_time: start,
        nanny_id: "nanny1",
        parent_id: "parent1",
        users_bookings_nanny_idTousers: {
          nanny_details: { hourly_rate: hourlyRate },
        },
      });

      mockPrisma.bookings.update.mockResolvedValue({
        id: bookingId,
        status: "COMPLETED",
      });

      await service.completeBooking(bookingId);

      expect(mockPrisma.payments.create).toHaveBeenCalled();
      expect(mockNotificationsService.createNotification).toHaveBeenCalledTimes(
        2,
      );
    });
  });
});
