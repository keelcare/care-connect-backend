import {
  IsString,
  IsOptional,
  IsArray,
  IsEnum,
  IsDateString,
  MaxLength,
  ValidateNested,
  ArrayMaxSize,
} from "class-validator";
import { Type } from "class-transformer";
import { Sanitize } from "../../common/decorators/sanitize.decorator";

/**
 * SECURITY: Child profile DTO with sanitization and validation
 */

export enum ChildProfileType {
  STANDARD = "STANDARD",
  SPECIAL_NEEDS = "SPECIAL_NEEDS",
}

export enum Gender {
  MALE = "MALE",
  FEMALE = "FEMALE",
  OTHER = "OTHER",
}

export class EmergencyContactDto {
  @IsString()
  @MaxLength(100)
  @Sanitize()
  name: string;

  @IsString()
  @MaxLength(20)
  phone: string;

  @IsString()
  @MaxLength(50)
  @Sanitize()
  relation: string;
}

export class SchoolDetailsDto {
  @IsString()
  @MaxLength(200)
  @Sanitize()
  name: string;

  @IsString()
  @MaxLength(20)
  grade: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Sanitize()
  teacher_contact?: string;
}

export class CreateChildDto {
  /**
   * SECURITY: Sanitize names to prevent XSS
   */
  @IsString()
  @MaxLength(100, { message: "First name must not exceed 100 characters" })
  @Sanitize()
  first_name: string;

  @IsString()
  @MaxLength(100, { message: "Last name must not exceed 100 characters" })
  @Sanitize()
  last_name: string;

  @IsDateString()
  dob: string;

  @IsEnum(Gender)
  gender: Gender;

  @IsOptional()
  @IsEnum(ChildProfileType)
  profile_type?: ChildProfileType;

  /**
   * SECURITY: Limit array item lengths to prevent abuse
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20, { message: "Maximum 20 allergies allowed" })
  @IsString({ each: true })
  @MaxLength(50, {
    each: true,
    message: "Each allergy must not exceed 50 characters",
  })
  allergies?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20, { message: "Maximum 20 dietary restrictions allowed" })
  @IsString({ each: true })
  @MaxLength(50, {
    each: true,
    message: "Each dietary restriction must not exceed 50 characters",
  })
  dietary_restrictions?: string[];

  /**
   * SECURITY: Sanitize medical and care information
   */
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: "Diagnosis must not exceed 500 characters" })
  @Sanitize()
  diagnosis?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000, {
    message: "Care instructions must not exceed 2000 characters",
  })
  @Sanitize()
  care_instructions?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => EmergencyContactDto)
  emergency_contact?: EmergencyContactDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SchoolDetailsDto)
  school_details?: SchoolDetailsDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20, { message: "Maximum 20 learning goals allowed" })
  @IsString({ each: true })
  @MaxLength(50, {
    each: true,
    message: "Each learning goal must not exceed 50 characters",
  })
  learning_goals?: string[];
}
