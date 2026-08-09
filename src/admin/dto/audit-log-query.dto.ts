import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";

export class AuditLogQueryDto {
  @ApiPropertyOptional({ description: "Page number (1-based)", default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: "Items per page (max 100)", default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @ApiPropertyOptional({ description: "Filter by the admin who performed the action" })
  @IsOptional()
  @IsUUID()
  adminId?: string;

  @ApiPropertyOptional({ description: "Filter by action name, e.g. 'commission_updated'" })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({ description: "Filter by the type of entity acted on" })
  @IsOptional()
  @IsString()
  targetType?: string;

  @ApiPropertyOptional({ description: "Filter by the id of the entity acted on" })
  @IsOptional()
  @IsUUID()
  targetId?: string;
}
