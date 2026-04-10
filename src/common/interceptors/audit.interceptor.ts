import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { tap } from "rxjs/operators";
import { Reflector } from "@nestjs/core";
import { AuditService } from "../services/audit/audit.service";

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private auditService: AuditService,
    private reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const method = request.method;
    const path = request.path;

    // Only audit mutating actions or sensitive reads
    // Simplification: audit all non-GET, or specific guarded routes
    const shouldAudit = method !== "GET";

    if (!shouldAudit || !user) {
      return next.handle();
    }

    return next.handle().pipe(
      tap(async (data) => {
        // Log asynchronously to not block response
        // Use setImmediate to fire-and-forget
        const ip =
          request.ip ||
          request.headers["x-forwarded-for"] ||
          request.socket.remoteAddress;

        // Sanitize data if needed before logging
        // Avoid logging full response bodies if sensitive

        await this.auditService.log({
          userId: user.id,
          action: `${method} ${path}`,
          resourceType: "API",
          // resourceId: data?.id, // Generic
          ipAddress: ip,
          userAgent: request.headers["user-agent"],
          details: {
            method,
            path,
            // body: request.body, // CAREFUL: PII
          },
        });
      }),
    );
  }
}
