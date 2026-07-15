import { PartialType } from "@nestjs/mapped-types";
import { IsBoolean, IsOptional } from "class-validator";
import { CreateRecurringBookingDto } from "./create-recurring-booking.dto";

export class UpdateRecurringBookingDto extends PartialType(
  CreateRecurringBookingDto,
) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
