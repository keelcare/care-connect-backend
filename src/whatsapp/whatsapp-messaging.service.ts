import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";

@Injectable()
export class WhatsAppMessagingService {
  private readonly logger = new Logger(WhatsAppMessagingService.name);
  private readonly apiUrl: string;
  private readonly accessToken: string;

  constructor(private readonly config: ConfigService) {
    const phoneNumberId = this.config.get<string>("WHATSAPP_PHONE_NUMBER_ID");
    const apiVersion = this.config.get<string>("WHATSAPP_API_VERSION", "v19.0");
    this.apiUrl = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
    this.accessToken = this.config.get<string>("WHATSAPP_ACCESS_TOKEN") ?? "";
  }

  async sendTextMessage(to: string, text: string): Promise<void> {
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
