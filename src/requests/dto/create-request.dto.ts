import {
  IsNotEmpty,
  IsDateString,
  IsNumber,
  IsInt,
  IsOptional,
  IsString,
  IsArray,
  Min,
  Max,
} from "class-validator";
import { Type } from "class-transformer";

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

  @IsOptional()
  @IsString()
  special_requirements?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  max_hourly_rate?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  required_skills?: string[];

  @IsOptional()
  @IsString()
  category?: string;
}
