import {
  IsString,
  IsNotEmpty,
  IsUUID,
  Matches,
  IsOptional,
} from "class-validator";

/**
 * SECURITY: Payment DTOs with validation
 */

export class CreateOrderDto {
  /**
   * SECURITY: UUID validation to prevent SQL injection
   */
  @IsString()
  @IsNotEmpty()
  @IsUUID("4", { message: "Booking ID must be a valid UUID" })
  bookingId: string;

  @IsString()
  @IsUUID("4", { message: "Installment ID must be a valid UUID" })
  @IsOptional()
  installmentId?: string;
}

export class VerifyPaymentDto {
  /**
   * SECURITY: Validate Razorpay ID format to prevent injection
   * Razorpay IDs are alphanumeric with underscores and hyphens
   */
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: "Invalid order ID format" })
  razorpay_order_id: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: "Invalid payment ID format" })
  razorpay_payment_id: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-fA-F0-9]+$/, { message: "Invalid signature format" })
  razorpay_signature: string;
}
