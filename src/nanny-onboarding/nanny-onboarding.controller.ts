import { Controller, Get, Put, Post, Body, UseGuards, Request } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { ActiveUserGuard } from "../common/guards/active-user.guard";
import { NannyOnboardingService } from "./nanny-onboarding.service";
import { UpsertNannyOnboardingDto } from "./dto/upsert-nanny-onboarding.dto";

@ApiTags("Nanny Onboarding")
@ApiBearerAuth()
@Controller("nanny-onboarding")
@UseGuards(AuthGuard("jwt"), ActiveUserGuard)
export class NannyOnboardingController {
  constructor(private readonly nannyOnboardingService: NannyOnboardingService) {}

  @Get("me")
  @ApiOperation({ summary: "Get the current nanny's extended onboarding profile" })
  @ApiResponse({ status: 200, description: "Return the onboarding profile, or null if not started" })
  async getMine(@Request() req) {
    return this.nannyOnboardingService.getMine(req.user.id);
  }

  @Put("me")
  @ApiOperation({ summary: "Create or partially update the current nanny's onboarding profile" })
  @ApiResponse({ status: 200, description: "Onboarding profile saved" })
  async upsertMine(@Request() req, @Body() dto: UpsertNannyOnboardingDto) {
    return this.nannyOnboardingService.upsertMine(req.user.id, dto);
  }

  @Post("me/complete")
  @ApiOperation({ summary: "Mark onboarding as complete after validating all required fields and documents" })
  @ApiResponse({ status: 200, description: "Onboarding marked complete" })
  @ApiResponse({ status: 400, description: "Missing required fields, consents, or documents" })
  async completeMine(@Request() req) {
    return this.nannyOnboardingService.completeMine(req.user.id);
  }
}
