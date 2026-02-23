import {
  Controller,
  Post,
  Body,
  Headers,
  Req,
  Res,
  BadRequestException,
} from "@nestjs/common";
import { Response } from "express";
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PaymentsService } from "./payments.service";
import { CreateOrderDto, VerifyPaymentDto } from "./dto/create-payment.dto";

@ApiTags('Payments')
@Controller("payments")
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) { }

  @Post("create-order")
  @ApiOperation({ summary: 'Create a new Razorpay order for a booking' })
  @ApiResponse({ status: 201, description: 'Order created successfully' })
  async createOrder(@Body() createOrderDto: CreateOrderDto) {
    return this.paymentsService.createOrder(createOrderDto.bookingId);
  }

  @Post("verify")
  @ApiOperation({ summary: 'Verify a Razorpay payment signature' })
  @ApiResponse({ status: 200, description: 'Payment verified successfully' })
  @ApiResponse({ status: 400, description: 'Invalid signature or payment data' })
  async verifyPayment(@Body() verifyDto: VerifyPaymentDto) {
    return this.paymentsService.verifyPayment(
      verifyDto.razorpay_order_id,
      verifyDto.razorpay_payment_id,
      verifyDto.razorpay_signature,
    );
  }

  @Post("callback")
  @ApiOperation({ summary: 'Razorpay callback redirect handler for mobile app' })
  async paymentCallback(@Body() body: any, @Res() res: Response) {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature, error } = body;
      
      if (error || !razorpay_signature) {
         return res.redirect(`careconnect://payment/callback?status=failed`);
      }

      await this.paymentsService.verifyPayment(
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature
      );

      const payment = await this.paymentsService.getPaymentByOrderId(razorpay_order_id);
      const bookingId = payment?.booking_id || '';

      return res.redirect(`careconnect://payment/callback?status=success&bookingId=${bookingId}`);
    } catch (err) {
      return res.redirect(`careconnect://payment/callback?status=failed`);
    }
  }

  @Post("webhook")
  @ApiOperation({ summary: 'Razorpay webhook handler for external payment events' })
  @ApiResponse({ status: 200, description: 'Webhook processed successfully' })
  async handleWebhook(
    @Headers("x-razorpay-signature") signature: string,
    @Body() payload: any,
  ) {
    if (!signature) throw new BadRequestException("Missing signature");
    return this.paymentsService.handleWebhook(signature, payload);
  }
}
