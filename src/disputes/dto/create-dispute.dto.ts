import { IsString, IsNotEmpty, IsOptional, IsUUID } from 'class-validator';

export class CreateDisputeDto {
  @IsUUID()
  @IsNotEmpty()
  bookingId: string;

  @IsString()
  @IsNotEmpty()
  reason: string;

  @IsString()
  @IsOptional()
  description?: string;
}
