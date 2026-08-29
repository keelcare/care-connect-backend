import { Test, TestingModule } from "@nestjs/testing";
import { AdminWhatsAppController } from "./admin-whatsapp.controller";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsAppMessagingService } from "./whatsapp-messaging.service";
import { BadRequestException, NotFoundException } from "@nestjs/common";

describe("AdminWhatsAppController", () => {
  let controller: AdminWhatsAppController;
  let prisma: any;
  let messaging: any;

  beforeEach(async () => {
    prisma = {
      whatsapp_enquiries: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
      users: {
        findFirst: jest.fn(),
      },
      whatsapp_messages: {
        findMany: jest.fn(),
        create: jest.fn(),
      },
    };

    messaging = {
      sendTextMessage: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminWhatsAppController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: WhatsAppMessagingService, useValue: messaging },
      ],
    }).compile();

    controller = module.get<AdminWhatsAppController>(AdminWhatsAppController);
  });

  describe("updateEnquiry", () => {
    it("throws BadRequestException when assigning to a non-admin or inactive user", async () => {
      prisma.whatsapp_enquiries.findUnique.mockResolvedValue({ id: "enq-1" });
      prisma.users.findFirst.mockResolvedValue(null);

      await expect(
        controller.updateEnquiry("enq-1", { assigned_to: "user-non-admin" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("updates enquiry successfully when assigned to a valid admin", async () => {
      prisma.whatsapp_enquiries.findUnique.mockResolvedValue({ id: "enq-1" });
      prisma.users.findFirst.mockResolvedValue({ id: "admin-1" });
      prisma.whatsapp_enquiries.update.mockResolvedValue({
        id: "enq-1",
        assigned_to: "admin-1",
      });

      const res = await controller.updateEnquiry("enq-1", {
        assigned_to: "admin-1",
      });
      expect(prisma.whatsapp_enquiries.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "enq-1" },
          data: expect.objectContaining({ assigned_to: "admin-1" }),
        }),
      );
      expect(res.assigned_to).toBe("admin-1");
    });
  });
});
