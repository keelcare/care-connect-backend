import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import * as crypto from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PricingEngineService } from "../common/pricing.service";
import { AdminAuditService } from "../admin/admin-audit.service";
import {
  CAREGIVER_SHARE_ONLY,
  preTaxServiceFee,
  round2,
} from "../common/payout-policy";
import { PaymentStatus } from "../constants";
import {
  RazorpayxPayoutEntity,
  RazorpayxService,
  PayoutMode,
} from "./razorpayx.service";
import { SubmitPayoutAccountDto } from "./dto/payout-account.dto";

/**
 * Paying caregivers.
 *
 * The amount is never computed here from first principles. `common/payout-policy.ts`
 * is the single definition of what a caregiver is owed, and the admin ledger
 * (`RevenueService.getOutstandingPayouts`) already shows her that number. A payout
 * that disagreed with the balance she was shown would be a bug no reconciliation
 * could fix, so both read the same rows through the same helpers.
 */

/** Payout account life cycle. */
export const ACCOUNT_PENDING = "pending_review";
export const ACCOUNT_ACTIVE = "active";
export const ACCOUNT_REJECTED = "rejected";
export const ACCOUNT_ARCHIVED = "archived";

/** Our pre-gateway status; every other status comes from RazorpayX verbatim. */
export const PAYOUT_CREATED = "created";

/**
 * A payout in one of these states may still move money, so a second payout to the
 * same caregiver must not be started. `queued` is included deliberately: RazorpayX
 * parks it for insufficient balance and processes it later, so it is very much
 * still owed.
 */
export const IN_FLIGHT_PAYOUT_STATUSES = [
  PAYOUT_CREATED,
  "queued",
  "pending",
  "processing",
];

/** Money arrived. Terminal. */
export const PAYOUT_PROCESSED = "processed";

/**
 * Money did not arrive and will not. Terminal, and the trigger for putting the
 * earnings back on the outstanding list.
 */
export const PAYOUT_UNWOUND_STATUSES = [
  "failed",
  "reversed",
  "cancelled",
  "rejected",
];

const TERMINAL_PAYOUT_STATUSES = [PAYOUT_PROCESSED, ...PAYOUT_UNWOUND_STATUSES];

/** Every Indian IFSC: four letters, a literal 0, then six alphanumerics. */
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
/** Account numbers vary widely by bank; digits only, 6–20, is the safe envelope. */
const ACCOUNT_NUMBER_PATTERN = /^\d{6,20}$/;
const VPA_PATTERN = /^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z][a-zA-Z0-9.\-_]{1,30}$/;

type PayoutAccountRow = {
  id: string;
  account_type: string;
  beneficiary_name: string;
  account_number_last4: string | null;
  ifsc: string | null;
  vpa_address: string | null;
  razorpay_fund_account_id: string | null;
  status: string;
  rejection_reason: string | null;
  created_at: Date;
  reviewed_at: Date | null;
};

/** The masked shape sent to clients — never the full account number. */
export interface PublicPayoutAccount {
  id: string;
  accountType: "bank_account" | "vpa";
  beneficiaryName: string;
  last4: string | null;
  ifsc: string | null;
  vpaAddress: string | null;
  status: string;
  rejectionReason: string | null;
  /** Payable right now — approved *and* known to the gateway. */
  payable: boolean;
  createdAt: string;
  reviewedAt: string | null;
}

