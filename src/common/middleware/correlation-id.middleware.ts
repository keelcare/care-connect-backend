import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import * as crypto from "node:crypto";

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const correlationId = (req.headers["x-request-id"] as string) || crypto.randomUUID();
    
    // Set on request so that Pino or other services can read it
    req["correlationId"] = correlationId;
    req.headers["x-request-id"] = correlationId;

    // Set on response headers
    res.setHeader("X-Request-ID", correlationId);

    next();
  }
}
