import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  apportion,
  calculatePrice,
  isSplittable,
  planInstalments,
  resolveDaysPerWeek,
  splitAmount,
  weeksInCycleFor,
  ADVANCE_PAYMENT_PERCENT,
  SPLIT_INSTALMENT_COUNT,
  PriceBreakdown,
  PriceInput,
  PricingMode,
} from './utils/pricing.utils';

/** `payment_installments.kind` for the one-off placement fee. */
export const MATCHING_FEE_KIND = 'matching_fee';

export interface QuoteInput {
  serviceId: string;
  hoursPerDay: number;
  daysPerWeek: number;
  planDurationMonths: number;
  pricingMode?: PricingMode;
  customHourlyRate?: number;
  customFinalPrice?: number;
  /** If provided, resolves rate card as-of this date. Defaults to now() */
  asOf?: Date;
  planType?: string;
}

export interface GstConfig {
  enabled: boolean;
  percent: number;
}

/** The statutory rate. Used when GST_PERCENT is unset or unparseable. */
const DEFAULT_GST_PERCENT = 18;

export interface CommissionConfig {
  percent: number;
  /** False when no rate has ever been set — surfaced so admin UI can prompt for one. */
  configured: boolean;
}

/**
 * Key in `system_settings` holding the platform take rate, as `{ percent: 5 }`.
 *
 * The rate lives in the database, not in env, because an admin can change it from
 * the dashboard and both the caregiver app and the revenue ledger have to move at
 * the same instant. There is no per-payment commission column: the rate is applied
 * at read time, so changing it re-states historical margin. That is deliberate —
 * the platform bills one rate-card price and the split is internal accounting.
 */
export const COMMISSION_SETTING_KEY = 'platform_commission_percent';

/** Days after the advance is paid that the balance half falls due. */
export const ADVANCE_PAYMENT_DAYS_KEY = 'advance_payment_due_days';

/** Kill switch: turn split payments off without a redeploy. */
export const SPLIT_PAYMENTS_ENABLED_KEY = 'split_payments_enabled';

/**
 * One-off fee for placing a caregiver, as `{ enabled: boolean, amount: 500 }`.
 *
 * Charged when a caregiver is assigned and *carved out of* the booking's total
 * rather than added to it: the parent's all-in cost is unchanged, the fee is
 * simply the first thing they pay. A plan pays it once, on its first cycle, not
 * every month.
 *
 * Off unless an admin turns it on — unlike split payments, this is a charge, and
 * a missing row must never invent one.
 */
export const MATCHING_FEE_KEY = 'matching_fee';

/** A fee at or above a whole cycle would leave nothing to bill. */
const MAX_MATCHING_FEE = 100000;

export interface MatchingFeeConfig {
  enabled: boolean;
  /** Rupees, tax-inclusive — it is carved out of an already-taxed total. */
  amount: number;
}

/** Two weeks, the terms we advertise before an admin narrows them. */
const DEFAULT_ADVANCE_PAYMENT_DAYS = 14;

/** A window under a day cannot be met; over a quarter is not a deferral. */
const MIN_ADVANCE_PAYMENT_DAYS = 1;
const MAX_ADVANCE_PAYMENT_DAYS = 90;

export interface AdvancePaymentConfig {
  /** Whether new cycles are split at all. */
  enabled: boolean;
  /** Share taken at checkout. Fixed by policy. */
  ratioPercent: number;
  /** Days from the advance being paid to the balance falling due. */
  dueDays: number;
}

export interface CycleChargeInput {
  bookingId: string;
  cycleNumber: number;
  paymentPlanId?: string;
}

