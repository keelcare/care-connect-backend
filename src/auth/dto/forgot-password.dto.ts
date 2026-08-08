import { IsEmail, MaxLength } from "class-validator";
import { Transform } from "class-transformer";

/**
 * SECURITY: Forgot Password DTO
 *
 * Validates email for password reset requests
 */
export class ForgotPasswordDto {
  /**
   * Email address for password reset
   */
  // Trimmed but NOT lowercased for matching: historical accounts were stored with
  // whatever case they were typed in, and `UsersService.resolveEmailWhere` already
  // resolves those case-insensitively. Lowercasing here would be harmless for new
  // accounts and is applied on signup, but doing it on lookup adds nothing.
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsEmail({}, { message: "Please provide a valid email address" })
  @MaxLength(255, { message: "Email must not exceed 255 characters" })
  email: string;
}
