import {
  IsString,
  IsOptional,
  IsNumber,
  IsArray,
  IsObject,
} from "class-validator";
import { Sanitize } from "../../common/decorators/sanitize.decorator";

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Sanitize()
  firstName?: string;

  @IsOptional()
  @IsString()
  @Sanitize()
  lastName?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  @Sanitize()
  address?: string;

  // Human-readable label for the matching location (lat/lng). Kept separate
  // from `address`, which is the user's typed residential address.
  @IsOptional()
  @IsString()
  @Sanitize()
  locationAddress?: string;

  @IsOptional()
  @IsNumber()
  lat?: number;

  @IsOptional()
  @IsNumber()
  lng?: number;

  @IsOptional()
  @IsString()
  profileImageUrl?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  skills?: string[];

  @IsOptional()
  @IsNumber()
  experienceYears?: number;

  @IsOptional()
  @IsString()
  @Sanitize()
  bio?: string;

  @IsOptional()
  @IsObject()
  availabilitySchedule?: any;
}