@Injectable()
export class PricingEngineService {
  private readonly logger = new Logger(PricingEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // ─── GST ──────────────────────────────────────────────────────────────────────

  /**
   * The GST policy currently in force. Read on every calculation rather than
   * cached at construction so flipping the flag takes effect on the next
   * process restart without any stale-cache surprises.
   */
  getGstConfig(): GstConfig {
    const enabled = this.config.get<string>('GST_ENABLED') === 'true';

    // A blank or malformed GST_PERCENT must not silently resolve to 0% while the
    // flag says enabled — that would quietly stop collecting tax we owe.
    const raw = this.config.get<string>('GST_PERCENT');
    const parsed = raw == null || raw.trim() === '' ? NaN : Number(raw);
    const percent = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GST_PERCENT;

    return { enabled, percent };
  }

  /** The rate to hand the pure calculator: the configured rate, or 0 when off. */
  private effectiveGstPercent(): number {
    const { enabled, percent } = this.getGstConfig();
    return enabled ? percent : 0;
  }

  // ─── Commission ───────────────────────────────────────────────────────────────

  /**
   * The platform commission in force, as a percentage of the caregiver's pre-tax
   * service fee. This is the *only* place the rate is resolved — the caregiver
   * earnings endpoints and the admin revenue ledger both call it, so a rate change
   * can never leave one side quoting a number the other contradicts.
   *
   * An unconfigured or malformed setting resolves to 0%, never to a guess: inventing
   * a rate would quietly take money off a caregiver's payout that no admin ever set.
   * `configured: false` lets the admin dashboard prompt for one instead.
   */
  async getCommissionConfig(): Promise<CommissionConfig> {
    const row = await this.prisma.system_settings.findUnique({
      where: { key: COMMISSION_SETTING_KEY },
    });

    if (!row) return { percent: 0, configured: false };

    const value = row.value as { percent?: unknown } | number | null;
    const percent =
      typeof value === 'number' ? value : Number((value as { percent?: unknown })?.percent);

    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      this.logger.warn(
        `${COMMISSION_SETTING_KEY} is set to an unusable value; treating as unconfigured (0%).`,
      );
      return { percent: 0, configured: false };
    }

    return { percent, configured: true };
  }

  // ─── Split payments ───────────────────────────────────────────────────────────

  /**
   * The advance/balance terms currently in force.
   *
   * Note where this deliberately differs from `getCommissionConfig`: an unset
   * commission resolves to 0% rather than a guess, because inventing a rate would
   * take money off a caregiver no admin ever authorised. An unset *deferral window*
   * has no such hazard — a missing window cannot overcharge anyone, it only decides
   * how long a parent has to pay the balance — so it falls back to the 14 days we
   * advertise rather than refusing to split.
   *
   * Accepts the value as either a bare number or `{ days }` / `{ enabled }`: the
   * admin settings screen writes raw scalars while the commission key uses an
   * object, and a payment path must not break on which one an admin used.
   */
  async getAdvancePaymentConfig(): Promise<AdvancePaymentConfig> {
    const [daysRow, enabledRow] = await Promise.all([
      this.prisma.system_settings.findUnique({ where: { key: ADVANCE_PAYMENT_DAYS_KEY } }),
      this.prisma.system_settings.findUnique({ where: { key: SPLIT_PAYMENTS_ENABLED_KEY } }),
    ]);

    const rawDays = this.unwrapSetting(daysRow?.value, 'days');
    const parsedDays = Number(rawDays);
    const usable =
      Number.isFinite(parsedDays) &&
      parsedDays >= MIN_ADVANCE_PAYMENT_DAYS &&
      parsedDays <= MAX_ADVANCE_PAYMENT_DAYS;

    if (daysRow && !usable) {
      this.logger.warn(
        `${ADVANCE_PAYMENT_DAYS_KEY} is set to an unusable value; falling back to ${DEFAULT_ADVANCE_PAYMENT_DAYS} days.`,
      );
    }

    // Absent means on: the feature is the default billing behaviour, and the key
    // exists to switch it *off* in a hurry rather than to opt in.
    const rawEnabled = this.unwrapSetting(enabledRow?.value, 'enabled');
    const enabled = rawEnabled == null ? true : rawEnabled !== false && rawEnabled !== 'false';

    return {
      enabled,
      ratioPercent: ADVANCE_PAYMENT_PERCENT,
      dueDays: usable ? Math.round(parsedDays) : DEFAULT_ADVANCE_PAYMENT_DAYS,
    };
  }

