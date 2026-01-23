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

export class CreateReviewDto {
  @IsNotEmpty()
  @IsUUID()
  bookingId: string;

  @IsNotEmpty()
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}
