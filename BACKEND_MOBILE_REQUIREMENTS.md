# Backend Requirements: Capacitor Mobile App Support

**To:** Backend Team  
**From:** Frontend Team  
**Branch:** `feat/capacitor-mobile`  
**Date:** 20 February 2026

---

## Context

The Care Connect frontend is being wrapped in a Capacitor native shell for iOS and Android. The Next.js app is compiled to a static bundle and loaded inside a native WebView:

- **iOS:** origin is `capacitor://localhost`
- **Android:** origin is `https://localhost`

All existing web behaviour must continue working unchanged — these are **additive** requirements only. The deployed Vercel web app is not affected.

---

## Change 1 — Cookie `SameSite` flag (CRITICAL)

This is the single most important change. Every `Set-Cookie` call across the entire auth flow (login, signup, token refresh, Google OAuth callback) must be updated.

**Required cookie flags:**

```ts
response.cookie('access_token', accessToken, {
  httpOnly: true,
  secure: true,     // MUST be true — Capacitor always runs over HTTPS
  sameSite: 'none', // MUST be 'none' — WebView origin is cross-origin vs the API
  // Do NOT set 'domain' — omit it entirely
  maxAge: 15 * 60 * 1000, // 15 minutes
});

response.cookie('refresh_token', refreshToken, {
  httpOnly: true,
  secure: true,
  sameSite: 'none',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
});
```

Apply the same flags on `clearCookie` in the logout endpoint:

```ts
response.clearCookie('access_token', { sameSite: 'none', secure: true });
response.clearCookie('refresh_token', { sameSite: 'none', secure: true });
```

**Endpoints to update:**
- `POST /auth/login`
- `POST /auth/signup`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /auth/google/callback`

**Why `SameSite=None` is required:**  
Capacitor WebViews on iOS load from `capacitor://localhost` and on Android from `https://localhost`. Both are a different origin from `keel-backend.onrender.com`. Browsers and WebViews silently block `SameSite=Lax` or `SameSite=Strict` cookies on cross-origin requests. The result is every authenticated API call returns 401, even after a successful login.

`SameSite=None` is safe here because:
- `secure: true` is required alongside it (spec-mandated, browser will reject `SameSite=None` without it)
- The WebView is a first-party context (our own native app), not a third-party embed

---

## Change 2 — CORS Allowed Origins (CRITICAL)

The existing CORS config must add the two Capacitor WebView origins alongside the existing web origins.

**`src/main.ts`:**

```ts
app.enableCors({
  origin: [
    process.env.FRONTEND_URL,        // e.g. https://careconnect.vercel.app (web)
    'http://localhost:3000',          // local dev web
    'capacitor://localhost',          // iOS Capacitor WebView
    'https://localhost',              // Android Capacitor WebView
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});
```

> **Important:** `origin: '*'` cannot be used when `credentials: true` — the explicit list is mandatory.

Apply the **same origin list** to every `@WebSocketGateway` decorator so Socket.IO connections from the mobile app are accepted:

```ts
@WebSocketGateway({
  cors: {
    origin: [
      process.env.FRONTEND_URL,
      'http://localhost:3000',
      'capacitor://localhost',
      'https://localhost',
    ],
    credentials: true,
  },
})
```

---

## Change 3 — Google OAuth Mobile Redirect (Required for Phase 4)

The current Google OAuth callback unconditionally redirects to the web frontend URL. On mobile the app handles a custom deep-link scheme (`careconnect://`). The callback needs to support a `platform` query param to branch behaviour.

**Current flow:**
```
GET /auth/google
  → Google auth
  → GET /auth/google/callback
  → redirect to https://careconnect.vercel.app/auth/callback?token=...
```

**Required mobile flow:**
```
GET /auth/google?platform=mobile
  → Google auth
  → GET /auth/google/callback
  → redirect to careconnect://auth/callback?token=...
```

**Implementation (NestJS — `auth.controller.ts`):**

```ts
@Get('google')
@UseGuards(AuthGuard('google'))
async googleAuth(
  @Query('platform') platform: string,
  @Session() session: any,
) {
  // Passport handles the redirect to Google.
  // Store the platform in session so the callback can read it.
  session.oauthPlatform = platform;
}

@Get('google/callback')
@UseGuards(AuthGuard('google'))
async googleCallback(
  @Req() req: Request,
  @Res() res: Response,
  @Session() session: any,
) {
  const { access_token, refresh_token } = await this.authService.googleLogin(req.user);

  const isMobile = session.oauthPlatform === 'mobile';
  delete session.oauthPlatform;

  if (isMobile) {
    // Token in URL — deep-link handler reads it and bootstraps the session
    return res.redirect(`careconnect://auth/callback?token=${access_token}`);
  }

  // Web: set cookie and redirect as before
  res.cookie('access_token', access_token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 15 * 60 * 1000,
  });
  res.cookie('refresh_token', refresh_token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  return res.redirect(`${process.env.FRONTEND_URL}/auth/callback`);
}
```

The frontend deep-link handler (`careconnect://auth/callback`) will extract the token from the URL, call `POST /auth/exchange` (or store it directly), then call `GET /users/me` to complete the session.

---

## Change 4 — Token Refresh Response Body (Low Priority)

The `/auth/refresh` endpoint currently only sets cookies. Return the new `access_token` in the JSON body as well, so the mobile app can use it as a fallback if cookie persistence has issues across app restarts.

```ts
@Post('refresh')
async refresh(
  @Req() req: Request,
  @Res({ passthrough: true }) res: Response,
) {
  const refreshToken = req.cookies['refresh_token'];
  if (!refreshToken) throw new UnauthorizedException('No refresh token');

  const { access_token, refresh_token } = await this.authService.refreshTokens(refreshToken);

  res.cookie('access_token', access_token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 15 * 60 * 1000,
  });
  res.cookie('refresh_token', refresh_token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  return { access_token }; // ← add this
}
```

---

## Change 5 — Preflight OPTIONS Handling (Verify Only)

Ensure OPTIONS requests to all auth endpoints return `200` without requiring authentication. In NestJS this is automatic if `app.enableCors()` is called **before** `app.listen()`. Verify the order in `main.ts`:

```ts
// main.ts — order matters
app.enableCors({ ... }); // ← MUST come before listen
await app.listen(PORT);
```

No code change required if this order is already correct.

---

## Summary

| # | Change | File(s) | Priority |
|---|--------|---------|----------|
| 1 | Set `sameSite: 'none'` + `secure: true` on all auth cookies | Auth controller | **Critical** |
| 2 | Add `capacitor://localhost` + `https://localhost` to CORS origins | `main.ts`, all `@WebSocketGateway` | **Critical** |
| 3 | Support `?platform=mobile` on Google OAuth, redirect to `careconnect://` | `auth.controller.ts` | Phase 4 |
| 4 | Return `access_token` in `/auth/refresh` response body | Auth controller | Low |
| 5 | Confirm OPTIONS preflight returns 200 before `app.listen()` | `main.ts` | Verify only |

**Changes 1 and 2 are required for any authenticated API call to work on the mobile app.** Deploy these first. Everything else can follow in a subsequent deploy.

---

## Testing Checklist (After Deploy)

- [ ] Login on the mobile build sets cookies visible in the device WebView inspector
- [ ] `GET /users/me` returns the user (not 401) after login on mobile
- [ ] Token refresh works and rotates both cookies
- [ ] Logout clears both cookies
- [ ] Socket.IO connects successfully from the mobile build
- [ ] Google OAuth with `?platform=mobile` redirects to `careconnect://auth/callback?token=...`
- [ ] Web login/logout on Vercel is unaffected
