import { IsString, IsOptional, IsEmail, IsEnum } from "class-validator";
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

  @ApiPropertyOptional({ description: "UUID of the support agent to assign" })
  @IsOptional()
  @IsString()
  assigned_to?: string;

  @ApiPropertyOptional({ description: "Internal agent notes" })
  @IsOptional()
  @IsString()
  notes?: string;
}
