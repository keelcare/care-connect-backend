import { IsUUID, IsNotEmpty, IsOptional } from "class-validator";

export class AdminManualAssignmentDto {
  @IsUUID()
  @IsOptional()
  requestId?: string;

  @IsUUID()
  @IsOptional()
  bookingId?: string;

  @IsUUID()
  @IsNotEmpty()
  nannyId: string;
}