export interface PayoutReadiness {
  payoutAccount: PublicPayoutAccount | null;
  payoutReady: boolean;
  inFlightPayoutId: string | null;
}

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly razorpayx: RazorpayxService,
    private readonly notifications: NotificationsService,
    private readonly pricing: PricingEngineService,
    private readonly audit: AdminAuditService,
  ) {}

  // ─── Caregiver: payout account ─────────────────────────────────────────────

  /**
   * The caregiver's live destination — the active account, or the pending one she
   * is waiting on. Never the full account number, which this system does not hold.
   */
  async getPayoutAccount(nannyId: string) {
    const account = await this.prisma.nanny_payout_accounts.findFirst({
      where: {
        nanny_id: nannyId,
        status: { in: [ACCOUNT_ACTIVE, ACCOUNT_PENDING, ACCOUNT_REJECTED] },
      },
      // Active beats pending beats rejected: if a change is under review she still
      // needs to see which account she is currently being paid into.
      orderBy: [{ status: "asc" }, { created_at: "desc" }],
    });

    return account ? this.toPublicAccount(account) : null;
  }

  /**
   * Submitted by the caregiver, approved by an admin before any money can reach it.
   *
   * Nothing is sent to RazorpayX here. The contact and fund account are created at
   * approval, so a mistyped or rejected submission never leaves an orphan
   * beneficiary behind on an account we cannot clean up.
   */
  async submitPayoutAccount(nannyId: string, dto: SubmitPayoutAccountDto) {
    const beneficiaryName = dto.beneficiaryName?.trim();
    if (!beneficiaryName || beneficiaryName.length < 2) {
      throw new BadRequestException("Enter the name on the account");
    }

    let data: Prisma.nanny_payout_accountsCreateInput;

    if (dto.accountType === "bank_account") {
      const accountNumber = dto.accountNumber?.replace(/\s/g, "") ?? "";
      const ifsc = dto.ifsc?.trim().toUpperCase() ?? "";

      if (!ACCOUNT_NUMBER_PATTERN.test(accountNumber)) {
        throw new BadRequestException("Enter a valid account number");
      }
      if (!IFSC_PATTERN.test(ifsc)) {
        throw new BadRequestException("Enter a valid IFSC code");
      }
      // Cheap protection against a transposed digit, which is the failure mode that
      // sends money to a stranger's real account rather than bouncing.
      if (dto.confirmAccountNumber?.replace(/\s/g, "") !== accountNumber) {
        throw new BadRequestException("Account numbers do not match");
      }

      data = {
        nanny: { connect: { id: nannyId } },
        account_type: "bank_account",
        beneficiary_name: beneficiaryName,
        account_number_last4: accountNumber.slice(-4),
        ifsc,
        status: ACCOUNT_PENDING,
      };

      // Note what is *not* written: `accountNumber` itself. It is needed exactly
      // once — at approval, to create the RazorpayX fund account — and an admin
      // re-keys it from the caregiver's submitted document then. Storing it here to
      // save that keystroke would put every caregiver's bank account in a table that
      // has no other reason to hold one. See `approvePayoutAccount`.
    } else if (dto.accountType === "vpa") {
      const vpa = dto.vpaAddress?.trim() ?? "";
      if (!VPA_PATTERN.test(vpa)) {
        throw new BadRequestException("Enter a valid UPI ID");
      }

      data = {
        nanny: { connect: { id: nannyId } },
        account_type: "vpa",
        beneficiary_name: beneficiaryName,
        vpa_address: vpa,
        status: ACCOUNT_PENDING,
      };
    } else {
      throw new BadRequestException("Choose a bank account or a UPI ID");
    }

    return this.prisma.$transaction(async (tx) => {
      // Only one pending submission at a time (the partial unique index enforces
      // it). A resubmission replaces the one awaiting review; the *active* account
      // is left alone so a rejection cannot strand her without a destination.
      await tx.nanny_payout_accounts.updateMany({
        where: {
          nanny_id: nannyId,
          status: { in: [ACCOUNT_PENDING, ACCOUNT_REJECTED] },
        },
        data: { status: ACCOUNT_ARCHIVED, updated_at: new Date() },
      });

      const created = await tx.nanny_payout_accounts.create({ data });
      return this.toPublicAccount(created);
    });
  }

  /** Withdraws the account from use. Payouts already sent keep pointing at it. */
  async removePayoutAccount(nannyId: string) {
    const { count } = await this.prisma.nanny_payout_accounts.updateMany({
      where: {
        nanny_id: nannyId,
        status: { in: [ACCOUNT_ACTIVE, ACCOUNT_PENDING, ACCOUNT_REJECTED] },
      },
      data: { status: ACCOUNT_ARCHIVED, updated_at: new Date() },
    });

    if (count === 0) throw new NotFoundException("No payout account on file");
    return { removed: count };
  }

  // ─── Admin: reviewing accounts ─────────────────────────────────────────────

  async listPendingAccounts() {
    const rows = await this.prisma.nanny_payout_accounts.findMany({
      where: { status: ACCOUNT_PENDING },
      orderBy: { created_at: "asc" },
      include: {
        nanny: {
          select: {
            id: true,
            email: true,
            profiles: {
              select: { first_name: true, last_name: true, phone: true },
            },
          },
        },
      },
    });

    return rows.map((row) => ({
      ...this.toPublicAccount(row),
      nanny: {
        id: row.nanny.id,
        email: row.nanny.email,
        name:
          [row.nanny.profiles?.first_name, row.nanny.profiles?.last_name]
            .filter(Boolean)
            .join(" ") || row.nanny.email,
        phone: row.nanny.profiles?.phone ?? null,
      },
    }));
  }

  /**
   * Approval is what creates the beneficiary on RazorpayX and makes the account
   * payable.
   *
   * For a bank account the full number is required here, because it was never
   * stored — the admin re-keys it from the caregiver's submitted document, which
   * doubles as the four-eyes check that a self-serve flow otherwise lacks.
   */
  async approvePayoutAccount(
    accountId: string,
    adminId: string,
    accountNumber?: string,
    ipAddress?: string,
  ) {
    const account = await this.prisma.nanny_payout_accounts.findUnique({
      where: { id: accountId },
      include: {
        nanny: {
          select: {
            id: true,
            email: true,
            profiles: { select: { first_name: true, last_name: true, phone: true } },
          },
        },
      },
    });

    if (!account) throw new NotFoundException("Payout account not found");
    if (account.status !== ACCOUNT_PENDING) {
      throw new BadRequestException(
        `Only accounts awaiting review can be approved (this one is ${account.status})`,
      );
    }

    if (account.account_type === "bank_account") {
      const full = accountNumber?.replace(/\s/g, "") ?? "";
      if (!ACCOUNT_NUMBER_PATTERN.test(full)) {
        throw new BadRequestException(
          "The full account number is required to approve a bank account",
        );
      }
      if (full.slice(-4) !== account.account_number_last4) {
        throw new BadRequestException(
          "That account number does not match the last four digits the caregiver submitted",
        );
      }
    }

    let contactId = await this.existingContactId(account.nanny_id);
    let fundAccountId: string | null = null;

    // Without RazorpayX the account still becomes active — payouts simply settle
    // manually until the gateway is switched on, and the ids get backfilled by the
    // first approval made after that.
    if (this.razorpayx.isConfigured()) {
      if (!contactId) {
        contactId = await this.razorpayx.createContact({
          name:
            [account.nanny.profiles?.first_name, account.nanny.profiles?.last_name]
              .filter(Boolean)
              .join(" ") || account.beneficiary_name,
          email: account.nanny.email,
          phone: account.nanny.profiles?.phone,
          referenceId: account.nanny_id,
        });
      }

      fundAccountId = await this.razorpayx.createFundAccount(
        contactId,
        account.account_type === "bank_account"
          ? {
              type: "bank_account",
              bank: {
                name: account.beneficiary_name,
                ifsc: account.ifsc!,
                accountNumber: accountNumber!.replace(/\s/g, ""),
              },
            }
          : { type: "vpa", address: account.vpa_address! },
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // The previously active account goes first — the partial unique index allows
      // only one active row per caregiver, so this ordering is required, not tidy.
      await tx.nanny_payout_accounts.updateMany({
        where: {
          nanny_id: account.nanny_id,
          status: ACCOUNT_ACTIVE,
          id: { not: accountId },
        },
        data: { status: ACCOUNT_ARCHIVED, updated_at: new Date() },
      });

      return tx.nanny_payout_accounts.update({
        where: { id: accountId },
        data: {
          status: ACCOUNT_ACTIVE,
          razorpay_contact_id: contactId,
          razorpay_fund_account_id: fundAccountId,
          reviewed_by: adminId,
          reviewed_at: new Date(),
          rejection_reason: null,
          updated_at: new Date(),
        },
      });
    });

    await this.audit.logAction({
      adminId,
      action: "APPROVE_PAYOUT_ACCOUNT",
      targetType: "nanny_payout_account",
      targetId: accountId,
      metadata: {
        nannyId: account.nanny_id,
        accountType: account.account_type,
        last4: account.account_number_last4,
        fundAccountId,
      },
      ipAddress,
    });

    await this.notify(
      account.nanny_id,
      "Payout account approved",
      "Your payout account is verified. Future earnings will be sent there.",
      "success",
    );

    return this.toPublicAccount(updated);
  }

  async rejectPayoutAccount(
    accountId: string,
    adminId: string,
    reason: string,
    ipAddress?: string,
  ) {
    if (!reason?.trim()) {
      throw new BadRequestException("A reason is required to reject an account");
    }

    const account = await this.prisma.nanny_payout_accounts.findUnique({
      where: { id: accountId },
      select: { id: true, nanny_id: true, status: true },
    });

    if (!account) throw new NotFoundException("Payout account not found");
    if (account.status !== ACCOUNT_PENDING) {
      throw new BadRequestException("Only accounts awaiting review can be rejected");
    }

    const updated = await this.prisma.nanny_payout_accounts.update({
      where: { id: accountId },
      data: {
        status: ACCOUNT_REJECTED,
        rejection_reason: reason.trim(),
        reviewed_by: adminId,
        reviewed_at: new Date(),
        updated_at: new Date(),
      },
    });

    await this.audit.logAction({
      adminId,
      action: "REJECT_PAYOUT_ACCOUNT",
      targetType: "nanny_payout_account",
      targetId: accountId,
      metadata: { nannyId: account.nanny_id, reason: reason.trim() },
      ipAddress,
    });

    await this.notify(
      account.nanny_id,
      "Payout account needs attention",
      `We could not verify your payout details: ${reason.trim()}. Please submit them again.`,
      "warning",
    );

    return this.toPublicAccount(updated);
  }

  // ─── Releasing money ───────────────────────────────────────────────────────

  /**
   * Settles everything a caregiver is owed in one transfer.
   *
   * Ordering matters and is not incidental:
   *   1. Compute the amount from the same rows the admin ledger showed.
   *   2. Reserve those rows in a transaction — write the payout, its items, and
   *      stamp `released_at` — so a concurrent release cannot claim them too. The
   *      partial unique index on `nanny_payout_items.payment_id` makes that a
   *      database guarantee rather than a hopeful check.
   *   3. Commit, *then* call RazorpayX. A 30-second HTTP call must never be held
   *      open inside a transaction.
   *   4. If the gateway rejects it, unwind — void the items and clear
   *      `released_at`, so the earnings reappear as outstanding instead of
   *      vanishing into a payout that never happened.
   */
  async releasePayoutForNanny(
    nannyId: string,
    adminId: string,
    options: { manual?: boolean; note?: string; ipAddress?: string } = {},
  ) {
    const { percent } = await this.pricing.getCommissionConfig();
    const rate = percent / 100;

    const inFlight = await this.prisma.nanny_payouts.findFirst({
      where: { nanny_id: nannyId, status: { in: IN_FLIGHT_PAYOUT_STATUSES } },
      select: { id: true, status: true, amount: true },
    });
    if (inFlight) {
      throw new ConflictException(
        `A payout of ₹${inFlight.amount} is already ${inFlight.status} for this caregiver. Wait for it to settle before releasing again.`,
      );
    }

    const outstanding = await this.prisma.payments.findMany({
      where: {
        status: PaymentStatus.PENDING_RELEASE,
        released_at: null,
        bookings: { nanny_id: nannyId },
        ...CAREGIVER_SHARE_ONLY,
      },
      select: {
        id: true,
        amount: true,
        price_snapshots: { select: { gst_amount: true } },
        payment_installments: { select: { gst_amount: true } },
      },
      orderBy: { created_at: "asc" },
    });

    if (outstanding.length === 0) {
      throw new NotFoundException("No outstanding payouts for this caregiver");
    }

    const items = outstanding.map((payment) => {
      const gross = preTaxServiceFee(payment);
      return {
        payment_id: payment.id,
        gross_amount: new Prisma.Decimal(round2(gross)),
        amount: new Prisma.Decimal(round2(gross * (1 - rate))),
        commission_percent: new Prisma.Decimal(percent),
      };
    });

    // Sum the rounded shares rather than rounding the sum: the total has to equal
    // what the items say it does, or a payout can never be reconciled against them.
    const amount = round2(
      items.reduce((sum, item) => sum + Number(item.amount), 0),
    );

    if (amount <= 0) {
      throw new BadRequestException(
        "The outstanding balance for this caregiver is zero",
      );
    }

    const account = await this.prisma.nanny_payout_accounts.findFirst({
      where: { nanny_id: nannyId, status: ACCOUNT_ACTIVE },
    });

    // Half-configured is not a reason to quietly settle manually: that would stamp
    // these earnings as paid with no transfer behind them. Refuse and say what is
    // missing. `manual: true` remains the explicit way to record an off-platform
    // settlement, which is a decision rather than an accident.
    if (!options.manual && this.razorpayx.misconfigured()) {
      throw new BadRequestException(
        `RazorpayX is switched on but not fully configured (missing ${this.razorpayx.missingConfig()}). ` +
          "Refusing to record this payout as settled when no money would move. " +
          "Fix the configuration, or release with manual: true to record an off-platform settlement.",
      );
    }

    const useGateway = !options.manual && this.razorpayx.isEnabled();

    if (useGateway && !account?.razorpay_fund_account_id) {
      throw new BadRequestException(
        "This caregiver has no approved payout account. Approve their bank details before releasing.",
      );
    }

    const idempotencyKey = crypto.randomUUID();

    // Reserve the earnings. If a concurrent release grabbed the same payments, the
    // unique index rejects this transaction and nothing is double-claimed.
    let payout;
    try {
      payout = await this.prisma.$transaction(async (tx) => {
        const created = await tx.nanny_payouts.create({
          data: {
            nanny_id: nannyId,
            payout_account_id: account?.id ?? null,
            amount: new Prisma.Decimal(amount),
            status: PAYOUT_CREATED,
            provider: useGateway ? "razorpayx" : "manual",
            razorpay_fund_account_id: account?.razorpay_fund_account_id ?? null,
            idempotency_key: idempotencyKey,
            mode: useGateway ? this.razorpayx.payoutMode : null,
            notes: options.note ?? null,
            initiated_by: adminId,
          },
        });

        await tx.nanny_payout_items.createMany({
          data: items.map((item) => ({ ...item, payout_id: created.id })),
        });

        await tx.payments.updateMany({
          where: { id: { in: outstanding.map((p) => p.id) } },
          data: { released_at: new Date(), released_by: adminId },
        });

        return created;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException(
          "Some of these earnings are already part of another payout. Refresh and try again.",
        );
      }
      throw error;
    }

    // Off-platform settlement: recorded so the ledger balances, no money moved here.
    if (!useGateway) {
      const settled = await this.prisma.nanny_payouts.update({
        where: { id: payout.id },
        data: { status: PAYOUT_PROCESSED, processed_at: new Date() },
      });

      await this.auditRelease(adminId, nannyId, settled.id, amount, items.length, "manual", options.ipAddress);
      await this.notifyPaid(nannyId, amount, null);
      return this.toPublicPayout(settled);
    }

    // Outside the transaction, deliberately. See the method comment.
    try {
      const entity = await this.razorpayx.createPayout({
        fundAccountId: account!.razorpay_fund_account_id!,
        amountPaise: Math.round(amount * 100),
        idempotencyKey,
        referenceId: payout.id,
        narration: "Keel caregiver payout",
        notes: { nanny_id: nannyId, payout_id: payout.id },
      });

      const updated = await this.prisma.nanny_payouts.update({
        where: { id: payout.id },
        data: {
          razorpay_payout_id: entity.id,
          status: entity.status,
          mode: entity.mode ?? this.razorpayx.payoutMode,
          reference_id: entity.reference_id ?? payout.id,
          utr: entity.utr ?? null,
          processed_at: entity.status === PAYOUT_PROCESSED ? new Date() : null,
        },
      });

      await this.auditRelease(adminId, nannyId, payout.id, amount, items.length, entity.id, options.ipAddress);

      if (entity.status === PAYOUT_PROCESSED) {
        await this.notifyPaid(nannyId, amount, entity.utr ?? null);
      }

      return this.toPublicPayout(updated);
    } catch (error: any) {
      const reason = error?.message ?? "Payout could not be created";
      this.logger.error(
        `RazorpayX rejected payout ${payout.id} for caregiver ${nannyId}: ${reason}`,
      );

      await this.unwind(payout.id, reason);

      throw new BadRequestException(
        `Payout failed: ${reason}. The caregiver's earnings remain outstanding.`,
      );
    }
  }

  // ─── Status transitions ────────────────────────────────────────────────────

  /**
   * The one place a payout changes state, shared by the webhook and the
   * reconciliation sweep — so a status arriving twice, or by both routes, lands the
   * same way.
   *
   * Idempotent by refusing to leave a terminal state: a replayed `payout.processed`
   * cannot re-notify the caregiver, and a late-arriving `processing` cannot undo a
   * failure that already put her earnings back on the outstanding list.
   */
  async applyPayoutStatus(
    payoutId: string,
    entity: Pick<
      RazorpayxPayoutEntity,
      "status" | "utr" | "fees" | "tax" | "mode" | "failure_reason" | "status_details"
    >,
  ) {
    const payout = await this.prisma.nanny_payouts.findUnique({
      where: { id: payoutId },
      select: { id: true, nanny_id: true, status: true, amount: true },
    });

    if (!payout) {
      this.logger.warn(`Payout status update for unknown payout ${payoutId}`);
      return { applied: false, reason: "unknown_payout" };
    }

    if (TERMINAL_PAYOUT_STATUSES.includes(payout.status)) {
      return { applied: false, reason: "already_terminal" };
    }
    if (payout.status === entity.status) {
      return { applied: false, reason: "unchanged" };
    }

    const reason =
      entity.failure_reason ??
      entity.status_details?.description ??
      entity.status_details?.reason ??
      null;

    if (PAYOUT_UNWOUND_STATUSES.includes(entity.status)) {
      await this.unwind(payoutId, reason ?? `Payout ${entity.status}`, entity.status);
      await this.notify(
        payout.nanny_id,
        "Payout could not be completed",
        `Your payout of ₹${payout.amount} did not go through${reason ? ` (${reason})` : ""}. It is back in your pending earnings and we are looking into it.`,
        "error",
      );
      return { applied: true, status: entity.status };
    }

    await this.prisma.nanny_payouts.update({
      where: { id: payoutId },
      data: {
        status: entity.status,
        utr: entity.utr ?? undefined,
        mode: entity.mode ?? undefined,
        // Paise on the wire, rupees in our ledger.
        fees: entity.fees != null ? new Prisma.Decimal(entity.fees / 100) : undefined,
        tax: entity.tax != null ? new Prisma.Decimal(entity.tax / 100) : undefined,
        failure_reason: reason ?? undefined,
        processed_at: entity.status === PAYOUT_PROCESSED ? new Date() : undefined,
        updated_at: new Date(),
      },
    });

    if (entity.status === PAYOUT_PROCESSED) {
      await this.notifyPaid(payout.nanny_id, Number(payout.amount), entity.utr ?? null);
    }

    return { applied: true, status: entity.status };
  }

  /** Webhook entry point. The signature is verified by the controller. */
  async handlePayoutWebhook(payload: any) {
    const entity: RazorpayxPayoutEntity | undefined =
      payload?.payload?.payout?.entity;

    if (!entity?.id) {
      this.logger.warn(`Payout webhook ${payload?.event} carried no payout entity`);
      return { status: "ignored" };
    }

    // `reference_id` is the local payout id we sent on creation, so it resolves even
    // when the webhook beats our own record of `razorpay_payout_id` — which happens:
    // RazorpayX can deliver before the create call's response lands.
    const payout = await this.prisma.nanny_payouts.findFirst({
      where: {
        OR: [
          { razorpay_payout_id: entity.id },
          { reference_id: entity.id },
          ...(entity.reference_id ? [{ id: entity.reference_id }] : []),
        ],
      },
      select: { id: true, razorpay_payout_id: true },
    });

    if (!payout) {
      this.logger.warn(`Payout webhook for unrecognised payout ${entity.id}`);
      return { status: "unknown_payout" };
    }

    if (!payout.razorpay_payout_id) {
      await this.prisma.nanny_payouts.update({
        where: { id: payout.id },
        data: { razorpay_payout_id: entity.id },
      });
    }

    const result = await this.applyPayoutStatus(payout.id, entity);
    return { status: result.applied ? "processed" : result.reason };
  }

  /**
   * Refetches a payout from RazorpayX and applies whatever it says.
   *
   * Webhooks get missed — dropped deliveries, deploys, an endpoint that 500s once.
   * Money does not get to be lost that way, so this runs on a schedule as well as
   * on demand from the admin app.
   */
  async syncPayout(payoutId: string) {
    const payout = await this.prisma.nanny_payouts.findUnique({
      where: { id: payoutId },
      select: { id: true, razorpay_payout_id: true, status: true },
    });

    if (!payout) throw new NotFoundException("Payout not found");
    if (!payout.razorpay_payout_id) {
      return { applied: false, reason: "no_gateway_payout" };
    }
    if (TERMINAL_PAYOUT_STATUSES.includes(payout.status)) {
      return { applied: false, reason: "already_terminal" };
    }

    const entity = await this.razorpayx.fetchPayout(payout.razorpay_payout_id);
    return this.applyPayoutStatus(payout.id, entity);
  }

  /** Reconciliation sweep. Called by the cron; see `syncPayout`. */
  async reconcileStalePayouts(olderThanMinutes = 15) {
    if (!this.razorpayx.isEnabled()) return { checked: 0, updated: 0 };

    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
    const stale = await this.prisma.nanny_payouts.findMany({
      where: {
        provider: "razorpayx",
        status: { in: IN_FLIGHT_PAYOUT_STATUSES },
        razorpay_payout_id: { not: null },
        updated_at: { lt: cutoff },
      },
      select: { id: true },
      take: 100,
    });

    let updated = 0;
    for (const row of stale) {
      try {
        const result = await this.syncPayout(row.id);
        if (result.applied) updated += 1;
      } catch (error: any) {
        // One unreachable payout must not stop the sweep reaching the rest.
        this.logger.error(
          `Could not reconcile payout ${row.id}: ${error?.message}`,
        );
      }
    }

    return { checked: stale.length, updated };
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────

  async listPayoutsForNanny(nannyId: string, page = 1, pageSize = 20) {
    const [rows, total] = await Promise.all([
      this.prisma.nanny_payouts.findMany({
        where: { nanny_id: nannyId },
        orderBy: { created_at: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { _count: { select: { items: true } } },
      }),
      this.prisma.nanny_payouts.count({ where: { nanny_id: nannyId } }),
    ]);

    return {
      items: rows.map((row) => ({
        ...this.toPublicPayout(row),
        sessionCount: row._count.items,
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize) || 1,
      },
    };
  }

  async listPayouts(query: {
    nannyId?: string;
    status?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.nanny_payoutsWhereInput = {
      ...(query.nannyId ? { nanny_id: query.nannyId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.nanny_payouts.findMany({
        where,
        orderBy: { created_at: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          nanny: {
            select: {
              id: true,
              email: true,
              profiles: { select: { first_name: true, last_name: true } },
            },
          },
          _count: { select: { items: true } },
        },
      }),
      this.prisma.nanny_payouts.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        ...this.toPublicPayout(row),
        sessionCount: row._count.items,
        nanny: {
          id: row.nanny.id,
          name:
            [row.nanny.profiles?.first_name, row.nanny.profiles?.last_name]
              .filter(Boolean)
              .join(" ") || row.nanny.email,
          email: row.nanny.email,
        },
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize) || 1,
      },
    };
  }

  /**
   * Payout readiness for a set of caregivers, keyed by id — so the admin ledger can
   * show whether a Release button will work before it is pressed, in one query
   * rather than one per row.
   */
  async payoutReadinessFor(nannyIds: string[]) {
    if (nannyIds.length === 0) return new Map<string, PayoutReadiness>();

    const [accounts, inFlight] = await Promise.all([
      this.prisma.nanny_payout_accounts.findMany({
        where: {
          nanny_id: { in: nannyIds },
          status: { in: [ACCOUNT_ACTIVE, ACCOUNT_PENDING] },
        },
      }),
      this.prisma.nanny_payouts.findMany({
        where: {
          nanny_id: { in: nannyIds },
          status: { in: IN_FLIGHT_PAYOUT_STATUSES },
        },
        select: { id: true, nanny_id: true, status: true },
      }),
    ]);

    const readiness = new Map<string, PayoutReadiness>();

    for (const account of accounts) {
      const existing = readiness.get(account.nanny_id);
      // Active wins over pending when both exist.
      if (existing?.payoutAccount?.status === ACCOUNT_ACTIVE) continue;
      readiness.set(account.nanny_id, {
        payoutAccount: this.toPublicAccount(account),
        payoutReady: account.status === ACCOUNT_ACTIVE,
        inFlightPayoutId: null,
      });
    }

    for (const payout of inFlight) {
      const existing = readiness.get(payout.nanny_id) ?? {
        payoutAccount: null,
        payoutReady: false,
        inFlightPayoutId: null,
      };
      existing.inFlightPayoutId = payout.id;
      // A payout already on its way makes the caregiver un-releasable regardless of
      // how good her account is.
      existing.payoutReady = false;
      readiness.set(payout.nanny_id, existing);
    }

    return readiness;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * Voids a payout's claim on its earnings and puts them back on the outstanding
   * list. The items survive with `voided_at` set, so the attempt stays auditable
   * while the partial unique index lets the payments be claimed again.
   */
  private async unwind(payoutId: string, reason: string, status = "failed") {
    await this.prisma.$transaction(async (tx) => {
      const items = await tx.nanny_payout_items.findMany({
        where: { payout_id: payoutId, voided_at: null },
        select: { payment_id: true },
      });

      const now = new Date();

      await tx.nanny_payout_items.updateMany({
        where: { payout_id: payoutId, voided_at: null },
        data: { voided_at: now },
      });

      if (items.length > 0) {
        await tx.payments.updateMany({
          where: { id: { in: items.map((i) => i.payment_id) } },
          data: { released_at: null, released_by: null },
        });
      }

      await tx.nanny_payouts.update({
        where: { id: payoutId },
        data: {
          status,
          failure_reason: reason.slice(0, 500),
          updated_at: now,
        },
      });
    });
  }

  private async existingContactId(nannyId: string): Promise<string | null> {
    const row = await this.prisma.nanny_payout_accounts.findFirst({
      where: { nanny_id: nannyId, razorpay_contact_id: { not: null } },
      select: { razorpay_contact_id: true },
      orderBy: { created_at: "desc" },
    });
    return row?.razorpay_contact_id ?? null;
  }

  private async auditRelease(
    adminId: string,
    nannyId: string,
    payoutId: string,
    amount: number,
    itemCount: number,
    gatewayRef: string,
    ipAddress?: string,
  ) {
    await this.audit.logAction({
      adminId,
      action: "RELEASE_PAYOUT_BATCH",
      targetType: "user",
      targetId: nannyId,
      metadata: { payoutId, amount, payments: itemCount, gatewayRef },
      ipAddress,
    });
  }

  private async notifyPaid(nannyId: string, amount: number, utr: string | null) {
    await this.notify(
      nannyId,
      "Payout sent",
      `₹${amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} is on its way to your account${utr ? `. Reference: ${utr}` : ""}.`,
      "success",
    );
  }

  /** Notification failures must never roll back money that already moved. */
  private async notify(
    userId: string,
    title: string,
    message: string,
    type: "info" | "success" | "warning" | "error",
  ) {
    try {
      await this.notifications.createNotification(
        userId,
        title,
        message,
        type,
        "payout",
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to notify ${userId} about a payout: ${error?.message}`,
      );
    }
  }

  private toPublicAccount(account: PayoutAccountRow): PublicPayoutAccount {
    return {
      id: account.id,
      accountType: account.account_type as "bank_account" | "vpa",
      beneficiaryName: account.beneficiary_name,
      last4: account.account_number_last4,
      ifsc: account.ifsc,
      vpaAddress: account.vpa_address,
      status: account.status,
      rejectionReason: account.rejection_reason,
      payable:
        account.status === ACCOUNT_ACTIVE &&
        Boolean(account.razorpay_fund_account_id),
      createdAt: account.created_at.toISOString(),
      reviewedAt: account.reviewed_at?.toISOString() ?? null,
    };
  }

  private toPublicPayout(payout: {
    id: string;
    amount: Prisma.Decimal;
    currency: string;
    status: string;
    provider: string;
    mode: string | null;
    utr: string | null;
    failure_reason: string | null;
    razorpay_payout_id: string | null;
    processed_at: Date | null;
    created_at: Date;
  }) {
    return {
      id: payout.id,
      amount: Number(payout.amount),
      currency: payout.currency,
      status: payout.status,
      provider: payout.provider,
      mode: payout.mode as PayoutMode | null,
      utr: payout.utr,
      failureReason: payout.failure_reason,
      gatewayPayoutId: payout.razorpay_payout_id,
      processedAt: payout.processed_at?.toISOString() ?? null,
      createdAt: payout.created_at.toISOString(),
    };
  }
}
