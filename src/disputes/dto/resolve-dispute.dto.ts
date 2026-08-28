import { IsString, IsNotEmpty, IsEnum, IsOptional, IsPositive } from "class-validator";

/**
 * What actually happens to the money when a dispute is closed.
 *
 * This used to be inferred by substring-matching the free-text resolution note
 * ("refund"/"parent" => refund, "release"/"nanny" => release). That silently
 * misrouted real money: a note reading "No refund — release the funds to the
 * nanny" contains "refund" and matched the refund branch first. The outcome is
 * now stated explicitly and the note is only ever a note.
 */
export enum DisputeOutcome {
  /** Refund the parent (full, or `amount` if given). */
  REFUND = "refund",
  /** Let the captured payment proceed to the caregiver's payout. */
  RELEASE = "release",
  /** Close with no financial change. */
  NO_ACTION = "no_action",
}

export class ResolveDisputeDto {
  @IsString()
  @IsNotEmpty()
  resolution: string;

  @IsEnum(DisputeOutcome, {
    message: `outcome must be one of: ${Object.values(DisputeOutcome).join(", ")}`,
  })
  outcome: DisputeOutcome;

  /** Optional partial refund amount, in rupees. Full refund when omitted. */
  @IsOptional()
  @IsPositive()
  amount?: number;
}
