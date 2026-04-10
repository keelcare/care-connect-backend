import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  Headers,
  Res,
  BadRequestException,
  UseGuards,
  Req,
} from "@nestjs/common";
import { Request, Response } from "express";
import { AuthGuard } from "@nestjs/passport";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { AdminGuard } from "../admin/admin.guard";
import { PaymentsService } from "./payments.service";
import { CreateOrderDto, VerifyPaymentDto } from "./dto/create-payment.dto";
import { PaymentAuditQueryDto } from "./dto/payment-audit-query.dto";

@ApiTags("Payments")
@Controller("payments")
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post("create-order")
  @UseGuards(AuthGuard("jwt"))
  @ApiOperation({ summary: "Create a new Razorpay order for a booking" })
  @ApiResponse({ status: 201, description: "Order created successfully" })
  async createOrder(@Req() req: any, @Body() createOrderDto: CreateOrderDto) {
    return this.paymentsService.createOrder(
      createOrderDto.bookingId,
      createOrderDto.installmentId,
      req.user.id,
    );
  }

  @Post("retry-order/:bookingId")
  @UseGuards(AuthGuard("jwt"))
  @ApiOperation({ summary: "Retry a failed Razorpay order for a booking" })
  @ApiResponse({
    status: 201,
    description: "New order created successfully for retry",
  })
  async retryOrder(@Param("bookingId") bookingId: string) {
    return this.paymentsService.retryOrder(bookingId);
  }

  @Post("verify")
  @ApiOperation({ summary: "Verify a Razorpay payment signature" })
  @ApiResponse({ status: 200, description: "Payment verified successfully" })
  @ApiResponse({
    status: 400,
    description: "Invalid signature or payment data",
  })
  async verifyPayment(@Body() verifyDto: VerifyPaymentDto) {
    return this.paymentsService.verifyPayment(
      verifyDto.razorpay_order_id,
      verifyDto.razorpay_payment_id,
      verifyDto.razorpay_signature,
    );
  }

  @Post("callback")
  @ApiOperation({
    summary: "Razorpay callback redirect handler for mobile app",
  })
  async paymentCallback(@Body() body: any, @Res() res: Response) {
    try {
      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        error,
      } = body;

      if (error || !razorpay_signature) {
        return res.redirect(`keel://payment/callback?status=failed`);
      }

      await this.paymentsService.verifyPayment(
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
      );

      const payment =
        await this.paymentsService.getPaymentByOrderId(razorpay_order_id);
      const bookingId = payment?.booking_id || "";

      return res.redirect(
        `keel://payment/callback?status=success&bookingId=${bookingId}`,
      );
    } catch (err) {
      return res.redirect(`keel://payment/callback?status=failed`);
    }
  }

  @Post("webhook")
  @ApiOperation({
    summary: "Razorpay webhook handler for external payment events",
  })
  @ApiResponse({ status: 200, description: "Webhook processed successfully" })
  async handleWebhook(
    @Headers("x-razorpay-signature") signature: string,
    @Body() payload: any,
  ) {
    if (!signature) throw new BadRequestException("Missing signature");
    return this.paymentsService.handleWebhook(signature, payload);
  }

  @Get("audit")
  @UseGuards(AuthGuard("jwt"), AdminGuard)
  @ApiOperation({
    summary:
      "Get paginated payment audit logs with filters for admin dashboard",
  })
  @ApiResponse({
    status: 200,
    description: "Filtered payment audit history fetched successfully",
  })
  async listPaymentAudit(@Query() query: PaymentAuditQueryDto) {
    return this.paymentsService.getAuditLogs(query);
  }

  @Get("audit/summary")
  @UseGuards(AuthGuard("jwt"), AdminGuard)
  @ApiOperation({
    summary: "Get payment audit summary metrics for admin dashboard cards",
  })
  @ApiResponse({
    status: 200,
    description: "Payment audit summary fetched successfully",
  })
  async getPaymentAuditSummary() {
    return this.paymentsService.getAuditSummary();
  }

  @Get("audit/:orderId")
  @UseGuards(AuthGuard("jwt"), AdminGuard)
  @ApiOperation({ summary: "Get full audit history for a payment order" })
  @ApiResponse({
    status: 200,
    description: "Payment audit history fetched successfully",
  })
  async getPaymentAudit(@Param("orderId") orderId: string) {
    return this.paymentsService.getAuditLog(orderId);
  }

  @Get("plans")
  @UseGuards(AuthGuard("jwt"))
  @ApiOperation({
    summary: "Get all subscription plans for the authenticated user",
  })
  @ApiResponse({
    status: 200,
    description: "Subscription plans fetched successfully",
  })
  async getSubscriptionPlans(@Req() req: any) {
    return this.paymentsService.getSubscriptionPlans(req.user.id);
  }
}
