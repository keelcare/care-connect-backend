import { IsUUID, IsNotEmpty } from "class-validator";

export class AdminManualAssignmentDto {
  @IsUUID()
  @IsNotEmpty()
  requestId: string;

  @IsUUID()
  @IsNotEmpty()
  nannyId: string;
}
