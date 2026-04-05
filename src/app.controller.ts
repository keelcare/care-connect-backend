import { Controller, Get, NotFoundException, InternalServerErrorException } from "@nestjs/common";
import { AppService } from "./app.service";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get("debug-sentry")
  debugSentry() {
    if (process.env.NODE_ENV === "production") {
      throw new NotFoundException();
    }
    throw new InternalServerErrorException("Sentry Debug Error: " + new Date().toISOString());
  }
}
