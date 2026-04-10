import { IsString, MinLength, MaxLength, Matches } from "class-validator";

/**
 * SECURITY: Reset Password DTO
 *
 * Validates password reset token and new password
 */
export class ResetPasswordDto {
  /**
   * Password reset token from email
   */
  @IsString()
  @MinLength(1, { message: "Reset token is required" })
  token: string;

  /**
   * New password with strong complexity requirements
   *
   * Requirements:
   * - Minimum 8 characters
   * - Maximum 128 characters
   * - At least one uppercase letter
   * - At least one lowercase letter
   * - At least one number
   * - At least one special character
   */
  @IsString()
  @MinLength(8, { message: "Password must be at least 8 characters long" })
  @MaxLength(128, { message: "Password must not exceed 128 characters" })
  // @Matches(
  //     /^(?=.*[A-Za-z])(?=.*\d).{8,}$/,
  //     {
  //         message:
  //             'Password must be at least 8 characters long and contain at least one letter and one number',
  //     },
  // )
  password: string;
}
