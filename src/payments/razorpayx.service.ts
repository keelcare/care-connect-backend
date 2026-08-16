import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios, { AxiosInstance } from "axios";
import * as crypto from "node:crypto";

/**
 * Transport for RazorpayX, the outbound (payout) half of Razorpay.
 *
 * Deliberately not built on the `razorpay` npm SDK, which `PaymentGatewayService`
 * uses for the inbound half. Two reasons, both hard blockers rather than taste:
 *
 *   1. The installed SDK (v2.9.6) ships no `payouts` or `contacts` resource at all.
 *   2. Create Payout requires the `X-Payout-Idempotency` header, and the SDK gives
 *      no way to set per-request headers. Without it RazorpayX rejects the call —
 *      the header has been mandatory since 15 March 2025.
 *
 * So: plain HTTP against the same REST API the SDK wraps.
 */

export type PayoutMode = "IMPS" | "NEFT" | "RTGS" | "UPI";

/** RazorpayX's own payout life cycle, plus `created` which is ours (pre-gateway). */
export type RazorpayxPayoutStatus =
  | "queued"
  | "pending"
  | "rejected"
  | "processing"
  | "processed"
  | "cancelled"
  | "reversed"
  | "failed";

export interface RazorpayxPayoutEntity {
  id: string;
  entity: "payout";
  fund_account_id: string;
  amount: number; // paise
  currency: string;
  status: RazorpayxPayoutStatus;
  mode?: PayoutMode;
  utr?: string | null;
  reference_id?: string | null;
  narration?: string | null;
  fees?: number | null; // paise
  tax?: number | null; // paise
  failure_reason?: string | null;
  status_details?: {
    description?: string;
    source?: string;
    reason?: string;
  } | null;
  created_at?: number;
}

export interface BankAccountDetails {
  name: string;
  ifsc: string;
  accountNumber: string;
}

@Injectable()
export class RazorpayxService {
  private readonly logger = new Logger(RazorpayxService.name);
  private readonly http: AxiosInstance | null = null;
  private readonly accountNumber: string;
  private readonly enabled: boolean;
  private readonly defaultMode: PayoutMode;
  private readonly purpose: string;

  constructor(private readonly config: ConfigService) {
    // A single Razorpay merchant account often issues one key pair covering both
    // Payments and X, so the payments keys are the fallback rather than a separate
    // required pair. Set the X-specific ones only when they genuinely differ.
    const keyId =
      this.config.get<string>("RAZORPAYX_KEY_ID") ??
      this.config.get<string>("RAZORPAY_KEY_ID");
    const keySecret =
      this.config.get<string>("RAZORPAYX_KEY_SECRET") ??
      this.config.get<string>("RAZORPAY_KEY_SECRET");

    this.accountNumber =
      this.config.get<string>("RAZORPAYX_ACCOUNT_NUMBER") ?? "";
    this.defaultMode = (this.config.get<string>("RAZORPAYX_PAYOUT_MODE") ??
      "IMPS") as PayoutMode;
    this.purpose = this.config.get<string>("RAZORPAYX_PAYOUT_PURPOSE") ?? "payout";

    // Explicit opt-in rather than "configured means live". Payouts move real money
    // out of the business account, and inheriting the payments keys means the
    // credentials are very likely already present in every environment. Requiring a
    // separate flag is what stops a staging box with a copied .env from paying real
    // caregivers.
    const flag = this.config.get<string>("RAZORPAYX_ENABLED");
    this.enabled = flag === "true" || flag === "1";

    if (!keyId || !keySecret) {
      this.logger.warn(
        "RazorpayX credentials not set. Payouts will fall back to manual (bookkeeping-only) settlement.",
      );
      return;
    }

    this.http = axios.create({
      baseURL: "https://api.razorpay.com/v1",
      auth: { username: keyId, password: keySecret },
      headers: { "Content-Type": "application/json" },
      timeout: 30_000,
    });

    if (!this.enabled) {
      this.logger.warn(
        "RAZORPAYX_ENABLED is not true. Payouts are recorded but no money is moved.",
      );
    } else if (!this.accountNumber) {
      this.logger.error(
        "RAZORPAYX_ENABLED is true but RAZORPAYX_ACCOUNT_NUMBER is missing. " +
          "Payouts will be refused rather than silently recorded as settled.",
      );
    } else {
      this.logger.log("RazorpayX payouts are live.");
    }
  }

  /** Credentials present — the API can be called at all. */
  isConfigured(): boolean {
    return this.http !== null;
  }

  /**
   * Safe to actually move money: credentials, the business account number, and the
   * explicit enable flag. Anything less and the caller settles manually instead.
   */
  isEnabled(): boolean {
    return this.isConfigured() && this.enabled && Boolean(this.accountNumber);
  }

  /**
   * The operator asked for live payouts but the configuration cannot deliver them.
   *
   * This is deliberately not folded into `isEnabled()` returning false. Falling back
   * to a manual settlement here would mark a caregiver's earnings as paid when
   * nothing left the bank — the one outcome this whole feature exists to prevent.
   * Someone who set RAZORPAYX_ENABLED=true wants a transfer, so a missing account
   * number has to be a loud failure, not a quiet downgrade.
   */
  misconfigured(): boolean {
    return this.enabled && !this.isEnabled();
  }

