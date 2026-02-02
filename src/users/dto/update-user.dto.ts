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
  @IsNumber()
  hourlyRate?: number;

  @IsOptional()
  @IsString()
  @Sanitize()
  bio?: string;

  @IsOptional()
  @IsObject()
  availabilitySchedule?: any;
}
