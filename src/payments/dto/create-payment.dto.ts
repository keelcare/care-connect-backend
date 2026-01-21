import { IsString, IsDecimal, IsOptional, IsNotEmpty } from 'class-validator';

export class CreateOrderDto {
  @IsString()
  @IsNotEmpty()
  bookingId: string;
}

export class VerifyPaymentDto {
  @IsString()
  @IsNotEmpty()
  razorpay_order_id: string;

  @IsString()
  @IsNotEmpty()
  razorpay_payment_id: string;

  @IsString()
  @IsNotEmpty()
  razorpay_signature: string;
}
