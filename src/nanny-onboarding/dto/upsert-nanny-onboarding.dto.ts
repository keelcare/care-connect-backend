import {
  IsString,
  IsOptional,
  IsInt,
  IsArray,
  IsBoolean,
  IsDateString,
  Min,
  Max,
} from "class-validator";
import { Sanitize } from "../../common/decorators/sanitize.decorator";

export class UpsertNannyOnboardingDto {
  @IsOptional()
  @IsInt()
  @Min(16)
  @Max(80)
  age?: number;

  @IsOptional()
  @IsString()
  gender?: string;

  @IsOptional()
  @IsString()
  @Sanitize()
  permanentAddress?: string;

  @IsOptional()
  @IsString()
  @Sanitize()
  city?: string;

  @IsOptional()
  @IsString()
  educationQualification?: string;

  @IsOptional()
  @IsString()
  @Sanitize()
  educationQualificationOther?: string;

  @IsOptional()
  @IsString()
  @Sanitize()
  streamSubjects?: string;

  @IsOptional()
  @IsString()
  shadowTeacherExperience?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ageGroupsWorked?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  childrenTypesSupported?: string[];

  @IsOptional()
  @IsString()
  @Sanitize()
  childrenTypesOther?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  academicSubjects?: string[];

  @IsOptional()
  @IsString()
  @Sanitize()
  hobbiesInterests?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  hobbiesActivitiesForChild?: string[];

  @IsOptional()
  @IsString()
  previousSalary?: string;

  @IsOptional()
  @IsDateString()
  availableStartDate?: string;

  @IsOptional()
  @IsBoolean()
  trainingAgreement?: boolean;

  @IsOptional()
  @IsBoolean()
  placementFeeAgreement?: boolean;

  @IsOptional()
  @IsBoolean()
  policeVerificationConsent?: boolean;

  @IsOptional()
  @IsBoolean()
  declarationConfirmed?: boolean;
}
