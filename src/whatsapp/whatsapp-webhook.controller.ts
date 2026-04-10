import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "crypto";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { WhatsAppBotService } from "./whatsapp-bot.service";

@ApiTags("WhatsApp Webhook")
@Controller("webhooks/whatsapp")
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);
  private readonly verifyToken: string;
  private readonly appSecret: string;

  constructor(
    private readonly botService: WhatsAppBotService,
    private readonly config: ConfigService,
  ) {
    this.verifyToken = this.config.get<string>("WHATSAPP_VERIFY_TOKEN") ?? "";
    this.appSecret = this.config.get<string>("WHATSAPP_APP_SECRET") ?? "";
  }

  /**
   * Meta webhook verification challenge
   * GET /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
   */
  @Get()
  @ApiOperation({ summary: "Meta webhook verification endpoint" })
  verifyWebhook(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") token: string,
    @Query("hub.challenge") challenge: string,
  ): string {
    if (mode === "subscribe" && token === this.verifyToken) {
      this.logger.log("WhatsApp webhook verified successfully.");
      return challenge;
    }
    this.logger.warn("WhatsApp webhook verification failed.");
    throw new ForbiddenException("Verification failed");
  }

  /**
   * Receive incoming WhatsApp messages
   * POST /webhooks/whatsapp
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Receive incoming WhatsApp messages" })
  async handleWebhook(
    @Headers("x-hub-signature-256") signature: string | undefined,
    @Body() payload: any,
  ): Promise<{ status: string }> {
    // Validate HMAC signature
    if (this.appSecret) {
      this.validateSignature(signature, payload);
    }

    const entry = payload?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) {
      // Status update or other event — just ack
      return { status: "ok" };
    }

    const message = messages[0];
    const phoneNumber: string = message?.from;
    const messageText: string = message?.text?.body ?? "";
    const messageId: string = message?.id ?? "";

    if (!phoneNumber || !messageText) {
      return { status: "ok" };
    }

    this.logger.log(`Inbound message from ${phoneNumber}: "${messageText}"`);

    // Process asynchronously — don't await to return 200 immediately
    this.botService
      .handleIncomingMessage(phoneNumber, messageText, messageId, payload)
      .catch((err) =>
        this.logger.error(`Bot processing error: ${err.message}`, err.stack),
      );

    return { status: "ok" };
  }

  private validateSignature(signature: string | undefined, payload: any): void {
    if (!signature) {
      throw new BadRequestException("Missing X-Hub-Signature-256");
    }
    const body = JSON.stringify(payload);
    const expected = `sha256=${createHmac("sha256", this.appSecret)
      .update(body)
      .digest("hex")}`;

    const sigBuffer = Buffer.from(signature);
    const expBuffer = Buffer.from(expected);
    if (
      sigBuffer.length !== expBuffer.length ||
      !timingSafeEqual(sigBuffer, expBuffer)
    ) {
      throw new ForbiddenException("Invalid webhook signature");
    }
  }
}
