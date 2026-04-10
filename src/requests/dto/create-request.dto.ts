import {
  IsNotEmpty,
  IsDateString,
  IsNumber,
  IsInt,
  IsOptional,
  IsString,
  IsBoolean,
  IsArray,
  IsEnum,
  IsUUID,
  Min,
  Max,
  MaxLength,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Sanitize } from "../../common/decorators/sanitize.decorator";

/**
 * SECURITY: Service request DTO with comprehensive validation
 *
 * Validates all user inputs to prevent injection attacks and data corruption
 */

/**
 * Service categories - must match database enum
 */
export enum ServiceCategory {
  CC = "CC",
  EC = "EC",
  SN = "SN",
  ST = "ST",
}

export enum SubscriptionPlanType {
  ONE_TIME = "ONE_TIME",
  MONTHLY = "MONTHLY",
  SIX_MONTH = "SIX_MONTH",
  YEARLY = "YEARLY",
}

export class CreateRequestDto {
  @ApiProperty({
    example: "2026-06-20",
    description: "Date of service (YYYY-MM-DD)",
  })
  @IsNotEmpty()
  @IsDateString()
  date: string; // Format: YYYY-MM-DD

  @ApiProperty({
    example: "14:30:00",
    description: "Start time of service (HH:MM:SS)",
  })
  @IsNotEmpty()
  @IsString()
  start_time: string; // Format: HH:MM:SS

  @ApiProperty({ example: 4, description: "Duration of service in hours" })
  @IsNotEmpty()
  @IsNumber()
  @Min(0.5)
  @Max(24)
  duration_hours: number;

  @ApiProperty({
    example: 2,
    description: "Number of children to be cared for",
  })
  @IsNotEmpty()
  @IsInt()
  @Min(1)
  @Max(10)
  num_children: number;

  @ApiPropertyOptional({ example: [3, 5], description: "Ages of the children" })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  children_ages?: number[];

  /**
   * SECURITY: Sanitize special requirements to prevent XSS
   * Max 1000 characters to prevent abuse
   */
  @ApiPropertyOptional({
    example: "Allergies to nuts",
    description: "Any special requirements or notes",
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000, {
    message: "Special requirements must not exceed 1000 characters",
  })
  @Sanitize()
  special_requirements?: string;

  /**
   * SECURITY: Limit skill string length to prevent abuse
   */
  @ApiPropertyOptional({
    example: ["CPR", "First Aid"],
    description: "Specific skills required",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, {
    each: true,
    message: "Each skill must not exceed 50 characters",
  })
  required_skills?: string[];

  /**
   * SECURITY: Enum validation to prevent invalid categories
   */
  @ApiProperty({
    enum: ServiceCategory,
    example: ServiceCategory.ST,
    description: "Service category",
  })
  @IsNotEmpty()
  @IsEnum(ServiceCategory, {
    message: "Category must be one of: CC, EC, SN, ST",
  })
  category: ServiceCategory;

  /**
   * SECURITY: UUID validation to prevent SQL injection via child IDs
   */
  @ApiPropertyOptional({
    example: ["550e8400-e29b-41d4-a716-446655440000"],
    description: "UUIDs of the children",
  })
  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true, message: "Each child ID must be a valid UUID" })
  child_ids?: string[];

  @ApiPropertyOptional({
    enum: SubscriptionPlanType,
    example: SubscriptionPlanType.ONE_TIME,
  })
  @IsOptional()
  @IsEnum(SubscriptionPlanType)
  plan_type?: SubscriptionPlanType;

  @ApiPropertyOptional({ example: 15 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  discount_percentage?: number;

  @ApiPropertyOptional({
    example: 6,
    description: "Duration in months for subscriptions",
  })
  @IsOptional()
  @IsNumber()
  plan_duration_months?: number;

  @ApiPropertyOptional({
    example: true,
    description: "Whether the parent opted to pay in monthly installments",
  })
  @IsOptional()
  @IsBoolean()
  use_installments?: boolean;
}
