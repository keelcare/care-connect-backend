import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  calculatePrice,
  PriceBreakdown,
  PriceInput,
  PricingMode,
} from './utils/pricing.utils';

export interface QuoteInput {
  serviceId: string;
  hoursPerDay: number;
  daysPerWeek: number;
  planDurationMonths: number;
  pricingMode?: PricingMode;
  discountTierId?: string;
  customHourlyRate?: number;
  customFinalPrice?: number;
  /** If provided, resolves rate card as-of this date. Defaults to now() */
  asOf?: Date;
  planType?: string;
}

export interface CycleChargeInput {
  bookingId: string;
  cycleNumber: number;
  paymentPlanId?: string;
}

@Injectable()
export class PricingEngineService {
  private readonly logger = new Logger(PricingEngineService.name);

  constructor(private readonly prisma: PrismaService) {}

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

    let discountPercent = 0;
    if (input.discountTierId) {
      const tier = await this.prisma.discount_tiers.findUnique({
        where: { id: input.discountTierId },
      });
      discountPercent = tier ? Number(tier.discount_percent) : 0;
    }

    const priceInput: PriceInput = {
      pricingMode: input.pricingMode ?? 'standard',
      baseHourlyRate: Number(rateCard.hourly_rate),
      hoursPerDay,
      daysPerWeek,
      weeksInCycle: input.planType === 'ONE_TIME' ? 1 : 4,
      discountPercent,
      customHourlyRate: input.customHourlyRate,
      customFinalPrice: input.customFinalPrice,
    };

    const breakdown = calculatePrice(priceInput);
    const monthlyCost = breakdown.finalAmount;
    const totalCost = Math.round(monthlyCost * planDurationMonths * 100) / 100;

    return { ...breakdown, monthlyCost, totalCost };
  }

  /**
   * Backward-compatible calculateCost used by bookings.service.ts
   */
  async calculateCost(
    serviceCategory: string,
    durationHours: number,
    discountPercentage: number = 0,
    planDurationMonths: number = 1,
    planType: string = 'ONE_TIME',
    sessionsPerMonth: number = 1,
  ) {
    const service = await this.serviceByName(serviceCategory);

    if (!service) {
      return { totalAmount: 0, monthlyCost: 0, planDurationMonths: 1, originalAmount: 0, discountAmount: 0, appliedRate: 0 };
    }

    const preview = await this.getQuotePreview({
      serviceId: service.id,
      hoursPerDay: durationHours,
      daysPerWeek: planType === 'ONE_TIME' ? 1 : (sessionsPerMonth ? Math.max(1, Math.round(sessionsPerMonth / 4)) : 1),
      planDurationMonths,
      planType,
    });

    // In old code, totalAmount meant total over the duration.
    return {
      totalAmount: preview.totalCost,
      monthlyCost: preview.monthlyCost,
      planDurationMonths,
      originalAmount: preview.grossAmount || preview.totalCost,
      discountAmount: preview.discountAmount || 0,
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
        discount_tiers: true,
      },
    });

    if (!booking) throw new NotFoundException(`Booking ${bookingId} not found`);

    // Validate required pricing fields exist on booking or fallback to service_requests
    const hoursPerDay = booking.hours_per_day ? Number(booking.hours_per_day) : Number(booking.service_requests?.duration_hours || 0);
    const daysPerWeek = booking.days_per_week ? booking.days_per_week : (booking.service_requests?.sessions_per_month ? Math.max(1, Math.round(booking.service_requests.sessions_per_month / 4)) : 1);

    if (!hoursPerDay || !daysPerWeek) {
      throw new BadRequestException(
        `Booking ${bookingId} is missing hours_per_day or days_per_week, and no fallback service request data is available.`,
      );
    }

    // Resolve service — look up via service_requests.category or fallback
    const serviceCategory = booking.service_requests?.category ?? 'CC';
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

    const discountPercent = booking.discount_tiers
      ? Number(booking.discount_tiers.discount_percent)
      : 0;

    const planType = booking.service_requests?.plan_type || 'ONE_TIME';

    const priceInput: PriceInput = {
      pricingMode: (booking.pricing_mode as PricingMode) ?? 'standard',
      baseHourlyRate: Number(rateCard.hourly_rate),
      hoursPerDay: hoursPerDay,
      daysPerWeek: daysPerWeek,
      weeksInCycle: planType === 'ONE_TIME' ? 1 : 4,
      discountPercent,
      customHourlyRate: booking.custom_hourly_rate
        ? Number(booking.custom_hourly_rate)
        : undefined,
      customFinalPrice: booking.custom_final_price
        ? Number(booking.custom_final_price)
        : undefined,
    };

    const breakdown = calculatePrice(priceInput);

    // Write the immutable price snapshot
    const snapshot = await this.prisma.price_snapshots.create({
      data: {
        booking_id: bookingId,
        payment_plan_id: paymentPlanId ?? null,
        cycle_number: cycleNumber,
        base_hourly_rate_used: breakdown.baseHourlyRate ?? 0,
        discount_percent_used: breakdown.discountPercent,
        hours_billed: breakdown.totalHours ?? 0,
        custom_price_applied: breakdown.customPriceApplied,
        final_amount: breakdown.finalAmount,
        calculation_breakdown: breakdown as any,
        status: 'pending',
      },
    });

    this.logger.log(
      `Price snapshot created: booking=${bookingId} cycle=${cycleNumber} amount=${breakdown.finalAmount}`,
    );

    return {
      snapshotId: snapshot.id,
      finalAmount: breakdown.finalAmount,
      breakdown,
    };
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
    discountTierId?: string,
  ) {
    const existing = await this.prisma.payment_plans.findUnique({
      where: { booking_id: bookingId },
    });
    if (existing) return existing;

    return this.prisma.payment_plans.create({
      data: {
        booking_id: bookingId,
        discount_tier_id: discountTierId ?? null,
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
   */
  async advancePaymentPlan(planId: string): Promise<void> {
    const plan = await this.prisma.payment_plans.findUnique({
      where: { id: planId },
    });
    if (!plan) return;

    const nextCompleted = plan.cycles_completed + 1;
    const isComplete = nextCompleted >= plan.total_cycles;

    // Next due date = advance by 1 month
    const nextDue = new Date(plan.next_due_date);
    nextDue.setMonth(nextDue.getMonth() + 1);

    await this.prisma.payment_plans.update({
      where: { id: planId },
      data: {
        cycles_completed: nextCompleted,
        next_due_date: isComplete ? plan.next_due_date : nextDue,
        status: isComplete ? 'completed' : 'active',
        updated_at: new Date(),
      },
    });
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

  // ─── Discount Tier Helpers ───────────────────────────────────────────────────

  async getActiveTiers() {
    return this.prisma.discount_tiers.findMany({
      where: { active: true },
      orderBy: { duration_months: 'asc' },
    });
  }

  async getAllTiers() {
    return this.prisma.discount_tiers.findMany({
      orderBy: { duration_months: 'asc' },
    });
  }

  async upsertDiscountTier(data: {
    code: string;
    label: string;
    durationMonths: number;
    discountPercent: number;
    active?: boolean;
  }) {
    return this.prisma.discount_tiers.upsert({
      where: { code: data.code },
      update: {
        label: data.label,
        duration_months: data.durationMonths,
        discount_percent: data.discountPercent,
        active: data.active ?? true,
      },
      create: {
        code: data.code,
        label: data.label,
        duration_months: data.durationMonths,
        discount_percent: data.discountPercent,
        active: data.active ?? true,
      },
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
