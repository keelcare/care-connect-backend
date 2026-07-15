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
import { UserRole } from "../auth/dto/signup.dto";
import { Roles } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { PaymentsService } from "./payments.service";
import { CreateOrderDto, VerifyPaymentDto } from "./dto/create-payment.dto";
import { PaymentAuditQueryDto } from "./dto/payment-audit-query.dto";
import { ParentTransactionsQueryDto } from "./dto/parent-transactions-query.dto";

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
  async retryOrder(@Req() req: any, @Param("bookingId") bookingId: string) {
    return this.paymentsService.retryOrder(bookingId, req.user.id);
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
  @Roles(UserRole.ADMIN)
  @UseGuards(AuthGuard("jwt"), RolesGuard)
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
  @Roles(UserRole.ADMIN)
  @UseGuards(AuthGuard("jwt"), RolesGuard)
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
  @Roles(UserRole.ADMIN)
  @UseGuards(AuthGuard("jwt"), RolesGuard)
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
  async getPaymentPlans(@Req() req: any) {
    return this.paymentsService.getPaymentPlans(req.user.id);
  }

  @Get("transactions")
  @Roles(UserRole.PARENT)
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @ApiOperation({
    summary:
      "Get every payment the authenticated parent made, including charges not tied to a billing cycle",
  })
  @ApiResponse({
    status: 200,
    description: "Transaction history fetched successfully",
  })
  async getParentTransactions(
    @Req() req: any,
    @Query() query: ParentTransactionsQueryDto,
  ) {
    return this.paymentsService.getParentTransactions(
      req.user.id,
      query.page,
      query.pageSize,
    );
  }

  @Post("refund/:paymentId")
  @Roles(UserRole.ADMIN)
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @ApiOperation({ summary: "Refund a captured payment (Admin only)" })
  @ApiResponse({ status: 200, description: "Payment refunded successfully" })
  async refundPayment(
    @Param("paymentId") paymentId: string,
    @Body("amount") amount?: number,
  ) {
    return this.paymentsService.refundPayment(paymentId, amount);
  }

  @Get("nanny/earnings")
  @Roles(UserRole.NANNY)
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @ApiOperation({ summary: "Get aggregated earnings and pending amounts for the authenticated nanny" })
  @ApiResponse({ status: 200, description: "Nanny earnings fetched successfully" })
  async getNannyEarnings(@Req() req: any) {
    return this.paymentsService.getNannyEarnings(req.user.id);
  }

  @Get("nanny/earnings/analytics")
  @Roles(UserRole.NANNY)
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @ApiOperation({ summary: "Get earnings analytics with trend data for the nanny dashboard" })
  @ApiResponse({ status: 200, description: "Earnings analytics returned" })
  async getNannyEarningsAnalytics(@Req() req: any, @Query("period") period: "week" | "month" = "week") {
    return this.paymentsService.getNannyEarningsAnalytics(req.user.id, period);
  }
}
