import {
    Controller,
    Get,
    Req,
    Res,
    Sse,
    UseGuards,
    Logger,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Observable, fromEvent } from 'rxjs';
import { Request, Response } from 'express';
import { SseService } from './sse.service';
import { ActiveUserGuard } from '../common/guards/active-user.guard';

@Controller()
export class SseController {
    private readonly logger = new Logger(SseController.name);

    constructor(private readonly sseService: SseService) { }

    /**
     * GET /sse
     *
     * Opens a Server-Sent Events stream for the authenticated user.
     * The browser keeps this connection open and receives events as they happen.
     *
     * Auth: JWT cookie (same as all other protected endpoints).
     * The EventSource on the frontend sends cookies automatically because
     * it uses `withCredentials: true`.
     */
    @Get('sse')
    @UseGuards(AuthGuard('jwt'), ActiveUserGuard)
    @Sse()
    stream(@Req() req: Request & { user: any }, @Res() res: Response): Observable<MessageEvent> {
        const userId: string = req.user.id ?? req.user.sub;
        const role: string = req.user.role || 'user';

        // Register this user's SSE subject
        const subject = this.sseService.addClient(userId, role);

        // When the client closes the connection (tab close, logout, navigate away)
        // clean up the subject so we don't leak memory.
        req.on('close', () => {
            this.sseService.removeClient(userId);
        });

        // NestJS @Sse() expects an Observable<MessageEvent>
        return subject.asObservable();
    }
}
