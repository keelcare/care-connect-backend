import {
  IsNotEmpty,
  IsUUID,
  IsInt,
  Min,
  Max,
  IsString,
  MaxLength,
  IsOptional,
} from "class-validator";
import { Sanitize } from "../../common/decorators/sanitize.decorator";

/**
 * SECURITY: Review DTO with validation and sanitization
 */
export class CreateReviewDto {
  @IsNotEmpty()
  @IsUUID()
  bookingId: string;

  @IsNotEmpty()
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  /**
   * SECURITY: Sanitize comment to prevent XSS attacks
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Sanitize()
  comment?: string;
}
