import { IsString, IsOptional, IsEnum, IsUUID } from "class-validator";
import { WhatsAppEnquiryStatus } from "@prisma/client";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class AgentReplyDto {
  @ApiProperty({ description: "Message text to send via WhatsApp" })
  @IsString()
  message: string;
}

export class UpdateEnquiryDto {
  @ApiPropertyOptional({ enum: WhatsAppEnquiryStatus })
  @IsOptional()
  @IsEnum(WhatsAppEnquiryStatus)
  status?: WhatsAppEnquiryStatus;

  @ApiPropertyOptional({
    description: "UUID of the support agent to assign. Pass null to unassign.",
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  assigned_to?: string | null;

  @ApiPropertyOptional({ description: "Internal agent notes" })
  @IsOptional()
  @IsString()
  notes?: string;
}
