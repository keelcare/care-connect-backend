# Backend Requirements for HttpOnly Cookie Authentication

## Current Situation

The frontend has been updated to use **HttpOnly cookie-based authentication** for all requests, including:
- REST API calls (using `credentials: 'include'`)
- Socket.IO connections (using `withCredentials: true`)
- File uploads
- AI chat requests

**Problem**: Socket connections are not being established and some API calls may be failing because the backend needs to be configured to:
1. Accept cookies in Socket.IO connections
2. Extract user authentication from cookies (not Authorization headers)
3. Configure CORS to allow credentials

## Required Backend Changes

### 1. CORS Configuration (CRITICAL)

**File**: `src/main.ts` (or wherever CORS is configured)

The backend MUST enable CORS with credentials support:

```typescript
app.enableCors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true, // CRITICAL: Must be true to accept cookies
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'], // Keep Authorization for backwards compatibility
});
```

**Key Points**:
- `credentials: true` is **REQUIRED** - without this, cookies won't be sent/received
- `origin` cannot be `'*'` when using credentials - must be specific domain
- Must match the frontend URL exactly (including protocol and port)

---

### 2. Socket.IO Gateway Configuration (CRITICAL)

**File**: Socket.IO gateway setup (e.g., `src/chat/chat.gateway.ts` or `src/socket/socket.gateway.ts`)

The Socket.IO server MUST be configured to accept credentials:

```typescript
@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true, // CRITICAL: Must be true
  },
})
export class ChatGateway {
  // ... gateway implementation
}
```

**Alternative** (if using Socket.IO directly):

```typescript
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST'],
  },
});
```

---

### 3. Authentication Middleware/Guards

**Files**: Auth guards, JWT strategy, etc.

The backend authentication system needs to extract the JWT from **cookies** instead of (or in addition to) the Authorization header.

#### Option A: Update JWT Strategy (Passport.js)

```typescript
// jwt.strategy.ts
import { ExtractJwt, Strategy } from 'passport-jwt';

// Custom extractor that checks cookies first, then Authorization header
const cookieExtractor = (req: Request) => {
  let token = null;
  if (req && req.cookies) {
    token = req.cookies['access_token']; // Check cookie first
  }
  if (!token && req.headers.authorization) {
    // Fallback to Authorization header for backwards compatibility
    token = req.headers.authorization.replace('Bearer ', '');
  }
  return token;
};

export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: cookieExtractor, // Use custom extractor
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET,
    });
  }
  
  async validate(payload: any) {
    return { 
      id: payload.sub, 
      email: payload.email, 
      role: payload.role,
      is_active: payload.is_active 
    };
  }
}
```

#### Option B: Update Auth Guard

```typescript
// jwt-auth.guard.ts or similar
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    
    // Extract token from cookie if not in header
    if (!request.headers.authorization && request.cookies?.access_token) {
      request.headers.authorization = `Bearer ${request.cookies.access_token}`;
    }
    
    return super.canActivate(context);
  }
}
```

---

### 4. Socket.IO Authentication Middleware

**File**: Socket.IO gateway or middleware

Socket.IO connections need to authenticate users from cookies:

```typescript
// In your Socket.IO gateway
@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  },
})
export class ChatGateway implements OnGatewayConnection {
  
  async handleConnection(client: Socket) {
    try {
      // Extract token from cookies sent with handshake
      const cookies = this.parseCookies(client.handshake.headers.cookie);
      const token = cookies['access_token'];
      
      if (!token) {
        console.log('No token in cookies, disconnecting client');
        client.disconnect();
        return;
      }
      
      // Verify token and get user
      const user = await this.jwtService.verify(token);
      
      // Store user info in socket data for later use
      client.data.user = user;
      
      console.log(`User ${user.email} connected via socket`);
    } catch (error) {
      console.error('Socket authentication failed:', error);
      client.disconnect();
    }
  }
  
  private parseCookies(cookieHeader: string): Record<string, string> {
    if (!cookieHeader) return {};
    
    return cookieHeader.split(';').reduce((cookies, cookie) => {
      const [name, value] = cookie.trim().split('=');
      cookies[name] = value;
      return cookies;
    }, {} as Record<string, string>);
  }
  
  // In your message handlers, you can now access the user:
  @SubscribeMessage('sendMessage')
  async handleMessage(client: Socket, payload: any) {
    const user = client.data.user; // User from authentication
    // ... handle message
  }
}
```

---

### 5. Cookie Configuration in Auth Endpoints

**Files**: Login, signup, refresh endpoints

Ensure cookies are being set correctly with proper flags:

