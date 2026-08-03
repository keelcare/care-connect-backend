import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from "class-validator";
import { Type } from "class-transformer";

export class RevenueQueryDto {
  /** Defaults to 30 days back from `to`. */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** Defaults to now. */
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

export class UpdateCommissionDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  percent: number;
}

export class UpdateMatchingFeeDto {
  /** Explicit — a fee is never switched on as a side effect of setting an amount. */
  @IsBoolean()
  enabled: boolean;

  /** Rupees, tax-inclusive. Ignored while `enabled` is false. */
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount: number;
}
