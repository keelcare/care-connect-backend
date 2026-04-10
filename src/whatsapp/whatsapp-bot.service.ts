import { Injectable, Logger } from "@nestjs/common";
import {
  WhatsAppConversationStep,
  WhatsAppMessageDirection,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsAppMessagingService } from "./whatsapp-messaging.service";

export const ENQUIRY_CATEGORIES = [
  "Booking Help",
  "Payment Issue",
  "Finding a Caregiver",
  "Account Support",
  "Other",
];

const CATEGORY_MENU =
  "What can we help you with? Reply with a number:\n1. Booking Help\n2. Payment Issue\n3. Finding a Caregiver\n4. Account Support\n5. Other";

@Injectable()
export class WhatsAppBotService {
  private readonly logger = new Logger(WhatsAppBotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: WhatsAppMessagingService,
  ) {}

  async handleIncomingMessage(
    phoneNumber: string,
    messageText: string,
    messageId: string,
    rawPayload: any,
  ): Promise<void> {
    // Deduplicate — skip if we've already processed this message_id
    const exists = await this.prisma.whatsapp_messages.findUnique({
      where: { message_id: messageId },
    });
    if (exists) {
      this.logger.warn(
        `Duplicate webhook event for message_id ${messageId}, skipping.`,
      );
      return;
    }

    // Log inbound message
    await this.prisma.whatsapp_messages.create({
      data: {
        phone_number: phoneNumber,
        direction: WhatsAppMessageDirection.INBOUND,
        message_body: messageText,
        message_id: messageId,
        raw_payload: rawPayload,
      },
    });

    // Get or create conversation
    let conversation = await this.prisma.whatsapp_conversations.findUnique({
      where: { phone_number: phoneNumber },
    });

    if (!conversation || conversation.status === "COMPLETED") {
      conversation = await this.prisma.whatsapp_conversations.upsert({
        where: { phone_number: phoneNumber },
        update: {
          current_step: WhatsAppConversationStep.WELCOME,
          status: "ACTIVE",
          name: null,
        },
        create: {
          phone_number: phoneNumber,
          current_step: WhatsAppConversationStep.WELCOME,
          status: "ACTIVE",
        },
      });
    }

    await this.processStep(conversation, phoneNumber, messageText.trim());
  }

