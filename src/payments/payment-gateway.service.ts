import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Razorpay from "razorpay";
import * as crypto from "node:crypto";

@Injectable()
export class PaymentGatewayService {
  private razorpay: Razorpay;
  private readonly logger = new Logger(PaymentGatewayService.name);

  constructor(private configService: ConfigService) {
    const keyId = this.configService.get<string>("RAZORPAY_KEY_ID");
    const keySecret = this.configService.get<string>("RAZORPAY_KEY_SECRET");

    if (keyId && keySecret) {
      this.razorpay = new Razorpay({
        key_id: keyId,
        key_secret: keySecret,
      });
    } else {
      this.logger.warn(
        "RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET not set. Razorpay integration will not be available.",
      );
    }
  }

  async createOrder(amountPaise: number, receipt: string, notes: any) {
    if (!this.razorpay) {
      throw new BadRequestException("Payment gateway is not configured");
    }
    try {
      return await this.razorpay.orders.create({
        amount: amountPaise,
        currency: "INR",
        receipt,
        notes,
      });
    } catch (error) {
      this.logger.error("Razorpay order creation failed", error);
      const gatewayError = error as { error?: { description?: string } };
      throw new BadRequestException(
        gatewayError.error?.description || "Payment gateway error",
      );
    }
  }

  /**
   * Look up an order we previously created. Returns null when the order is
   * unknown to the current key — which is what happens to orders created under
   * a rotated or test/live-swapped key. Those must never be handed back to
   * checkout: it rejects them as an unexplained "Payment Failed" and the parent
   * has no way out.
   */
  async fetchOrder(orderId: string): Promise<{
    id: string;
    status: string;
    amount: number;
    currency: string;
  } | null> {
    if (!this.razorpay) {
      throw new BadRequestException("Payment gateway is not configured");
    }
    try {
      const order: any = await this.razorpay.orders.fetch(orderId);
      return {
        id: order.id,
        status: order.status,
        amount: Number(order.amount),
        currency: order.currency,
      };
    } catch (error) {
      this.logger.warn(
        `Could not fetch Razorpay order ${orderId}; treating as unusable`,
        error,
      );
      return null;
    }
  }

  verifySignature(
    orderId: string,
    paymentId: string,
    signature: string,
  ): boolean {
    const secret = this.configService.get<string>("RAZORPAY_KEY_SECRET");
    if (!secret) return false;

    const generatedSignature = crypto
      .createHmac("sha256", secret)
      .update(orderId + "|" + paymentId)
      .digest("hex");

    return generatedSignature === signature;
  }

  verifyWebhookSignature(payload: any, signature: string): boolean {
    const secret = this.configService.get<string>("RAZORPAY_WEBHOOK_SECRET");
    if (!secret) return false;

    const shasum = crypto.createHmac("sha256", secret);
    shasum.update(JSON.stringify(payload));
    const digest = shasum.digest("hex");

    return digest === signature;
  }

  async refund(paymentId: string, amountPaise?: number) {
    if (!this.razorpay) {
      throw new BadRequestException("Payment gateway is not configured");
    }
    try {
      const data: any = { payment_id: paymentId };
      if (amountPaise !== undefined) {
        data.amount = amountPaise;
      }
      return await (this.razorpay as any).refunds.create(data);
    } catch (error) {
      this.logger.error("Razorpay refund failed", error);
      const gatewayError = error as { error?: { description?: string } };
      throw new BadRequestException(
        gatewayError.error?.description || "Refund processing failed",
      );
    }
  }
}
