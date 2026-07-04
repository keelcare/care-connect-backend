import {
  Controller,
  Get,
  All,
  NotFoundException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { AppService } from "./app.service";
import { PrismaService } from "./prisma/prisma.service";

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // @All so uptime monitors can hit these with HEAD (or GET) — a plain @Get
  // wasn't matching HEAD, returning 404.
  @All("health")
  getHealth() {
    return {
      status: "ok",
      version: process.env.npm_package_version ?? "unknown",
      env: process.env.NODE_ENV ?? "unknown",
      uptime: Math.floor(process.uptime()),
    };
  }

  @All("ready")
  async getReady() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        status: "ready",
        db: "connected",
        version: process.env.npm_package_version ?? "unknown",
        uptime: Math.floor(process.uptime()),
      };
    } catch (error: any) {
      throw new ServiceUnavailableException({
        status: "down",
        db: "disconnected",
        error: error.message,
      });
    }
  }

  @Get("debug-sentry")
  debugSentry() {
    if (process.env.NODE_ENV === "production") {
      throw new NotFoundException();
    }
    throw new InternalServerErrorException(
      "Sentry Debug Error: " + new Date().toISOString(),
    );
  }
}