  /**
   * The matching fee currently in force.
   *
   * Defaults to *off*: an absent or malformed row means no fee, never a guessed
   * one. A fee configured as zero or negative is also treated as off, so the
   * amount that reaches the installment split is always something chargeable.
   */
  async getMatchingFeeConfig(): Promise<MatchingFeeConfig> {
    const row = await this.prisma.system_settings.findUnique({
      where: { key: MATCHING_FEE_KEY },
    });
    if (!row) return { enabled: false, amount: 0 };

    const rawEnabled = this.unwrapSetting(row.value, 'enabled');
    const amount = Number(this.unwrapSetting(row.value, 'amount'));

    const usable = Number.isFinite(amount) && amount > 0 && amount <= MAX_MATCHING_FEE;
    if (!usable && rawEnabled === true) {
      this.logger.warn(
        `${MATCHING_FEE_KEY} is enabled with an unusable amount; charging no fee.`,
      );
    }

    // Enabled must be explicit. `rawEnabled == null` here means someone wrote an
    // amount without switching the fee on — that is not consent to bill it.
    const enabled = rawEnabled === true || rawEnabled === 'true';

    return {
      enabled: enabled && usable,
      amount: enabled && usable ? Math.round(amount * 100) / 100 : 0,
    };
  }

  /** Read a setting written either as a bare scalar or wrapped as `{ [field]: value }`. */
  private unwrapSetting(value: unknown, field: string): unknown {
    if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      return (value as Record<string, unknown>)[field];
    }
    return value;
  }

  // ─── Reference-data cache ─────────────────────────────────────────────────────
  // services / rate_cards are near-static reference data but are looked up once
  // per booking when enriching list endpoints (getBookingsByParent, admin queues,
  // etc.). Caching them turns an N+1 into a handful of queries per request cycle.
  private readonly cache = new Map<string, { value: any; expires: number }>();
  private static readonly REF_TTL_MS = 60_000;

  private async cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as T;
    const value = await loader();
    this.cache.set(key, { value, expires: Date.now() + PricingEngineService.REF_TTL_MS });
    return value;
  }

  private serviceByName(name: string) {
    return this.cached(`svc:name:${name}`, () =>
      this.prisma.services.findFirst({ where: { name } }),
    );
  }

  private serviceById(id: string) {
    return this.cached(`svc:id:${id}`, () =>
      this.prisma.services.findUnique({ where: { id } }),
    );
  }

  // ─── Rate Card Resolution ────────────────────────────────────────────────────

  /**
   * Fetch the rate card for a service that was effective at the given date.
   * Returns the most recent card whose effective_from <= asOf AND
   * (effective_to is null OR effective_to > asOf).
   */
  async getEffectiveRateCard(serviceId: string, asOf?: Date) {
    const at = asOf ?? new Date();

    // Cache only the "current" lookup (no explicit asOf). Historical/as-of
    // resolutions bypass the cache since their effective window is date-specific.
    const loadCard = () =>
      this.prisma.rate_cards.findFirst({
        where: {
          service_id: serviceId,
          effective_from: { lte: at },
          OR: [{ effective_to: null }, { effective_to: { gt: at } }],
        },
        orderBy: { effective_from: 'desc' },
      });

    const card = asOf
      ? await loadCard()
      : await this.cached(`ratecard:current:${serviceId}`, loadCard);

    if (!card) {
      throw new NotFoundException(
        `No rate card found for service ${serviceId} as of ${at.toISOString()}`,
      );
    }

    return card;
  }

  /**
   * The standard hourly rate a booking would be charged at, or `null` when it
   * cannot be resolved (unknown service category, or no rate card covering the
   * booking's effective date).
   *
   * Used to value work that has not been charged yet — a session still ahead on the
   * calendar has no price snapshot to read a rate off. Honours `price_lock_mode`
   * through `resolveRateCardAsOf`, so a locked booking is valued at the rate it was
   * locked to and not at whatever the rate card says today.
   *
   * Returns null rather than throwing: a projection is a nice-to-have on a screen
   * whose primary figures must still render, so an unpriceable booking is dropped
   * from the estimate instead of failing the whole request.
   */
  async resolveStandardHourlyRate(booking: {
    created_at: Date | null;
    price_lock_mode: string;
    service_requests: { category: string | null } | null;
  }): Promise<number | null> {
    const category = booking.service_requests?.category;
    if (!category) return null;

    const service = await this.serviceByName(category);
    if (!service) return null;

    try {
      const card = await this.getEffectiveRateCard(
        service.id,
        this.resolveRateCardAsOf(booking),
      );
      return Number(card.hourly_rate);
    } catch {
      // getEffectiveRateCard throws when no card covers the date.
      return null;
    }
  }

  /**
   * Resolve the rate-card timestamp to use for a booking based on its price_lock_mode:
   * - 'locked'         → pin to booking creation date (rate never changes)
   * - 'follow_current' → use now() (rate floats with current rate card)
   */
  resolveRateCardAsOf(booking: {
    created_at: Date | null;
    price_lock_mode: string;
  }): Date {
    if (booking.price_lock_mode === 'follow_current') {
      return new Date();
    }
    // Default: 'locked'
    return booking.created_at ?? new Date();
  }

  // ─── Quote Preview (no DB writes) ────────────────────────────────────────────

  /**
   * Calculate a price preview for the booking modal. Does NOT write anything.
   * Always uses `asOf` = now() for the rate card (showing current pricing).
   */
  async getQuotePreview(input: QuoteInput): Promise<PriceBreakdown & { monthlyCost: number; totalCost: number }> {
    const { serviceId, hoursPerDay, daysPerWeek, planDurationMonths } = input;

    const service = await this.serviceById(serviceId);
    if (!service) throw new NotFoundException(`Service ${serviceId} not found`);

    const rateCard = await this.getEffectiveRateCard(serviceId, input.asOf);

    const priceInput: PriceInput = {
      pricingMode: input.pricingMode ?? 'standard',
      baseHourlyRate: Number(rateCard.hourly_rate),
      hoursPerDay,
      // Normalised here too: a one-time booking is a single session however many
      // weekdays the caller happened to pass along.
      daysPerWeek: resolveDaysPerWeek({
        planType: input.planType,
        daysPerWeek,
      }),
      weeksInCycle: weeksInCycleFor(input.planType),
      gstPercent: this.effectiveGstPercent(),
      customHourlyRate: input.customHourlyRate,
      customFinalPrice: input.customFinalPrice,
    };

    const breakdown = calculatePrice(priceInput);
    const monthlyCost = breakdown.finalAmount;
    const totalCost = Math.round(monthlyCost * planDurationMonths * 100) / 100;

    return { ...breakdown, monthlyCost, totalCost };
  }

  /**
   * The all-in cost of a booking, used by every read path that shows a parent or
   * an admin what a plan costs.
   *
   * `daysPerWeek` is how many days a week the schedule runs — resolve it with
   * `resolveDaysPerWeek` at the call site rather than passing a raw
   * `sessions_per_month`, which is a different unit and used to be the reason
   * recurring plans priced as though they ran a single day a week.
   */
  async calculateCost(
    serviceCategory: string,
    durationHours: number,
    planDurationMonths: number = 1,
    planType: string = 'ONE_TIME',
    daysPerWeek: number = 1,
  ) {
    const service = await this.serviceByName(serviceCategory);

    if (!service) {
      return {
        totalAmount: 0,
        monthlyCost: 0,
        planDurationMonths: 1,
        subtotalAmount: 0,
        gstPercent: 0,
        gstAmount: 0,
        appliedRate: 0,
      };
    }

    const preview = await this.getQuotePreview({
      serviceId: service.id,
      hoursPerDay: durationHours,
      daysPerWeek: resolveDaysPerWeek({ planType, daysPerWeek }),
      planDurationMonths,
      planType,
    });

    // `totalAmount` means the tax-inclusive total over the whole plan duration.
    // The subtotal/GST split is scaled the same way so the three reconcile.
    const scale = (n: number) => Math.round(n * planDurationMonths * 100) / 100;

    return {
      totalAmount: preview.totalCost,
      monthlyCost: preview.monthlyCost,
      planDurationMonths,
      subtotalAmount: scale(preview.subtotalAmount),
      gstPercent: preview.gstPercent,
      gstAmount: scale(preview.gstAmount),
      appliedRate: preview.baseHourlyRate || 0,
    };
  }

  // ─── Snapshot Creation (called at billing time) ──────────────────────────────

  /**
   * Calculate price for a billing cycle and write a price_snapshot row.
   * This is the authoritative record of what will be charged.
   * Must be called BEFORE creating the Razorpay order so we have a record
   * even if the charge attempt fails.
   */
  async calculateAndSnapshot(
    input: CycleChargeInput,
  ): Promise<{ snapshotId: string; finalAmount: number; breakdown: PriceBreakdown }> {
    const { bookingId, cycleNumber, paymentPlanId } = input;

    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      include: {
        service_requests: true,
        // A weekly plan hangs off recurring_service_requests, not service_requests.
        // Without it the plan type reads as ONE_TIME and the cycle bills a single
        // session instead of a month of them.
        recurring_service_requests: true,
      },
    });

    if (!booking) throw new NotFoundException(`Booking ${bookingId} not found`);

    const parentRequest = booking.service_requests ?? booking.recurring_service_requests;

    // Validate required pricing fields exist on booking or fallback to the request
    const hoursPerDay = booking.hours_per_day ? Number(booking.hours_per_day) : Number(parentRequest?.duration_hours || 0);
    const planType = parentRequest?.plan_type || 'ONE_TIME';
    const daysPerWeek = resolveDaysPerWeek({
      planType,
      daysPerWeek: booking.days_per_week ?? (parentRequest as any)?.days_per_week,
      recurrencePattern: booking.recurring_service_requests?.recurrence_pattern,
      sessionsPerMonth: parentRequest?.sessions_per_month,
    });

    if (!hoursPerDay || !daysPerWeek) {
      throw new BadRequestException(
        `Booking ${bookingId} is missing hours_per_day or days_per_week, and no fallback service request data is available.`,
      );
    }

    // Resolve service — look up via the request's category or fallback
    const serviceCategory = parentRequest?.category ?? 'CC';
    const service = await this.prisma.services.findFirst({
      where: {
        OR: [
          { name: serviceCategory },
          { slug: serviceCategory.toLowerCase() },
        ],
      },
    });
    if (!service) {
      throw new NotFoundException(`Service for category "${serviceCategory}" not found`);
    }

    // Resolve rate card based on lock mode
    const asOf = this.resolveRateCardAsOf(booking as any);
    const rateCard = await this.getEffectiveRateCard(service.id, asOf);

    const priceInput: PriceInput = {
      pricingMode: (booking.pricing_mode as PricingMode) ?? 'standard',
      baseHourlyRate: Number(rateCard.hourly_rate),
      hoursPerDay: hoursPerDay,
      daysPerWeek: daysPerWeek,
      weeksInCycle: weeksInCycleFor(planType),
      gstPercent: this.effectiveGstPercent(),
      customHourlyRate: booking.custom_hourly_rate
        ? Number(booking.custom_hourly_rate)
        : undefined,
      customFinalPrice: booking.custom_final_price
        ? Number(booking.custom_final_price)
        : undefined,
    };

    const breakdown = calculatePrice(priceInput);

    // How this cycle will be collected is decided once, here, and stored — never
    // recomputed at order time or display time, where the two could disagree about
    // what a parent owes. Everything downstream reads the installment rows.
    const { enabled } = await this.getAdvancePaymentConfig();
    const splittable = isSplittable(planType, breakdown.finalAmount, enabled);

    // The fee is a placement charge, so a plan pays it once — on its first cycle,
    // not every month. The `already charged` check is what makes re-snapshotting
    // an abandoned first checkout safe: it looks for a fee row on the *booking*,
    // so a second attempt at cycle 1 cannot mint a second fee.
    const matchingFee = await this.resolveMatchingFeeFor(bookingId, cycleNumber);

    const planned = planInstalments(breakdown.finalAmount, {
      splittable,
      matchingFee,
    });
    const parts = planned.length;

    // Apportioned by amount rather than split evenly: a matching fee makes the
    // rows uneven, and the tax lines have to follow the money they belong to.
    const weights = planned.map((p) => p.amount);
    const subtotals = apportion(breakdown.subtotalAmount, weights);
    const gsts = apportion(breakdown.gstAmount, weights);

    // Snapshot and installments are one write: a snapshot with no installments
    // would be a cycle nothing can ever charge.
    const snapshot = await this.prisma.$transaction(async (tx) => {
      // Write the immutable price snapshot. `gst_percent_used` freezes the rate in
      // force at charge time, so flipping GST_ENABLED later never rewrites what a
      // customer was actually charged.
      const created = await tx.price_snapshots.create({
        data: {
          booking_id: bookingId,
          payment_plan_id: paymentPlanId ?? null,
          cycle_number: cycleNumber,
          base_hourly_rate_used: breakdown.baseHourlyRate ?? 0,
          hours_billed: breakdown.totalHours ?? 0,
          custom_price_applied: breakdown.customPriceApplied,
          subtotal_amount: breakdown.subtotalAmount,
          gst_percent_used: breakdown.gstPercent,
          gst_amount: breakdown.gstAmount,
          final_amount: breakdown.finalAmount,
          calculation_breakdown: breakdown as any,
          status: 'pending',
        },
      });

      await tx.payment_installments.createMany({
        data: planned.map((part, i) => ({
          booking_id: bookingId,
          price_snapshot_id: created.id,
          payment_plan_id: paymentPlanId ?? null,
          cycle_number: cycleNumber,
          installment_no: i + 1,
          total_installments: parts,
          kind: part.kind,
          amount: part.amount,
          subtotal_amount: subtotals[i],
          gst_amount: gsts[i],
          // Only what's payable on sight gets a date. The balance's is set when
          // the advance is actually paid, so the clock starts from the parent's
          // money leaving, not from a checkout screen they may never have
          // completed.
          due_date: part.dueNow ? new Date() : null,
          status: 'pending',
        })),
      });

      return created;
    });

    this.logger.log(
      `Price snapshot created: booking=${bookingId} cycle=${cycleNumber} ` +
        `amount=${breakdown.finalAmount} installments=${parts}`,
    );

    return {
      snapshotId: snapshot.id,
      finalAmount: breakdown.finalAmount,
      breakdown,
    };
  }

  /**
   * The matching fee to carve out of this cycle, or 0.
   *
   * Only ever the first cycle, and only if this booking has never had a fee row
   * written before — a parent who abandons the first checkout and comes back must
   * not be charged for the same placement twice.
   */
  private async resolveMatchingFeeFor(
    bookingId: string,
    cycleNumber: number,
  ): Promise<number> {
    if (cycleNumber !== 1) return 0;

    const { enabled, amount } = await this.getMatchingFeeConfig();
    if (!enabled) return 0;

    const alreadyCharged = await this.prisma.payment_installments.findFirst({
      where: { booking_id: bookingId, kind: MATCHING_FEE_KIND },
      select: { id: true },
    });

    return alreadyCharged ? 0 : amount;
  }

  /**
   * Mark a price snapshot as charged after a successful Razorpay payment.
   */
  async markSnapshotCharged(
    snapshotId: string,
    razorpayPaymentId: string,
    paymentDbId: string,
  ): Promise<void> {
    await this.prisma.price_snapshots.update({
      where: { id: snapshotId },
      data: {
        razorpay_payment_id: razorpayPaymentId,
        payment_id: paymentDbId,
        status: 'charged',
      },
    });
  }

  /**
   * Mark a price snapshot as failed so it can be retried.
   */
  async markSnapshotFailed(snapshotId: string): Promise<void> {
    await this.prisma.price_snapshots.update({
      where: { id: snapshotId },
      data: { status: 'failed' },
    });
  }

  // ─── Payment Plan Management ─────────────────────────────────────────────────

  /**
   * Create a payment_plan for a recurring booking.
   * Called once when a multi-month booking is confirmed.
   */
  async createPaymentPlan(
    bookingId: string,
    totalCycles: number,
    startDate: Date,
  ) {
    const existing = await this.prisma.payment_plans.findUnique({
      where: { booking_id: bookingId },
    });
    if (existing) return existing;

    return this.prisma.payment_plans.create({
      data: {
        booking_id: bookingId,
        total_cycles: totalCycles,
        cycles_completed: 0,
        start_date: startDate,
        next_due_date: startDate,
        status: 'active',
      },
    });
  }

  /**
   * Advance the payment plan to the next cycle after a successful charge.
   *
   * Delegates to the transactional form so the two can never drift; callers on a
   * capture path should use `advancePaymentPlanTx` directly, inside the same
   * transaction as the capture.
   */
  async advancePaymentPlan(planId: string): Promise<void> {
    await this.advancePaymentPlanTx(this.prisma, planId);
  }

  /**
   * Advance a plan by one cycle, at most once.
   *
   * `expectedCyclesCompleted` makes this safe to call from a capture that may run
   * twice — the webhook and the verify endpoint both fire for the same money, and
   * a split cycle has two orders whose captures can interleave. The count is part
   * of the WHERE clause rather than read first and written after, so a second
   * caller updates zero rows instead of advancing the plan a second time.
   */
  async advancePaymentPlanTx(
    tx: Prisma.TransactionClient | PrismaService,
    planId: string,
    expectedCyclesCompleted?: number,
  ): Promise<boolean> {
    const plan = await tx.payment_plans.findUnique({ where: { id: planId } });
    if (!plan) return false;
    if (
      expectedCyclesCompleted != null &&
      plan.cycles_completed !== expectedCyclesCompleted
    ) {
      return false;
    }

    const nextCompleted = plan.cycles_completed + 1;
    const isComplete = nextCompleted >= plan.total_cycles;

    // Next due date = advance by 1 month
    const nextDue = new Date(plan.next_due_date);
    nextDue.setMonth(nextDue.getMonth() + 1);

    const { count } = await tx.payment_plans.updateMany({
      where: { id: planId, cycles_completed: plan.cycles_completed },
      data: {
        cycles_completed: nextCompleted,
        next_due_date: isComplete ? plan.next_due_date : nextDue,
        status: isComplete ? 'completed' : 'active',
        updated_at: new Date(),
      },
    });

    return count === 1;
  }

  // ─── Rate Card Admin Helpers ─────────────────────────────────────────────────

  /**
   * Create a new rate card for a service, closing the current one first.
   * This is append-only — the previous card is closed, not deleted.
   */
  async createRateCard(
    serviceId: string,
    hourlyRate: number,
    adminId?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // Close the current active rate card
      await tx.rate_cards.updateMany({
        where: { service_id: serviceId, effective_to: null },
        data: { effective_to: new Date() },
      });

      // Create the new card effective now
      return tx.rate_cards.create({
        data: {
          service_id: serviceId,
          hourly_rate: hourlyRate,
          effective_from: new Date(),
          effective_to: null,
          created_by: adminId ?? null,
        },
      });
    });
  }

  /**
   * Get the full rate card history for a service, newest first.
   */
  async getRateCardHistory(serviceId: string) {
    return this.prisma.rate_cards.findMany({
      where: { service_id: serviceId },
      orderBy: { effective_from: 'desc' },
    });
  }

  // ─── Price Snapshot Queries ──────────────────────────────────────────────────

  async getSnapshotsForBooking(bookingId: string) {
    return this.prisma.price_snapshots.findMany({
      where: { booking_id: bookingId },
      orderBy: { cycle_number: 'asc' },
    });
  }
}
