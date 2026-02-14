import {
    IsEmail,
    IsString,
    IsEnum,
    MinLength,
    MaxLength,
    Matches,
    IsOptional,
} from 'class-validator';
import { Sanitize } from '../../common/decorators/sanitize.decorator';

/**
 * SECURITY: Signup DTO with comprehensive validation
 * 
 * Implements OWASP best practices for user registration:
 * - Email validation
 * - Strong password requirements
 * - Input sanitization to prevent XSS
 * - Length limits to prevent buffer overflow attacks
 */

export enum UserRole {
    PARENT = 'parent',
    NANNY = 'nanny',
}

export class SignupDto {
    /**
     * Email address - must be valid email format
     * Max 255 characters to prevent database overflow
     */
    @IsEmail({}, { message: 'Please provide a valid email address' })
    @MaxLength(255, { message: 'Email must not exceed 255 characters' })
    email: string;

    /**
     * Password with strong complexity requirements
     * 
     * Requirements:
     * - Minimum 8 characters
     * - Maximum 128 characters
     * - At least one uppercase letter
     * - At least one lowercase letter
     * - At least one number
     * - At least one special character
     * 
     * OWASP Best Practice: Enforce strong password complexity
     */
    @IsString()
    @MinLength(8, { message: 'Password must be at least 8 characters long' })
    @MaxLength(128, { message: 'Password must not exceed 128 characters' })
    @Matches(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/,
        {
            message:
                'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character (@$!%*?&)',
        },
    )
    password: string;

    /**
     * User role - must be either 'parent' or 'nanny'
     */
    @IsEnum(UserRole, { message: 'Role must be either parent or nanny' })
    role: UserRole;

    /**
     * First name - sanitized to prevent XSS attacks
     */
    @IsString()
    @MinLength(1, { message: 'First name is required' })
    @MaxLength(100, { message: 'First name must not exceed 100 characters' })
    @Sanitize()
    firstName: string;

    /**
     * Last name - sanitized to prevent XSS attacks
     */
    @IsString()
    @MinLength(1, { message: 'Last name is required' })
    @MaxLength(100, { message: 'Last name must not exceed 100 characters' })
    @Sanitize()
    lastName: string;

    /**
     * Phone number (optional) - E.164 format validation
     * Format: +[country code][number] (e.g., +919876543210)
     */
    @IsOptional()
    @IsString()
    @Matches(/^\+?[1-9]\d{1,14}$/, {
        message: 'Phone number must be in valid international format (e.g., +919876543210)',
    })
    phone?: string;

    /**
     * Categories for nannies - At least one category is required if role is Nanny
     */
    @IsOptional()
    categories?: string[];
}
