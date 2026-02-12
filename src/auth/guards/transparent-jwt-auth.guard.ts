import {
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from '../auth.service';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Response } from 'express';

@Injectable()
export class TransparentJwtAuthGuard extends AuthGuard('jwt') {
    constructor(
        private authService: AuthService,
        private configService: ConfigService,
        private jwtService: JwtService,
    ) {
        super();
    }

    private extractToken(request: any, name: string): string | null {
        // 1. Try parsed cookies from middleware
        if (request.cookies && request.cookies[name]) {
            return request.cookies[name];
        }

        // 2. Robust Regex Parsing from raw header
        const cookieHeader = request.headers?.cookie;
        if (cookieHeader) {
            const regex = new RegExp(`(?:^|;\\s*)${name}\\s*=\\s*([^;\\s]+)`);
            const match = cookieHeader.match(regex);
            if (match) return match[1];
        }

        if (name === 'access_token') {
            const authHeader = request.headers?.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                return authHeader.split(' ')[1];
            }
        }

        return null;
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const response = context.switchToHttp().getResponse<Response>();

        try {
            // Identity check (Strategy ignores expiration)
            const result = await super.canActivate(context);

            const accessToken = this.extractToken(request, 'access_token');
            if (accessToken) {
                try {
                    const secret = this.configService.get<string>('JWT_SECRET') || 'secretKey';
                    this.jwtService.verify(accessToken, { secret });
                    return true; // Valid and not expired
                } catch (err) {
                    // Expired, proceed to refresh
                }
            }
        } catch (err) {
            // Passport failed, proceed to refresh
        }

        // Refresh Logic
        const refreshToken = this.extractToken(request, 'refresh_token');
        if (!refreshToken) {
            throw new UnauthorizedException('Authentication failed');
        }

        try {
            const loginData = await this.authService.refresh(refreshToken);

            const origin = request.headers.origin || request.headers.referer || '';
            const isProd = this.configService.get('NODE_ENV') === 'production';
            const renderEnv = this.configService.get('RENDER');
            const isLocalhost = (origin && (origin.includes('localhost') || origin.includes('127.0.0.1'))) || !origin;
            const isSecure = (isProd || renderEnv || (origin && origin.startsWith('https://')) || (origin && origin.includes('netlify.app'))) && !isLocalhost;

            const cookieOptions = {
                httpOnly: true,
                secure: isSecure,
                sameSite: isSecure ? ('none' as const) : ('lax' as const),
                path: '/',
            };

            response.cookie('access_token', loginData.access_token, { ...cookieOptions, maxAge: 15 * 60 * 1000 });
            response.cookie('refresh_token', loginData.refresh_token, { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000 });

            request.user = { id: loginData.user.id, email: loginData.user.email, role: loginData.user.role };
            return true;
        } catch (refreshErr) {
            throw new UnauthorizedException('Session expired');
        }
    }
}
