import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";
import { Type } from "class-transformer";
import { attendance_day_status } from "@prisma/client";

export class WaiveEventDto {
  /**
   * Required, and required to be substantive: a waiver removes a fact from a
   * caregiver's record, and "ok" six months later explains nothing to whoever
   * has to defend the decision.
   */
  @ApiProperty({ example: "Family cancelled at the door; caregiver had travelled." })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}

export class OverrideDayDto {
  @ApiProperty({ enum: ["PRESENT", "LATE", "PARTIAL", "ABSENT", "LEAVE", "OFF"] })
  @IsEnum({
    PRESENT: "PRESENT",
    LATE: "LATE",
    PARTIAL: "PARTIAL",
    ABSENT: "ABSENT",
    LEAVE: "LEAVE",
    OFF: "OFF",
  })
  status: attendance_day_status;

  @ApiProperty({ example: "Approved medical leave, documentation on file." })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}

export class PresenceDto {
  @ApiProperty({ description: "Whether the caregiver is available for new work right now." })
  @IsBoolean()
  online: boolean;
}

export class AttendanceEventsQueryDto {
  @ApiPropertyOptional({ default: 30, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: "ISO timestamp cursor — returns events strictly older than this." })
  @IsOptional()
  @IsString()
  before?: string;
}
