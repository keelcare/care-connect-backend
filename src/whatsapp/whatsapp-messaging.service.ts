import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";

@Injectable()
export class WhatsAppMessagingService {
  private readonly logger = new Logger(WhatsAppMessagingService.name);
  private readonly apiUrl: string;
  private readonly accessToken: string;
  private readonly configured: boolean;

  constructor(private readonly config: ConfigService) {
    const phoneNumberId = this.config.get<string>("WHATSAPP_PHONE_NUMBER_ID");
    const apiVersion = this.config.get<string>("WHATSAPP_API_VERSION", "v19.0");
    this.apiUrl = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
    this.accessToken = this.config.get<string>("WHATSAPP_ACCESS_TOKEN") ?? "";
    this.configured = Boolean(phoneNumberId && this.accessToken);

    if (!this.configured) {
      this.logger.warn(
        "WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN not set. Outbound WhatsApp messages will be skipped.",
      );
    }
  }

  async sendTextMessage(to: string, text: string): Promise<void> {
    // Without credentials the URL would contain "undefined" and the bearer token
    // would be empty — skip rather than issue a guaranteed-failing request.
    if (!this.configured) {
      this.logger.debug(`[WhatsApp Skipped] To: ${to}, Message: ${text}`);
      return;
    }

    try {
      await axios.post(
        this.apiUrl,
        {
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: text },
        },
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
          },
        },
      );
      this.logger.log(`Outbound message sent to ${to}`);
    } catch (err: any) {
      this.logger.error(
        `Failed to send WhatsApp message to ${to}: ${err?.response?.data ? JSON.stringify(err.response.data) : err.message}`,
      );
      throw err;
    }
  }
}
