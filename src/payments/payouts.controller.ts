import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  RawBodyRequest,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "@nestjs/passport";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { UserRole } from "../auth/dto/signup.dto";
import { Roles } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { PayoutsService } from "./payouts.service";
import { RazorpayxService } from "./razorpayx.service";
import {
  ApprovePayoutAccountDto,
  PayoutListQueryDto,
  RejectPayoutAccountDto,
  ReleasePayoutDto,
  SubmitPayoutAccountDto,
} from "./dto/payout-account.dto";

function getClientIp(req: any): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

// ─── Caregiver ───────────────────────────────────────────────────────────────

@ApiTags("Payouts")
@Controller("payouts")
@Roles(UserRole.NANNY)
@UseGuards(AuthGuard("jwt"), RolesGuard)
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get("account")
  @ApiOperation({
    summary: "The caregiver's payout destination",
    description:
      "Masked: the full account number is never stored and never returned. " +
      "`payable` is true only when the account is approved *and* registered with " +
      "the payment gateway — a `status` of `active` alone is not enough to be paid.",
  })
  @ApiResponse({ status: 200, description: "Payout account, or null if none" })
  async getAccount(@Req() req: any) {
    return this.payouts.getPayoutAccount(req.user.id);
  }

  @Post("account")
  @ApiOperation({
    summary: "Submit bank or UPI details for review",
    description:
      "Goes to `pending_review`; an admin must approve it before any money can be " +
      "sent. Submitting again replaces a pending submission but leaves an already " +
      "active account in place, so a rejected change never leaves the caregiver " +
      "without a way to be paid.",
  })
  @ApiResponse({ status: 201, description: "Submitted for review" })
  async submitAccount(@Req() req: any, @Body() dto: SubmitPayoutAccountDto) {
    return this.payouts.submitPayoutAccount(req.user.id, dto);
  }

  @Delete("account")
  @ApiOperation({ summary: "Withdraw the payout account on file" })
  async removeAccount(@Req() req: any) {
    return this.payouts.removePayoutAccount(req.user.id);
  }

  @Get()
  @ApiOperation({
    summary: "The caregiver's payout history",
    description:
      "`utr` is the bank reference for a processed payout — what she quotes to her " +
      "bank if it has not appeared. A `failed` or `reversed` payout means the money " +
      "is back in her pending earnings, not lost.",
  })
  async listMine(@Req() req: any, @Query() query: PayoutListQueryDto) {
    return this.payouts.listPayoutsForNanny(
      req.user.id,
      query.page,
      query.pageSize,
    );
  }
}

// ─── Admin ───────────────────────────────────────────────────────────────────

@ApiTags("Payouts")
@Controller("admin/payouts")
@Roles(UserRole.ADMIN)
@UseGuards(AuthGuard("jwt"), RolesGuard)
export class AdminPayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get("accounts/pending")
  @ApiOperation({ summary: "Payout accounts awaiting review" })
  async pendingAccounts() {
    return this.payouts.listPendingAccounts();
  }

  @Post("accounts/:id/approve")
  @ApiOperation({
    summary: "Approve a payout account and register it with the gateway",
    description:
      "For a bank account the full account number must be supplied: it is not " +
      "stored anywhere, so an admin re-keys it from the caregiver's document. That " +
      "re-keying is also the check that catches a transposed digit before it sends " +
      "money to a stranger's valid account.",
  })
  async approveAccount(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: ApprovePayoutAccountDto,
    @Req() req: any,
  ) {
    return this.payouts.approvePayoutAccount(
      id,
      req.user.id,
      dto.accountNumber,
      getClientIp(req),
    );
  }

  @Post("accounts/:id/reject")
  @ApiOperation({ summary: "Reject a payout account with a reason" })
  async rejectAccount(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: RejectPayoutAccountDto,
    @Req() req: any,
  ) {
    return this.payouts.rejectPayoutAccount(
      id,
      req.user.id,
      dto.reason,
      getClientIp(req),
    );
  }

  @Get()
  @ApiOperation({ summary: "Every payout, newest first" })
  async list(@Query() query: PayoutListQueryDto) {
    return this.payouts.listPayouts(query);
  }

  @Post("nanny/:nannyId/release")
  @ApiOperation({
    summary: "Send a caregiver everything she is owed",
    description:
      "**This moves real money.** The amount is the sum of her outstanding " +
      "`pending_release` payments after commission — exactly what " +
      "`GET /admin/revenue/payouts` shows. Refused when a payout for her is already " +
      "in flight, or when she has no approved payout account.\n\n" +
      "Pass `manual: true` to record a settlement made outside the platform without " +
      "calling the gateway.",
  })
  async release(
    @Param("nannyId", new ParseUUIDPipe()) nannyId: string,
    @Body() dto: ReleasePayoutDto,
    @Req() req: any,
  ) {
    return this.payouts.releasePayoutForNanny(nannyId, req.user.id, {
      manual: dto.manual,
      note: dto.note,
      ipAddress: getClientIp(req),
    });
  }

  @Post(":id/sync")
  @ApiOperation({
    summary: "Refetch a payout's status from the gateway",
    description:
      "For when a webhook was missed. The scheduled sweep does this automatically " +
      "every 15 minutes; this is the manual nudge.",
  })
  async sync(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.payouts.syncPayout(id);
  }
}

// ─── Webhook ─────────────────────────────────────────────────────────────────

/**
 * Unauthenticated by necessity — RazorpayX calls it — and therefore verified by
 * HMAC over the raw request body on every single request.
 */
@ApiTags("Payouts")
@Controller("payments")
export class PayoutWebhookController {
  constructor(
    private readonly payouts: PayoutsService,
    private readonly razorpayx: RazorpayxService,
  ) {}

  @Post("payout-webhook")
  @ApiOperation({ summary: "RazorpayX payout status webhook" })
  @ApiResponse({ status: 200, description: "Webhook processed" })
  async handle(
    @Headers("x-razorpay-signature") signature: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    // The raw bytes, not a re-serialised object: re-encoding JSON is not guaranteed
    // to reproduce what was signed. `rawBody: true` in main.ts is what populates it.
    const raw = req.rawBody;
    if (!raw) {
      throw new BadRequestException("Raw body unavailable; cannot verify signature");
    }
    if (!this.razorpayx.verifyWebhookSignature(raw, signature)) {
      throw new BadRequestException("Invalid webhook signature");
    }

    return this.payouts.handlePayoutWebhook(req.body);
  }
}
