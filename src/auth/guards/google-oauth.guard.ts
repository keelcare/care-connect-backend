import { Injectable, ExecutionContext } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

@Injectable()
export class GoogleOauthGuard extends AuthGuard("google") {
  getAuthenticateOptions(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const role = req.query.role;
    const origin =
      req.query.origin || req.headers.referer || req.headers.origin;
    const platform = req.query.platform;

    return {
      state: JSON.stringify({
        role: role || "parent",
        origin: origin,
        platform: platform,
      }),
    };
  }
}
