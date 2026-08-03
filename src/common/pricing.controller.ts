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
      example: {
        gst: { enabled: false, percent: 18 },
        splitPayment: { enabled: true, ratioPercent: 50, dueDays: 14 },
        matchingFee: { enabled: true, amount: 249 },
      },
    },
  })
  async getConfig() {
    return {
      gst: this.pricingService.getGstConfig(),
      // Lets the client state the terms before checkout ("50% now, the rest in 14
      // days"). The amounts themselves still come from the order response — this
      // is the policy, not the arithmetic.
      splitPayment: await this.pricingService.getAdvancePaymentConfig(),
      // The parent has to be told what they are about to be charged *before* they
      // confirm, since the fee is taken at that moment. Read-only policy — the
      // amount actually billed comes back on the create response.
      matchingFee: await this.pricingService.getMatchingFeeConfig(),
    };
  }
}
