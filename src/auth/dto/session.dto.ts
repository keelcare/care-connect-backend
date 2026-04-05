import { IsString, MinLength } from 'class-validator';

/**
 * SECURITY: Session Exchange DTO
 * 
 * Validates session token for OAuth flows
 */
export class SessionDto {
    /**
     * Short-lived session token from OAuth callback
     */
    @IsString()
    @MinLength(1, { message: 'Session token is required' })
    token: string;
}
