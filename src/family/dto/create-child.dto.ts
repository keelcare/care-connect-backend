import {
  IsString,
  IsOptional,
  IsArray,
  IsEnum,
  IsDateString,
  IsObject,
  MaxLength,
} from "class-validator";
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

export class CreateChildDto {
  /**
   * SECURITY: Sanitize names to prevent XSS
   */
  @IsString()
  @MaxLength(100, { message: 'First name must not exceed 100 characters' })
  @Sanitize()
  first_name: string;

  @IsString()
  @MaxLength(100, { message: 'Last name must not exceed 100 characters' })
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
  @IsString({ each: true })
  @MaxLength(50, { each: true, message: 'Each allergy must not exceed 50 characters' })
  allergies?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true, message: 'Each dietary restriction must not exceed 50 characters' })
  dietary_restrictions?: string[];

  /**
   * SECURITY: Sanitize medical and care information
   */
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Diagnosis must not exceed 500 characters' })
  @Sanitize()
  diagnosis?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: 'Care instructions must not exceed 2000 characters' })
  @Sanitize()
  care_instructions?: string;

  @IsOptional()
  @IsObject()
  emergency_contact?: { name: string; phone: string; relation: string };

  @IsOptional()
  @IsObject()
  school_details?: {
    name: string;
    grade: string;
    teacher_contact?: string;
  };

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true, message: 'Each learning goal must not exceed 50 characters' })
  learning_goals?: string[];
}
