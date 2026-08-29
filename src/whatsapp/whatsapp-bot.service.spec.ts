import { Test, TestingModule } from "@nestjs/testing";
import { WhatsAppBotService } from "./whatsapp-bot.service";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsAppMessagingService } from "./whatsapp-messaging.service";
import { WhatsAppConversationStep } from "@prisma/client";

describe("WhatsAppBotService", () => {
  let service: WhatsAppBotService;
  let prisma: any;
  let messaging: any;

  beforeEach(async () => {
    prisma = {
      whatsapp_messages: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      whatsapp_conversations: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
      },
      whatsapp_enquiries: {
        create: jest.fn(),
      },
    };

    messaging = {
      sendTextMessage: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsAppBotService,
        { provide: PrismaService, useValue: prisma },
        { provide: WhatsAppMessagingService, useValue: messaging },
      ],
    }).compile();

    service = module.get<WhatsAppBotService>(WhatsAppBotService);
  });

  describe("finalizeEnquiry", () => {
    it("correctly extracts customer name from conversation state context", async () => {
      prisma.whatsapp_messages.findUnique.mockResolvedValue(null);
      prisma.whatsapp_conversations.findUnique.mockResolvedValue({
        phone_number: "+919876543210",
        name: "NAME:John Doe|PHONE:+919876543210|EMAIL:john@example.com|CATEGORY:Booking Help",
        current_step: WhatsAppConversationStep.COLLECT_ENQUIRY,
        status: "ACTIVE",
      });

      await service.handleIncomingMessage(
        "+919876543210",
        "Need help with booking #123",
        "msg-unique-1",
        {},
      );

      expect(prisma.whatsapp_enquiries.create).toHaveBeenCalledWith({
        data: {
          name: "John Doe",
          phone_number: "+919876543210",
          email: "john@example.com",
          category: "Booking Help",
          message: "Need help with booking #123",
        },
      });
    });

    it("handles legacy/raw name encoding without NAME prefix", async () => {
      prisma.whatsapp_messages.findUnique.mockResolvedValue(null);
      prisma.whatsapp_conversations.findUnique.mockResolvedValue({
        phone_number: "+919876543210",
        name: "Alice Smith|PHONE:+919876543210|EMAIL:skip|CATEGORY:Payment Issue",
        current_step: WhatsAppConversationStep.COLLECT_ENQUIRY,
        status: "ACTIVE",
      });

      await service.handleIncomingMessage(
        "+919876543210",
        "Payment got stuck",
        "msg-unique-2",
        {},
      );

      expect(prisma.whatsapp_enquiries.create).toHaveBeenCalledWith({
        data: {
          name: "Alice Smith",
          phone_number: "+919876543210",
          email: null,
          category: "Payment Issue",
          message: "Payment got stuck",
        },
      });
    });
  });

  describe("handleIncomingMessage deduplication", () => {
    it("ignores duplicate message_id on initial check", async () => {
      prisma.whatsapp_messages.findUnique.mockResolvedValue({ id: "msg-existing" });

      await service.handleIncomingMessage(
        "+919876543210",
        "Hello",
        "msg-existing",
        {},
      );

      expect(prisma.whatsapp_messages.create).not.toHaveBeenCalled();
      expect(messaging.sendTextMessage).not.toHaveBeenCalled();
    });

    it("gracefully catches P2002 duplicate key collisions on create", async () => {
      prisma.whatsapp_messages.findUnique.mockResolvedValue(null);
      const p2002Err: any = new Error("Unique constraint violation");
      p2002Err.code = "P2002";
      prisma.whatsapp_messages.create.mockRejectedValue(p2002Err);

      await expect(
        service.handleIncomingMessage(
          "+919876543210",
          "Hello",
          "msg-concurrent-duplicate",
          {},
        ),
      ).resolves.not.toThrow();
    });
  });
});
