import { Throttle } from '@nestjs/throttler';

/**
 * SECURITY: Custom throttle decorators for different endpoint sensitivity levels
 * 
 * These decorators provide sensible defaults for rate limiting based on endpoint type.
 * All values are configurable via the @Throttle decorator if needed.
 */

/**
 * Strict rate limiting for authentication endpoints
 * 
 * Use on: login, signup, password reset, etc.
 * Limit: 10 requests per minute
 * 
 * OWASP Best Practice: Strict rate limiting on authentication endpoints
 * prevents brute force attacks and credential stuffing.
 * 
 * @example
 * ```typescript
 * @Post('login')
 * @StrictThrottle()
 * async login(@Body() loginDto: LoginDto) { ... }
 * ```
 */
export const StrictThrottle = () => Throttle({ default: { limit: 10, ttl: 60000 } });

/**
 * Moderate rate limiting for write operations
 * 
 * Use on: POST, PUT, PATCH, DELETE endpoints
 * Limit: 30 requests per minute
 * 
 * Provides protection against spam and abuse while allowing
 * legitimate users to perform multiple operations.
 * 
 * @example
 * ```typescript
 * @Post('requests')
 * @ModerateThrottle()
 * async createRequest(@Body() dto: CreateRequestDto) { ... }
 * ```
 */
export const ModerateThrottle = () => Throttle({ default: { limit: 30, ttl: 60000 } });

/**
 * Skip throttling for specific endpoints
 * 
 * Use sparingly, only for endpoints that truly need unlimited access
 * (e.g., health checks, webhooks with signature verification)
 * 
 * @example
 * ```typescript
 * @Get('health')
 * @SkipThrottle()
 * async healthCheck() { ... }
 * ```
 */
export { SkipThrottle } from '@nestjs/throttler';
