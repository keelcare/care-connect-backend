import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import { Response } from "express";

/**
 * SECURITY: Global exception filter for rate limiting
 *
 * Provides graceful 429 responses with proper headers when rate limits are exceeded.
 * Includes Retry-After header to inform clients when they can retry.
 *
 * OWASP Best Practice: Provide clear feedback to clients about rate limiting
 * without exposing internal implementation details.
 */
@Catch(ThrottlerException)
export class ThrottleExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ThrottleExceptionFilter.name);

  catch(exception: ThrottlerException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest();

    // Log rate limit violation for monitoring
    // Include IP and user ID (if authenticated) for security auditing
    const ip = request.ip || request.connection?.remoteAddress || "unknown";
    const userId = request.user?.id || "unauthenticated";
    const endpoint = `${request.method} ${request.url}`;

    this.logger.warn(
      `Rate limit exceeded - IP: ${ip}, User: ${userId}, Endpoint: ${endpoint}`,
    );

    // Calculate retry-after time (60 seconds for default TTL)
    const retryAfter = 60;

    // Send graceful 429 response
    response
      .status(HttpStatus.TOO_MANY_REQUESTS)
      .header("Retry-After", retryAfter.toString())
      .header("X-RateLimit-Limit", "100") // Global default
      .header("X-RateLimit-Remaining", "0")
      .header(
        "X-RateLimit-Reset",
        new Date(Date.now() + retryAfter * 1000).toISOString(),
      )
      .json({
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: "Too many requests, please try again later",
        error: "Too Many Requests",
        retryAfter: retryAfter,
      });
  }
}
