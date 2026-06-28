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
  @IsString()
  @MaxLength(100)
  @Sanitize()
  first_name: string;

  @IsString()
  @MaxLength(100)
  @Sanitize()
  last_name: string;

  @IsDateString()
  dob: string;

  @IsEnum(Gender)
  gender: Gender;

  @IsOptional()
  @IsEnum(ChildProfileType)
  profile_type?: ChildProfileType;

  // ── Health & dietary ──────────────────────────────────────────────

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  allergies?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(20)
  allergy_severity?: "mild" | "moderate" | "severe";

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  dietary_restrictions?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Sanitize()
  medical_notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  report_url?: string;

  // ── Personality & routine ─────────────────────────────────────────

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Sanitize()
  personality_notes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  hobbies?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(20)
  bedtime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  nap_schedule?: string;

  // ── Special needs ─────────────────────────────────────────────────

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Sanitize()
  diagnosis?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Sanitize()
  care_instructions?: string;

  // ── Emergency contact ─────────────────────────────────────────────

  @IsOptional()
  @ValidateNested()
  @Type(() => EmergencyContactDto)
  emergency_contact?: EmergencyContactDto;

  // Support legacy alias from frontend
  @IsOptional()
  @ValidateNested()
  @Type(() => EmergencyContactDto)
  emergency_contact_override?: EmergencyContactDto;

  // ── Shadow teacher ────────────────────────────────────────────────

  @IsOptional()
  @ValidateNested()
  @Type(() => SchoolDetailsDto)
  school_details?: SchoolDetailsDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  learning_goals?: string[];
}
