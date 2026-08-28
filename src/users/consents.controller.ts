import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ConsentsService } from "./consents.service";
import { AuthGuard } from "@nestjs/passport";
import { ActiveUserGuard } from "../common/guards/active-user.guard";
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from "@nestjs/swagger";
import { CreateConsentDto, WithdrawConsentDto } from "./dto/consent.dto";

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
  @ApiOperation({ summary: "Record a consent grant (DPDPA s.6)" })
  @ApiResponse({ status: 201, description: "Consent stored successfully" })
  async storeConsent(@Req() req: any, @Body() body: CreateConsentDto) {
    return this.consentsService.storeConsent(
      req.user.id,
      body.purpose,
      body.version,
      getClientIp(req),
      {
        subjectType: body.subject_type,
        subjectId: body.subject_id,
        metadata: {
          platform: req.headers["x-platform"] ?? null,
          user_agent: req.headers["user-agent"] ?? null,
        },
      },
    );
  }

  @Get()
  @ApiOperation({ summary: "Full consent history (audit trail)" })
  @ApiResponse({ status: 200, description: "Returns list of user consents" })
  async getConsents(@Req() req: any) {
    return this.consentsService.getUserConsents(req.user.id);
  }

  @Get("active")
  @ApiOperation({ summary: "Current consent state, latest grant per purpose" })
  @ApiResponse({ status: 200, description: "Returns active consents" })
  async getActiveConsents(@Req() req: any) {
    return this.consentsService.getActiveConsents(req.user.id);
  }

  @Delete()
  @ApiOperation({
    summary: "Withdraw consent for a purpose (DPDPA s.6(4)-(6))",
    description:
      "Withdrawal must be as easy as granting. Essential purposes return essential:true so the client can direct the user to account deletion instead.",
  })
  @ApiResponse({ status: 200, description: "Consent withdrawn" })
  async withdrawConsent(@Req() req: any, @Query() query: WithdrawConsentDto) {
    return this.consentsService.withdrawConsent(
      req.user.id,
      query.purpose,
      query.subject_id,
    );
  }
}
