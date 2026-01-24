import { PartialType } from "@nestjs/mapped-types";
import { CreateReviewDto } from "./create-review.dto";
import { OmitType } from "@nestjs/mapped-types";

export class UpdateReviewDto extends PartialType(
  OmitType(CreateReviewDto, ["bookingId"] as const),
) {}
