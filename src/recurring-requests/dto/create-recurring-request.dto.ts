import {
  IsNotEmpty,
  IsDateString,
  IsNumber,
  IsInt,
  IsOptional,
  IsString,
  IsArray,
  IsEnum,
  IsUUID,
  IsObject,
  Min,
  Max,
  MaxLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Sanitize } from "../../common/decorators/sanitize.decorator";
import { ServiceCategory, SubscriptionPlanType } from "../../requests/dto/create-request.dto";

export enum RecurrenceType {
  WEEKLY = "weekly",
  SPECIFIC_DATES = "specific_dates",
}

export class CreateRecurringRequestDto {
  @ApiProperty({
    enum: RecurrenceType,
    example: RecurrenceType.WEEKLY,
    description: "Type of recurrence pattern",
  })
  @IsNotEmpty()
  @IsEnum(RecurrenceType)
  recurrence_type: RecurrenceType;

  @ApiProperty({
    example: { days: ["Mon", "Wed", "Fri"] },
    description: "JSON defining the recurrence pattern",
  })
  @IsNotEmpty()
  @IsObject()
  recurrence_pattern: Record<string, any>;

  @ApiProperty({
    example: "2026-07-01",
    description: "Start date of the recurring plan (YYYY-MM-DD)",
  })
  @IsNotEmpty()
  @IsDateString()
  start_date: string; // Format: YYYY-MM-DD

  @ApiPropertyOptional({
    example: "2026-12-31",
    description: "End date of the recurring plan (YYYY-MM-DD)",
  })
  @IsOptional()
  @IsDateString()
  end_date?: string;

  @ApiProperty({
    example: "07:30:00",
    description: "Start time of service (HH:MM:SS)",
  })
  @IsNotEmpty()
  @IsString()
  start_time: string; // Format: HH:MM:SS

  @ApiProperty({ example: 8, description: "Duration of service in hours" })
  @IsNotEmpty()
  @IsNumber()
  @Min(0.5)
  @Max(24)
  duration_hours: number;

  @ApiProperty({
    example: 1,
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

  @ApiPropertyOptional({
    example: "Allergies to nuts",
    description: "Any special requirements or notes",
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Sanitize()
  special_requirements?: string;

  @ApiPropertyOptional({
    example: ["CPR", "First Aid"],
    description: "Specific skills required",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  required_skills?: string[];

  @ApiProperty({
    enum: ServiceCategory,
    example: ServiceCategory.CC,
    description: "Service category",
  })
  @IsNotEmpty()
  @IsEnum(ServiceCategory)
  category: ServiceCategory;

  @ApiPropertyOptional({
    example: ["550e8400-e29b-41d4-a716-446655440000"],
    description: "UUIDs of the children",
  })
  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  child_ids?: string[];

  @ApiPropertyOptional({
    example: 6,
    description: "Duration in months for subscriptions",
  })
  @IsOptional()
  @IsNumber()
  plan_duration_months?: number;

  @ApiPropertyOptional({
    enum: SubscriptionPlanType,
    example: SubscriptionPlanType.MONTHLY,
  })
  @IsOptional()
  @IsEnum(SubscriptionPlanType)
  plan_type?: SubscriptionPlanType;

  @ApiPropertyOptional({
    example: 12,
    description: "Number of sessions per month",
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(31)
  sessions_per_month?: number;

  @ApiPropertyOptional({
    example: 50.0,
    description: "Maximum hourly rate parent is willing to pay",
  })
  @IsOptional()
  @IsNumber()
  max_hourly_rate?: number;
}