  private async processStep(
    conversation: any,
    phoneNumber: string,
    text: string,
  ): Promise<void> {
    const step = conversation.current_step as WhatsAppConversationStep;

    switch (step) {
      case WhatsAppConversationStep.WELCOME:
        await this.advance(
          phoneNumber,
          WhatsAppConversationStep.COLLECT_NAME,
          {},
          {
            name: null,
          },
        );
        await this.sendAndLog(
          phoneNumber,
          `Hi there! 👋 Welcome to *CareConnect*.\n\nI'm here to help you get in touch with our support team.\n\nCould you please tell me your *full name*?`,
        );
        break;

      case WhatsAppConversationStep.COLLECT_NAME:
        if (text.length < 2) {
          await this.sendAndLog(phoneNumber, `Please enter a valid name.`);
          return;
        }
        await this.advance(
          phoneNumber,
          WhatsAppConversationStep.COLLECT_PHONE,
          { name: text },
        );
        await this.sendAndLog(
          phoneNumber,
          `Thanks, *${text}*! 😊\n\nWhat's the best *phone number* for us to reach you on? (with country code, e.g. +91 9876543210)`,
        );
        break;

      case WhatsAppConversationStep.COLLECT_PHONE:
        // Basic phone validation
        const phoneRegex = /^\+?[\d\s\-]{7,15}$/;
        if (!phoneRegex.test(text)) {
          await this.sendAndLog(
            phoneNumber,
            `That doesn't look like a valid phone number. Please try again, e.g. +91 9876543210`,
          );
          return;
        }
        await this.advance(
          phoneNumber,
          WhatsAppConversationStep.COLLECT_EMAIL,
          {
            // Store phone number in raw_payload via conversation metadata later
          },
        );
        // Use name from conversation
        await this.sendAndLog(
          phoneNumber,
          `Got it! 📞\n\nWhat's your *email address*? _(Type *skip* if you'd prefer not to share)_`,
        );
        // Temporarily store the provided phone in a private context field
        await this.prisma.whatsapp_conversations.update({
          where: { phone_number: phoneNumber },
          data: { name: `${conversation.name ?? ""}|PHONE:${text}` },
        });
        break;

      case WhatsAppConversationStep.COLLECT_EMAIL:
        const emailValue = text.toLowerCase() === "skip" ? null : text;
        if (emailValue && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue)) {
          await this.sendAndLog(
            phoneNumber,
            `That doesn't look like a valid email. Please try again or type *skip*.`,
          );
          return;
        }
        await this.prisma.whatsapp_conversations.update({
          where: { phone_number: phoneNumber },
          data: {
            current_step: WhatsAppConversationStep.COLLECT_CATEGORY,
            name: `${conversation.name ?? ""}|EMAIL:${emailValue ?? "skip"}`,
          },
        });
        await this.sendAndLog(phoneNumber, CATEGORY_MENU);
        break;

      case WhatsAppConversationStep.COLLECT_CATEGORY:
        const categoryIndex = parseInt(text, 10) - 1;
        if (
          isNaN(categoryIndex) ||
          categoryIndex < 0 ||
          categoryIndex >= ENQUIRY_CATEGORIES.length
        ) {
          await this.sendAndLog(
            phoneNumber,
            `Please reply with a number from 1 to ${ENQUIRY_CATEGORIES.length}.\n\n${CATEGORY_MENU}`,
          );
          return;
        }
        const category = ENQUIRY_CATEGORIES[categoryIndex];
        await this.prisma.whatsapp_conversations.update({
          where: { phone_number: phoneNumber },
          data: {
            current_step: WhatsAppConversationStep.COLLECT_ENQUIRY,
            name: `${conversation.name ?? ""}|CATEGORY:${category}`,
          },
        });
        await this.sendAndLog(
          phoneNumber,
          `Got it — *${category}*.\n\nPlease describe your query in a few words and we'll have someone look into it. 📝`,
        );
        break;

      case WhatsAppConversationStep.COLLECT_ENQUIRY:
        if (text.length < 3) {
          await this.sendAndLog(
            phoneNumber,
            `Please provide a brief description of your query.`,
          );
          return;
        }
        await this.finalizeEnquiry(phoneNumber, conversation, text);
        break;

      default:
        // Completed conversation — offer to restart
        await this.sendAndLog(
          phoneNumber,
          `Your enquiry has already been submitted! Our team will reach out shortly. If you have a new query, just say *Hi* to start again.`,
        );
    }
  }

  private async finalizeEnquiry(
    phoneNumber: string,
    conversation: any,
    enquiryMessage: string,
  ): Promise<void> {
    // Parse stored context from name field (temporary encoding)
    const context = conversation.name ?? "";
    const parts: Record<string, string> = {};
    context.split("|").forEach((part: string) => {
      const [key, ...val] = part.split(":");
      if (key && val.length) parts[key] = val.join(":");
    });

    const name = parts[""] ?? parts["NAME"] ?? "Unknown";
    const email = parts["EMAIL"] === "skip" ? null : (parts["EMAIL"] ?? null);
    const category = parts["CATEGORY"] ?? "Other";
    const collectedPhone = parts["PHONE"] ?? phoneNumber;

    await this.prisma.whatsapp_enquiries.create({
      data: {
        name,
        phone_number: collectedPhone,
        email,
        category,
        message: enquiryMessage,
      },
    });

    await this.prisma.whatsapp_conversations.update({
      where: { phone_number: phoneNumber },
      data: {
        current_step: WhatsAppConversationStep.COMPLETED,
        status: "COMPLETED",
      },
    });

    const thankYouMsg = `Thank you, *${name}*! 🙏\n\nWe've received your enquiry about *${category}*.\n\nOur support team will get back to you shortly.\n\nIn the meantime, you can also reach us at: support@careconnect.com`;
    await this.sendAndLog(phoneNumber, thankYouMsg);

    this.logger.log(
      `Enquiry created for phone ${phoneNumber} (category: ${category})`,
    );
  }

  private async advance(
    phoneNumber: string,
    nextStep: WhatsAppConversationStep,
    data: Record<string, any> = {},
    extra: Record<string, any> = {},
  ): Promise<void> {
    await this.prisma.whatsapp_conversations.update({
      where: { phone_number: phoneNumber },
      data: { current_step: nextStep, ...data, ...extra },
    });
  }

  private async sendAndLog(phoneNumber: string, text: string): Promise<void> {
    await this.messaging.sendTextMessage(phoneNumber, text);
    await this.prisma.whatsapp_messages.create({
      data: {
        phone_number: phoneNumber,
        direction: WhatsAppMessageDirection.OUTBOUND,
        message_body: text,
      },
    });
  }
}
