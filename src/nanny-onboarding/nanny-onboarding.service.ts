import { Injectable, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../common/services/encryption.service";
import { UpsertNannyOnboardingDto } from "./dto/upsert-nanny-onboarding.dto";

const REQUIRED_FOR_COMPLETION: (keyof UpsertNannyOnboardingDto)[] = [
  "age",
  "gender",
  "city",
  "educationQualification",
  "streamSubjects",
  "shadowTeacherExperience",
];

@Injectable()
export class NannyOnboardingService {
  constructor(
    private prisma: PrismaService,
    private encryptionService: EncryptionService,
  ) {}

  private decorate(record: any) {
    if (!record) return record;
    return {
      ...record,
      previous_salary: record.previous_salary
        ? this.encryptionService.decrypt(record.previous_salary)
        : record.previous_salary,
    };
  }

  async getMine(userId: string) {
    const record = await this.prisma.nanny_onboarding_details.findUnique({
      where: { user_id: userId },
    });
    return this.decorate(record);
  }

  async upsertMine(userId: string, dto: UpsertNannyOnboardingDto) {
    const data = this.toDbData(dto);

    const record = await this.prisma.nanny_onboarding_details.upsert({
      where: { user_id: userId },
      update: { ...data, updated_at: new Date() },
      create: { user_id: userId, ...data },
    });

    return this.decorate(record);
  }

  async completeMine(userId: string) {
    const record = await this.prisma.nanny_onboarding_details.findUnique({
      where: { user_id: userId },
    });

    if (!record) {
      throw new BadRequestException(
        "Complete the onboarding form before submitting",
      );
    }

    const missing = REQUIRED_FOR_COMPLETION.filter((field) => {
      const dbField = this.camelToDbField(field);
      return record[dbField] === null || record[dbField] === undefined;
    });

    if (missing.length > 0) {
      throw new BadRequestException(
        `Missing required fields: ${missing.join(", ")}`,
      );
    }

    if (
      !record.training_agreement ||
      !record.placement_fee_agreement ||
      !record.police_verification_consent ||
      !record.declaration_confirmed
    ) {
      throw new BadRequestException(
        "All consents and the declaration must be confirmed before submitting",
      );
    }

    const documentTypes = await this.prisma.identity_documents.findMany({
      where: { user_id: userId, type: { in: ["AADHAR", "PAN", "RESUME"] } },
      select: { type: true },
    });
    const uploadedTypes = new Set(documentTypes.map((d) => d.type));
    const missingDocs = ["AADHAR", "PAN", "RESUME"].filter(
      (t) => !uploadedTypes.has(t),
    );
    if (missingDocs.length > 0) {
      throw new BadRequestException(
        `Missing required documents: ${missingDocs.join(", ")}`,
      );
    }

    await this.prisma.nanny_onboarding_details.update({
      where: { user_id: userId },
      data: { onboarding_completed_at: new Date() },
    });

    const updated = await this.prisma.profiles.upsert({
      where: { user_id: userId },
      update: { onboarding_completed: true, updated_at: new Date() },
      create: { user_id: userId, onboarding_completed: true },
    });

    return { onboardingCompleted: updated.onboarding_completed };
  }

  private camelToDbField(field: string) {
    return field.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  }

  private toDbData(dto: UpsertNannyOnboardingDto) {
    const data: Record<string, any> = {};

    if (dto.age !== undefined) data.age = dto.age;
    if (dto.gender !== undefined) data.gender = dto.gender;
    if (dto.permanentAddress !== undefined)
      data.permanent_address = dto.permanentAddress;
    if (dto.city !== undefined) data.city = dto.city;
    if (dto.educationQualification !== undefined)
      data.education_qualification = dto.educationQualification;
    if (dto.educationQualificationOther !== undefined)
      data.education_qualification_other = dto.educationQualificationOther;
    if (dto.streamSubjects !== undefined)
      data.stream_subjects = dto.streamSubjects;
    if (dto.shadowTeacherExperience !== undefined)
      data.shadow_teacher_experience = dto.shadowTeacherExperience;
    if (dto.ageGroupsWorked !== undefined)
      data.age_groups_worked = dto.ageGroupsWorked;
    if (dto.childrenTypesSupported !== undefined)
      data.children_types_supported = dto.childrenTypesSupported;
    if (dto.childrenTypesOther !== undefined)
      data.children_types_other = dto.childrenTypesOther;
    if (dto.academicSubjects !== undefined)
      data.academic_subjects = dto.academicSubjects;
    if (dto.hobbiesInterests !== undefined)
      data.hobbies_interests = dto.hobbiesInterests;
    if (dto.hobbiesActivitiesForChild !== undefined)
      data.hobbies_activities_for_child = dto.hobbiesActivitiesForChild;
    if (dto.previousSalary !== undefined)
      data.previous_salary = dto.previousSalary
        ? this.encryptionService.encrypt(dto.previousSalary)
        : dto.previousSalary;
    if (dto.availableStartDate !== undefined)
      data.available_start_date = new Date(dto.availableStartDate);
    if (dto.trainingAgreement !== undefined)
      data.training_agreement = dto.trainingAgreement;
    if (dto.placementFeeAgreement !== undefined)
      data.placement_fee_agreement = dto.placementFeeAgreement;
    if (dto.policeVerificationConsent !== undefined)
      data.police_verification_consent = dto.policeVerificationConsent;
    if (dto.declarationConfirmed !== undefined) {
      data.declaration_confirmed = dto.declarationConfirmed;
      data.declaration_confirmed_at = dto.declarationConfirmed
        ? new Date()
        : null;
    }

    return data;
  }
}
