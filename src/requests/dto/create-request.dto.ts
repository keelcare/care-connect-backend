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
  Min,
  Max,
  MaxLength,
} from "class-validator";
import { Type } from "class-transformer";
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
  CC = 'CC',
  EC = 'EC',
  SN = 'SN',
  ST = 'ST',
}

export class CreateRequestDto {
  @IsNotEmpty()
  @IsDateString()
  date: string; // Format: YYYY-MM-DD

  @IsNotEmpty()
  @IsString()
  start_time: string; // Format: HH:MM:SS

  @IsNotEmpty()
  @IsNumber()
  @Min(0.5)
  @Max(24)
  duration_hours: number;

  @IsNotEmpty()
  @IsInt()
  @Min(1)
  @Max(10)
  num_children: number;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  children_ages?: number[];

  /**
   * SECURITY: Sanitize special requirements to prevent XSS
   * Max 1000 characters to prevent abuse
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: 'Special requirements must not exceed 1000 characters' })
  @Sanitize()
  special_requirements?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  max_hourly_rate?: number;

  /**
   * SECURITY: Limit skill string length to prevent abuse
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true, message: 'Each skill must not exceed 50 characters' })
  required_skills?: string[];

  /**
   * SECURITY: Enum validation to prevent invalid categories
   */
  @IsNotEmpty()
  @IsNotEmpty()
  @IsEnum(ServiceCategory, { message: 'Category must be one of: CC, EC, SN, ST' })
  category: ServiceCategory;

  /**
   * SECURITY: UUID validation to prevent SQL injection via child IDs
   */
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true, message: 'Each child ID must be a valid UUID' })
  child_ids?: string[];
}
