import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const SKIP_ACTIVE_CHECK_KEY = 'skipActiveCheck';

/**
 * Decorator to opt-out of the ActiveUserGuard for a specific route.
 * Use this on endpoints that banned users must be able to reach
 * (e.g. GET /users/me so the frontend can show the ban screen).
 */
export const SkipActiveCheck = () => SetMetadata(SKIP_ACTIVE_CHECK_KEY, true);

/**
 * Blocks banned (is_active === false) users from accessing a route.
 * Must be applied AFTER AuthGuard('jwt') so that req.user is already populated.
 *
 * Apply at the controller class level for broad enforcement, and use
 * @SkipActiveCheck() on individual routes where banned users are allowed.
 */
@Injectable()
export class ActiveUserGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Allow the route to opt-out of this check
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_ACTIVE_CHECK_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (user && user.is_active === false) {
      throw new ForbiddenException(
        'Your account has been suspended. Please contact support to appeal.',
      );
    }

    return true;
  }
}
