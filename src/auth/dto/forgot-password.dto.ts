import { IsEmail, MaxLength } from "class-validator";

/**
 * SECURITY: Forgot Password DTO
 *
 * Validates email for password reset requests
 */
export class ForgotPasswordDto {
  /**
   * Email address for password reset
   */
  @IsEmail({}, { message: "Please provide a valid email address" })
  @MaxLength(255, { message: "Email must not exceed 255 characters" })
  email: string;
}
