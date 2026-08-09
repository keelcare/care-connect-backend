import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional } from "class-validator";
import { PaginationDto } from "./pagination.dto";

/**
 * Adds a moderation filter to the admin review list so ops can pull the
 * pending-moderation queue. `moderation_status` distinguishes "pending" from
 * "rejected", which the `is_approved` boolean alone cannot.
 */
export class ReviewQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description: "Filter by moderation state",
    enum: ["pending", "approved", "rejected"],
  })
  @IsOptional()
  @IsIn(["pending", "approved", "rejected"])
  moderationStatus?: "pending" | "approved" | "rejected";
}
