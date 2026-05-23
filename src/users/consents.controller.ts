import { Controller, Post, Get, Body, Req, UseGuards } from "@nestjs/common";
import { ConsentsService } from "./consents.service";
import { AuthGuard } from "@nestjs/passport";
import { ActiveUserGuard } from "../common/guards/active-user.guard";
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from "@nestjs/swagger";

/** Helper: extract the real client IP from the request */
function getClientIp(req: any): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

@ApiTags("Consents")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"), ActiveUserGuard)
@Controller("consents")
export class ConsentsController {
  constructor(private readonly consentsService: ConsentsService) {}

  @Post()
  @ApiOperation({ summary: "Store user consent record" })
  @ApiResponse({ status: 201, description: "Consent stored successfully" })
  async storeConsent(
    @Req() req: any,
    @Body() body: { purpose: string; version: string },
  ) {
    return this.consentsService.storeConsent(
      req.user.id,
      body.purpose,
      body.version,
      getClientIp(req),
    );
  }

  @Get()
  @ApiOperation({ summary: "Get user consent records" })
  @ApiResponse({ status: 200, description: "Returns list of user consents" })
  async getConsents(@Req() req: any) {
    return this.consentsService.getUserConsents(req.user.id);
  }
}
