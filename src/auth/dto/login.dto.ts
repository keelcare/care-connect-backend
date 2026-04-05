import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * SECURITY: Login DTO with validation
 * 
 * Validates login credentials without exposing implementation details
 */
export class LoginDto {
    /**
     * Email address - must be valid email format
     */
    @ApiProperty({
        example: 'user@example.com',
        description: 'The email of the user',
    })
    @IsEmail({}, { message: 'Please provide a valid email address' })
    @MaxLength(255, { message: 'Email must not exceed 255 characters' })
    email: string;

    /**
     * Password - basic validation only (don't expose complexity requirements on login)
     * 
     * OWASP Best Practice: Don't reveal password requirements on login
     * to prevent information disclosure
     */
    @ApiProperty({
        example: 'P@ssword123',
        description: 'The password of the user',
    })
    @IsString()
    @MinLength(1, { message: 'Password is required' })
    @MaxLength(128, { message: 'Password must not exceed 128 characters' })
    password: string;
}
