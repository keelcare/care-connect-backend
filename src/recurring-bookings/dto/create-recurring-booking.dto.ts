import {
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from "class-validator";

export class CreateRecurringBookingDto {
  @IsNotEmpty()
  @IsUUID()
  nannyId: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  recurrencePattern: string;

  @IsNotEmpty()
  @IsDateString()
  startDate: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(10)
  startTime: string;

  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  durationHours: number;

  @IsNotEmpty()
  @IsInt()
  @Min(1)
  numChildren: number;

  @IsOptional()
  @IsArray()
  childrenAges?: number[];

  @IsOptional()
  @IsString()
  specialRequirements?: string;
}
