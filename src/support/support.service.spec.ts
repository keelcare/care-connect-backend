import { Test, TestingModule } from "@nestjs/testing";
import { SupportService } from "./support.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";

describe("SupportService", () => {
  let service: SupportService;
  let prisma: any;
  let notificationsService: any;

  beforeEach(async () => {
    prisma = {
      support_tickets: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn().mockResolvedValue(10),
      },
      support_ticket_messages: {
        create: jest.fn(),
        findMany: jest.fn(),
      },
      bookings: {
        findUnique: jest.fn(),
      },
      users: {
        findMany: jest.fn().mockResolvedValue([{ id: "admin-1" }]),
        findFirst: jest.fn(),
      },
    };

    notificationsService = {
      createNotification: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notificationsService },
      ],
    }).compile();

    service = module.get<SupportService>(SupportService);
  });

  describe("createTicket", () => {
    it("creates ticket with unique number and notifies admins", async () => {
      prisma.support_tickets.create.mockResolvedValue({
        id: "ticket-1",
        ticket_number: "TIC-260829-0011-ABCD",
        user_id: "user-1",
        subject: "Help needed",
      });

      const ticket = await service.createTicket("user-1", "parent", {
        subject: "Help needed",
        description: "Need assistance with payment receipt",
        category: "payment",
      });

      expect(prisma.support_tickets.create).toHaveBeenCalled();
      expect(notificationsService.createNotification).toHaveBeenCalledWith(
        "admin-1",
        expect.stringContaining("New support ticket"),
        expect.anything(),
        "info",
        "support",
        "ticket-1",
      );
      expect(ticket.id).toBe("ticket-1");
    });

    it("auto-classifies critical priority and notifies admins with warning severity", async () => {
      prisma.support_tickets.create.mockImplementation(({ data }) => ({
        id: "ticket-crit",
        ...data,
      }));

      const ticket = await service.createTicket("user-1", "parent", {
        subject: "Emergency! Nanny injured my baby",
        description: "Caregiver slapped child, baby is bleeding and ambulance called",
        category: "grievance",
      });

      expect(prisma.support_tickets.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            priority: "critical",
          }),
        }),
      );
      expect(notificationsService.createNotification).toHaveBeenCalledWith(
        "admin-1",
        expect.stringContaining("New support ticket"),
        expect.stringContaining("critical-priority"),
        "warning",
        "support",
        "ticket-crit",
      );
      expect(ticket.priority).toBe("critical");
    });

    it("auto-classifies high priority for caregiver absence/no-show without client priority", async () => {
      prisma.support_tickets.create.mockImplementation(({ data }) => ({
        id: "ticket-high",
        ...data,
      }));

      const ticket = await service.createTicket("user-1", "parent", {
        subject: "Where is my nanny? (Booking #1234)",
        description: "Caregiver has not arrived and is unable to reach.",
        category: "booking",
      });

      expect(prisma.support_tickets.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            priority: "high",
          }),
        }),
      );
      expect(notificationsService.createNotification).toHaveBeenCalledWith(
        "admin-1",
        expect.stringContaining("New support ticket"),
        expect.stringContaining("high-priority"),
        "warning",
        "support",
        "ticket-high",
      );
      expect(ticket.priority).toBe("high");
    });

    it("auto-classifies low priority for feedback and compliments", async () => {
      prisma.support_tickets.create.mockImplementation(({ data }) => ({
        id: "ticket-low",
        ...data,
      }));

      const ticket = await service.createTicket("user-1", "parent", {
        subject: "Thank you for great service",
        description: "Appreciation and feedback for the wonderful caregiver.",
        category: "other",
      });

      expect(prisma.support_tickets.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            priority: "low",
          }),
        }),
      );
      expect(notificationsService.createNotification).toHaveBeenCalledWith(
        "admin-1",
        expect.stringContaining("New support ticket"),
        expect.stringContaining("low-priority"),
        "info",
        "support",
        "ticket-low",
      );
      expect(ticket.priority).toBe("low");
    });

    it("rejects booking ticket if user is not a participant", async () => {
      prisma.bookings.findUnique.mockResolvedValue({
        id: "booking-1",
        parent_id: "parent-1",
        nanny_id: "nanny-1",
      });

      await expect(
        service.createTicket("user-stranger", "parent", {
          subject: "Issue",
          description: "Not my booking",
          category: "booking",
          bookingId: "booking-1",
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("assignTicket", () => {
    it("throws BadRequestException if assigned target is not an active admin", async () => {
      prisma.support_tickets.findUnique.mockResolvedValue({ id: "ticket-1" });
      prisma.users.findFirst.mockResolvedValue(null);

      await expect(
        service.assignTicket("ticket-1", "user-non-admin"),
      ).rejects.toThrow(BadRequestException);
    });

    it("assigns ticket successfully to valid active admin", async () => {
      prisma.support_tickets.findUnique.mockResolvedValue({ id: "ticket-1" });
      prisma.users.findFirst.mockResolvedValue({ id: "admin-2" });
      prisma.support_tickets.update.mockResolvedValue({
        id: "ticket-1",
        assigned_admin_id: "admin-2",
      });

      const res = await service.assignTicket("ticket-1", "admin-2");
      expect(prisma.support_tickets.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "ticket-1" },
          data: expect.objectContaining({ assigned_admin_id: "admin-2" }),
        }),
      );
      expect(res.assigned_admin_id).toBe("admin-2");
    });
  });

  describe("updateTicket", () => {
    it("clears resolved_at when ticket is reopened to in_progress or open", async () => {
      prisma.support_tickets.findUnique.mockResolvedValue({
        id: "ticket-1",
        user_id: "user-1",
        status: "resolved",
        ticket_number: "TIC-001",
      });
      prisma.support_tickets.update.mockResolvedValue({
        id: "ticket-1",
        status: "in_progress",
        resolved_at: null,
      });

      await service.updateTicket("ticket-1", { status: "in_progress" });

      expect(prisma.support_tickets.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "in_progress", resolved_at: null }),
        }),
      );
    });

    it("notifies ticket raiser when ticket is resolved", async () => {
      prisma.support_tickets.findUnique.mockResolvedValue({
        id: "ticket-1",
        user_id: "user-1",
        status: "in_progress",
        ticket_number: "TIC-001",
      });
      prisma.support_tickets.update.mockResolvedValue({
        id: "ticket-1",
        status: "resolved",
      });

      await service.updateTicket("ticket-1", { status: "resolved" });

      expect(notificationsService.createNotification).toHaveBeenCalledWith(
        "user-1",
        "Support Ticket Resolved",
        expect.stringContaining("TIC-001"),
        "info",
        "support",
        "ticket-1",
      );
    });
  });

  describe("addMessage", () => {
    it("rejects replies to closed tickets", async () => {
      prisma.support_tickets.findUnique.mockResolvedValue({
        id: "ticket-1",
        user_id: "user-1",
        status: "closed",
      });

      await expect(
        service.addMessage("ticket-1", "user-1", false, "More info"),
      ).rejects.toThrow(BadRequestException);
    });

    it("reopens resolved ticket when user replies and clears resolved_at", async () => {
      prisma.support_tickets.findUnique.mockResolvedValue({
        id: "ticket-1",
        user_id: "user-1",
        status: "resolved",
        assigned_admin_id: "admin-1",
        ticket_number: "TIC-001",
      });
      prisma.support_ticket_messages.create.mockResolvedValue({
        id: "msg-1",
        content: "Still having issue",
      });

      await service.addMessage("ticket-1", "user-1", false, "Still having issue");

      expect(prisma.support_tickets.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "ticket-1" },
          data: expect.objectContaining({
            status: "in_progress",
            resolved_at: null,
          }),
        }),
      );
      expect(notificationsService.createNotification).toHaveBeenCalledWith(
        "admin-1",
        "New reply on Support Ticket",
        expect.stringContaining("TIC-001"),
        "info",
        "support",
        "ticket-1",
      );
    });
  });

  describe("submitCsat", () => {
    it("rejects duplicate CSAT submission if already rated", async () => {
      prisma.support_tickets.findUnique.mockResolvedValue({
        id: "ticket-1",
        user_id: "user-1",
        status: "resolved",
        csat_rating: 5,
      });

      await expect(
        service.submitCsat("ticket-1", "user-1", 4, "Good"),
      ).rejects.toThrow(BadRequestException);
    });

    it("records CSAT with atomic updateMany claim on resolved ticket", async () => {
      prisma.support_tickets.findUnique
        .mockResolvedValueOnce({
          id: "ticket-1",
          user_id: "user-1",
          status: "resolved",
          csat_rating: null,
        })
        .mockResolvedValueOnce({
          id: "ticket-1",
          csat_rating: 5,
        });
      prisma.support_tickets.updateMany.mockResolvedValue({ count: 1 });

      const res = await service.submitCsat("ticket-1", "user-1", 5, "Great help");

      expect(prisma.support_tickets.updateMany).toHaveBeenCalledWith({
        where: {
          id: "ticket-1",
          user_id: "user-1",
          status: { in: ["resolved", "closed"] },
          csat_rating: null,
        },
        data: expect.objectContaining({ csat_rating: 5, csat_comment: "Great help" }),
      });
      expect(res.csat_rating).toBe(5);
    });
  });
});
