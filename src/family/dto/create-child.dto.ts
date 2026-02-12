import {
  IsString,
  IsOptional,
  IsArray,
  IsEnum,
  IsDateString,
  IsObject,
} from "class-validator";

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
  @IsString()
  first_name: string;

  @IsString()
  last_name: string;

  @IsDateString()
  dob: string;

  @IsEnum(Gender)
  gender: Gender;

  @IsOptional()
  @IsEnum(ChildProfileType)
  profile_type?: ChildProfileType;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allergies?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dietary_restrictions?: string[];

  @IsOptional()
  @IsString()
  diagnosis?: string;

  @IsOptional()
  @IsString()
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
  learning_goals?: string[];
}
