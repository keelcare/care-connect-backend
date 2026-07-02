import { Injectable, NestMiddleware, ForbiddenException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Origins that are exempt from the X-Requested-With check (native Capacitor apps
// and server-to-server calls don't send it — they also can't receive cookies from
// cross-site attackers, so CSRF is not applicable in those contexts).
// Only native app URL schemes are exempt. Browser origins such as http(s)://localhost
// are NOT exempt — a malicious page served from localhost could otherwise bypass CSRF.
const EXEMPT_ORIGINS = ['capacitor://localhost', 'ionic://localhost', 'keel://', 'careconnect://'];

@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    if (SAFE_METHODS.has(req.method)) return next();

    const origin = req.headers.origin as string | undefined;

    // Exempt native mobile origins and server-to-server (no origin header)
    if (!origin || EXEMPT_ORIGINS.some((o) => origin.startsWith(o))) {
      return next();
    }

    const xrw = req.headers['x-requested-with'];
    if (!xrw) {
      throw new ForbiddenException('CSRF check failed: missing X-Requested-With header');
    }

    next();
  }
}
