import { IsUUID, IsNotEmpty, IsOptional, IsBoolean } from "class-validator";

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

  @IsBoolean()
  @IsOptional()
  force?: boolean;
}
