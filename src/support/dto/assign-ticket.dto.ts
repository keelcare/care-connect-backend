import { IsOptional, IsUUID } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class AssignTicketDto {
  @ApiProperty({
    example: "a3c41668-a3df-8dd9-3000-000000000000",
    required: false,
    description: "Admin to assign. Omit to claim for the current admin; pass null to release.",
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  adminId?: string | null;
}
