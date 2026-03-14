import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from "class-validator";
import { Type } from "class-transformer";

export class PaymentAuditQueryDto {
  @IsOptional()
  @IsString()
  orderId?: string;

  @IsOptional()
  @IsUUID("4", { message: "bookingId must be a valid UUID" })
  bookingId?: string;

  @IsOptional()
  @IsString()
  razorpayPaymentId?: string;

  @IsOptional()
  @IsIn(["created", "captured", "failed"])
  toStatus?: "created" | "captured" | "failed";

  @IsOptional()
  @IsString()
  triggeredBy?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}
