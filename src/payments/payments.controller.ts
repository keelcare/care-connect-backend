import {
  Controller,
  Post,
  Body,
  Headers,
  Req,
  BadRequestException,
} from "@nestjs/common";
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