```typescript
// In login/signup endpoints
@Post('login')
async login(@Body() loginDto: LoginDto, @Res({ passthrough: true }) response: Response) {
  const { user, access_token, refresh_token } = await this.authService.login(loginDto);
  
  // Set access token cookie
  response.cookie('access_token', access_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // HTTPS only in production
    sameSite: 'lax', // or 'strict' depending on your needs
    maxAge: 15 * 60 * 1000, // 15 minutes
  });
  
  // Set refresh token cookie
  response.cookie('refresh_token', refresh_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
  
  return { user }; // Don't send tokens in response body
}
```

---

### 6. Refresh Token Endpoint

**File**: Auth controller

```typescript
@Post('refresh')
async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
  // Get refresh token from cookie
  const refreshToken = request.cookies['refresh_token'];
  
  if (!refreshToken) {
    throw new UnauthorizedException('No refresh token');
  }
  
  const { access_token, refresh_token: new_refresh_token } = 
    await this.authService.refreshTokens(refreshToken);
  
  // Set new tokens in cookies
  response.cookie('access_token', access_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 15 * 60 * 1000,
  });
  
  response.cookie('refresh_token', new_refresh_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  
  return { message: 'Tokens refreshed' };
}
```

---

### 7. Logout Endpoint

**File**: Auth controller

```typescript
@Post('logout')
async logout(@Res({ passthrough: true }) response: Response) {
  // Clear cookies
  response.clearCookie('access_token');
  response.clearCookie('refresh_token');
  
  return { message: 'Logged out successfully' };
}
```

---

## Testing Checklist

After implementing these changes, test the following:

### REST API
- [ ] Login sets cookies correctly (check browser DevTools > Application > Cookies)
- [ ] Subsequent API calls include cookies automatically
- [ ] `/users/me` endpoint works without 401 errors
- [ ] File upload endpoints work (verification documents, profile images)
- [ ] Refresh token endpoint works and rotates cookies

### Socket.IO
- [ ] Socket connection establishes successfully
- [ ] Console shows "Socket connected: [socket-id]"
- [ ] User can join chat rooms
- [ ] Real-time messages are sent and received
- [ ] Typing indicators work
- [ ] Geofence alerts work (if implemented)

### CORS
- [ ] No CORS errors in browser console
- [ ] Cookies are sent with cross-origin requests
- [ ] Preflight OPTIONS requests succeed

---

## Environment Variables

Ensure these are set in `.env`:

```bash
# Frontend URL for CORS
FRONTEND_URL=http://localhost:3000

# JWT Secrets
JWT_SECRET=your-secret-key
JWT_REFRESH_SECRET=your-refresh-secret-key

# Node Environment
NODE_ENV=development
```

---

## Common Issues and Solutions

### Issue 1: "CORS policy: credentials mode is 'include'"
**Solution**: Set `credentials: true` in CORS config and specify exact origin (not `'*'`)

### Issue 2: Cookies not being sent
**Solution**: 
- Check `sameSite` setting (use `'lax'` for development)
- Ensure frontend and backend are on same domain (localhost for both)
- Check `secure` flag (should be `false` in development)

### Issue 3: Socket.IO connection fails
**Solution**:
- Verify Socket.IO gateway has `credentials: true` in CORS
- Check that cookies are being parsed in `handleConnection`
- Ensure JWT verification works with cookie tokens

### Issue 4: 401 Unauthorized after login
**Solution**:
- Verify cookies are being set (check browser DevTools)
- Check cookie names match (`access_token`, `refresh_token`)
- Verify JWT strategy extracts from cookies

---

## Priority Order

Implement in this order for fastest resolution:

1. **CORS Configuration** (main.ts) - Without this, nothing will work
2. **Socket.IO Gateway CORS** - Required for socket connections
3. **JWT Strategy/Guard** - Extract tokens from cookies
4. **Socket.IO Authentication** - Parse cookies in handleConnection
5. **Cookie Settings** - Ensure proper flags in login/refresh endpoints

---

## Additional Notes

- The frontend is already configured correctly with `credentials: 'include'` and `withCredentials: true`
- All frontend API calls use the `fetchApi` helper which includes credentials
- Socket.IO client is configured with `withCredentials: true`
- The issue is purely on the backend side - it needs to accept and process cookies

---

## Questions for Backend Team

1. Are cookies currently being set in login/signup responses?
2. Is the JWT strategy currently extracting tokens from cookies or only from Authorization headers?
3. Is Socket.IO gateway configured with `credentials: true` in CORS?
4. What is the current CORS configuration in main.ts?