  /** What is missing, for an error message an operator can act on. */
  missingConfig(): string {
    const missing: string[] = [];
    if (!this.isConfigured()) missing.push("RAZORPAYX_KEY_ID / RAZORPAYX_KEY_SECRET");
    if (!this.accountNumber) missing.push("RAZORPAYX_ACCOUNT_NUMBER");
    return missing.join(" and ");
  }

  get payoutMode(): PayoutMode {
    return this.defaultMode;
  }

  // ─── Contacts & fund accounts ──────────────────────────────────────────────

  /**
   * A contact is the person; a fund account is one of their destinations. Both are
   * created only once an admin has approved the details, so a rejected or
   * mistyped submission never leaves orphans on RazorpayX.
   */
  async createContact(input: {
    name: string;
    email?: string | null;
    phone?: string | null;
    referenceId: string;
  }): Promise<string> {
    const data = await this.request<{ id: string }>("post", "/contacts", {
      name: input.name,
      email: input.email || undefined,
      contact: input.phone || undefined,
      type: "employee",
      reference_id: input.referenceId,
    });
    return data.id;
  }

  /**
   * Fund accounts are immutable on RazorpayX — there is no edit. Changed bank
   * details always mean a new fund account, which is exactly why the local account
   * table archives rows instead of updating them.
   */
  async createFundAccount(
    contactId: string,
    destination:
      | { type: "bank_account"; bank: BankAccountDetails }
      | { type: "vpa"; address: string },
  ): Promise<string> {
    const body =
      destination.type === "bank_account"
        ? {
            contact_id: contactId,
            account_type: "bank_account",
            bank_account: {
              name: destination.bank.name,
              ifsc: destination.bank.ifsc,
              account_number: destination.bank.accountNumber,
            },
          }
        : {
            contact_id: contactId,
            account_type: "vpa",
            vpa: { address: destination.address },
          };

    const data = await this.request<{ id: string }>(
      "post",
      "/fund_accounts",
      body,
    );
    return data.id;
  }

  // ─── Payouts ───────────────────────────────────────────────────────────────

  /**
   * `idempotencyKey` must be the *same* value on every retry of the same payout —
   * it is stored on the payout row for exactly that reason. RazorpayX returns the
   * original payout instead of creating a second one, which is the only thing
   * standing between a network timeout and paying a caregiver twice.
   *
   * Retrying with the same key but a changed body is a BAD_REQUEST, so the amount
   * must never be recomputed between attempts. It is frozen on the row.
   */
  async createPayout(input: {
    fundAccountId: string;
    amountPaise: number;
    idempotencyKey: string;
    referenceId: string;
    narration: string;
    mode?: PayoutMode;
    notes?: Record<string, string>;
  }): Promise<RazorpayxPayoutEntity> {
    if (!this.accountNumber) {
      throw new BadRequestException(
        "RAZORPAYX_ACCOUNT_NUMBER is not configured",
      );
    }

    return this.request<RazorpayxPayoutEntity>(
      "post",
      "/payouts",
      {
        account_number: this.accountNumber,
        fund_account_id: input.fundAccountId,
        amount: input.amountPaise,
        currency: "INR",
        mode: input.mode ?? this.defaultMode,
        purpose: this.purpose,
        // Insufficient balance parks the payout as `queued` instead of failing it.
        // Preferable: the obligation stays live and settles when the account is
        // funded, rather than silently needing a human to notice and re-release.
        queue_if_low_balance: true,
        reference_id: input.referenceId,
        // RazorpayX truncates narration to 30 characters on some rails.
        narration: input.narration.slice(0, 30),
        notes: input.notes,
      },
      { "X-Payout-Idempotency": input.idempotencyKey },
    );
  }

  async fetchPayout(payoutId: string): Promise<RazorpayxPayoutEntity> {
    return this.request<RazorpayxPayoutEntity>("get", `/payouts/${payoutId}`);
  }

  // ─── Webhooks ──────────────────────────────────────────────────────────────

  /**
   * Verified against the **raw** request bytes, not a re-serialised object.
   *
   * `PaymentGatewayService.verifyWebhookSignature` hashes `JSON.stringify(payload)`,
   * which only holds while Express' parse and Node's stringify happen to round-trip
   * Razorpay's exact bytes — key order, unicode escaping and number formatting all
   * have to survive. That is luck, not a guarantee, and here it would mean either
   * rejecting genuine payout updates or, worse, tempting someone to skip the check.
   */
  verifyWebhookSignature(rawBody: Buffer | string, signature: string): boolean {
    const secret = this.config.get<string>("RAZORPAYX_WEBHOOK_SECRET");
    if (!secret || !signature) return false;

    const digest = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    // Constant-time: a length mismatch would throw, so guard it first.
    const expected = Buffer.from(digest, "utf8");
    const received = Buffer.from(signature, "utf8");
    if (expected.length !== received.length) return false;
    return crypto.timingSafeEqual(expected, received);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async request<T>(
    method: "get" | "post",
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    if (!this.http) {
      throw new BadRequestException("RazorpayX is not configured");
    }

    try {
      const response = await this.http.request<T>({
        method,
        url: path,
        data: body,
        headers,
      });
      return response.data;
    } catch (error: any) {
      const gatewayError = error?.response?.data?.error;
      const description =
        gatewayError?.description ?? error?.message ?? "RazorpayX request failed";

      this.logger.error(
        `RazorpayX ${method.toUpperCase()} ${path} failed: ${description}`,
        gatewayError ? JSON.stringify(gatewayError) : undefined,
      );

      throw new BadRequestException(description);
    }
  }
}
