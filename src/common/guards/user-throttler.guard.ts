import { Injectable, ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerException } from '@nestjs/throttler';

/**
 * SECURITY: User-based rate limiting guard
 * 
 * This guard extends the default ThrottlerGuard to provide more granular rate limiting:
 * - For authenticated requests: Rate limit by user ID
 * - For unauthenticated requests: Rate limit by IP address
 * 
 * This prevents a single user from bypassing rate limits by switching IPs,
 * while still protecting against distributed attacks via IP-based limiting.
 * 
 * OWASP Best Practice: Implement rate limiting per user and per IP
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
    /**
     * Generate a unique tracking key for rate limiting
     * 
     * @param context - Execution context containing request information
     * @returns Tracking key in format "user-{userId}" or "ip-{ipAddress}"
     */
    protected async getTracker(req: Record<string, any>): Promise<string> {
        // If user is authenticated, track by user ID
        if (req.user && req.user.id) {
            return `user-${req.user.id}`;
        }

        // For unauthenticated requests, track by IP address
        // Support both direct connections and proxied requests
        const ip = req.ip || req.connection?.remoteAddress || 'unknown';
        return `ip-${ip}`;
    }

    /**
     * Handle rate limit exceeded scenario
     * 
     * @param context - Execution context
     * @throws ThrottlerException with custom message
     */
    protected async throwThrottlingException(context: ExecutionContext): Promise<void> {
        throw new ThrottlerException('Too many requests, please try again later');
    }
}
