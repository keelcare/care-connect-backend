import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { Type } from "class-transformer";

/**
 * Where a caregiver wants to be paid.
 *
 * The account number is validated here but deliberately never stored — see
 * `PayoutsService.submitPayoutAccount`. Only the last four digits survive the
 * request.
 */
export class SubmitPayoutAccountDto {
  @IsIn(["bank_account", "vpa"], {
    message: "Choose a bank account or a UPI ID",
  })
  accountType: "bank_account" | "vpa";

  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(255)
  beneficiaryName: string;

  // ── Bank account ──
  @IsOptional()
  @IsString()
  @Matches(/^\d{6,20}$/, { message: "Enter a valid account number" })
  accountNumber?: string;

  /**
   * Re-typed by the caregiver. A transposed digit in an account number does not
   * bounce — it can land in a stranger's real account — so this is checked
   * server-side rather than left to the client.
   */
  @IsOptional()
  @IsString()
  confirmAccountNumber?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/, { message: "Enter a valid IFSC code" })
  ifsc?: string;

  // ── UPI ──
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z][a-zA-Z0-9.\-_]{1,30}$/, {
    message: "Enter a valid UPI ID",
  })
  vpaAddress?: string;
}

export class ApprovePayoutAccountDto {
  /**
   * Required for bank accounts: the number was never stored, so an admin re-keys it
   * from the caregiver's document to create the RazorpayX fund account. That
   * re-keying is also the second pair of eyes on the digits.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d{6,20}$/, { message: "Enter a valid account number" })
  accountNumber?: string;
}

export class RejectPayoutAccountDto {
  @IsString()
  @IsNotEmpty({ message: "A reason is required so the caregiver can fix it" })
  @Length(3, 500)
  reason: string;
}

export class ReleasePayoutDto {
  /**
   * Record a settlement made outside the platform (cash, a manual bank transfer)
   * without calling RazorpayX. The escape hatch for anything the gateway cannot do.
   */
  @IsOptional()
  manual?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class PayoutListQueryDto {
  @IsOptional()
  @IsUUID("4", { message: "nannyId must be a valid UUID" })
  nannyId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}
