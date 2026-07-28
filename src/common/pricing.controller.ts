import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from "@nestjs/swagger";
import { TransparentJwtAuthGuard } from "../auth/guards/transparent-jwt-auth.guard";
import { PricingEngineService } from "./pricing.service";

@ApiTags("pricing")
@ApiBearerAuth()
@UseGuards(TransparentJwtAuthGuard)
@Controller("pricing")
export class PricingController {
  constructor(private readonly pricingService: PricingEngineService) {}

  /**
   * Lets the client show a GST line on a pre-booking estimate, where no snapshot
   * exists yet. Once a booking is charged the client should read the GST figures
   * off the snapshot instead — that is the record of what was actually charged.
   */
  @Get("config")
  @ApiOperation({ summary: "Pricing configuration currently in force" })
  @ApiResponse({
    status: 200,
    schema: {
      example: { gst: { enabled: false, percent: 18 } },
    },
  })
  getConfig() {
    return { gst: this.pricingService.getGstConfig() };
  }
}
