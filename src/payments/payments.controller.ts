import {
  Controller,
  Post,
  Body,
  Headers,
  Req,
  BadRequestException,
} from "@nestjs/common";
import { PaymentsService } from "./payments.service";
import { CreateOrderDto, VerifyPaymentDto } from "./dto/create-payment.dto";

@Controller("payments")
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post("create-order")
  async createOrder(@Body() createOrderDto: CreateOrderDto) {
    return this.paymentsService.createOrder(createOrderDto.bookingId);
  }

  @Post("verify")
  async verifyPayment(@Body() verifyDto: VerifyPaymentDto) {
    return this.paymentsService.verifyPayment(
      verifyDto.razorpay_order_id,
      verifyDto.razorpay_payment_id,
      verifyDto.razorpay_signature,
    );
  }

  @Post("webhook")
  async handleWebhook(
    @Headers("x-razorpay-signature") signature: string,
    @Body() payload: any,
  ) {
    if (!signature) throw new BadRequestException("Missing signature");
    return this.paymentsService.handleWebhook(signature, payload);
  }
}
