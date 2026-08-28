import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
} from "class-validator";

/**
 * The closed set of purposes we process personal data for. DPDPA s.5 requires the
 * notice to state the purpose specifically, so purposes are an enum rather than a
 * free-text string — a typo'd purpose would otherwise silently create a consent
 * record that maps to no stated notice at all.
 */
export enum ConsentPurpose {
  /** Account creation + core service delivery (bookings, payments, support). */
  TERMS_OF_SERVICE = "terms_of_service",
  /** The Privacy Notice itself, versioned so we can re-prompt when it changes. */
  PRIVACY_POLICY = "privacy_policy",
  /**
   * s.9 verifiable parental consent to process a child's personal data,
   * including the health data (allergies, diagnosis, care instructions) that a
   * caregiver needs. Always recorded with subject_id = children.id.
   */
  CHILD_DATA = "child_data",
  /** Sharing a child's care details with the caregiver assigned to a booking. */
  CHILD_DATA_CAREGIVER_SHARING = "child_data_caregiver_sharing",
  /** Precise location while a shift is active (caregiver app). */
  LOCATION_TRACKING = "location_tracking",
  /** Optional, withdrawable: promotional email/push/WhatsApp. */
  MARKETING = "marketing",
}

/** Purposes the service cannot run without — withdrawal means closing the account. */
export const ESSENTIAL_PURPOSES: ConsentPurpose[] = [
  ConsentPurpose.TERMS_OF_SERVICE,
  ConsentPurpose.PRIVACY_POLICY,
];

export class CreateConsentDto {
  @IsEnum(ConsentPurpose, {
    message: `purpose must be one of: ${Object.values(ConsentPurpose).join(", ")}`,
  })
  purpose: ConsentPurpose;

  /** Version of the notice that was displayed, e.g. "2026-08-01" or "1.2". */
  @IsString()
  @MaxLength(20)
  @Matches(/^[\w.\-]+$/, {
    message: "version may only contain letters, numbers, dots and hyphens",
  })
  version: string;

  /** For CHILD_DATA consents: which child this consent is about. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  subject_type?: string;

  @IsOptional()
  @IsUUID()
  subject_id?: string;
}

export class WithdrawConsentDto {
  @IsEnum(ConsentPurpose)
  purpose: ConsentPurpose;

  @IsOptional()
  @IsUUID()
  subject_id?: string;
}
