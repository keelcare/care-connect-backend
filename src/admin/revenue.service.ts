import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AdminAuditService } from "./admin-audit.service";
import { MANUAL_PENDING_PROVIDER, PaymentStatus } from "../constants";
import { RevenueQueryDto } from "./dto/revenue-query.dto";
import {
  COMMISSION_SETTING_KEY,
  PricingEngineService,
} from "../common/pricing.service";
import {
  CAREGIVER_SHARE_ONLY,
  EARNING_STATUSES,
  preTaxServiceFee,
  round2,
} from "../common/payout-policy";

export { COMMISSION_SETTING_KEY };

/** Money the parent actually paid. Excludes abandoned checkouts and placeholders. */
const COLLECTED_STATUSES = EARNING_STATUSES;

interface MoneySplit {
  gross: number;
  gst: number;
  net: number;
}

@Injectable()
export class RevenueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AdminAuditService,
    private readonly pricingService: PricingEngineService,
  ) {}

  /**
   * Delegates to the shared resolver so this ledger and the caregiver-facing
   * earnings screen can never quote different rates. Still defaults to 0 — an
   * unconfigured platform takes no margin rather than guessing one.
   */
  async getCommissionPercent(): Promise<number> {
    const { percent } = await this.pricingService.getCommissionConfig();
    return percent;
  }

  async setCommissionPercent(percent: number, adminId: string, ipAddress?: string) {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new BadRequestException("Commission percent must be between 0 and 100");
    }

    const result = await this.prisma.system_settings.upsert({
      where: { key: COMMISSION_SETTING_KEY },
      update: { value: { percent }, updated_at: new Date() },
      create: { key: COMMISSION_SETTING_KEY, value: { percent } },
    });

    await this.auditService.logAction({
      adminId,
      action: "UPDATE_COMMISSION_RATE",
      targetType: "system_setting",
      targetId: COMMISSION_SETTING_KEY,
      metadata: { percent },
      ipAddress,
    });

    return { percent };
  }

  private dateRange(query: RevenueQueryDto) {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - 29 * 24 * 60 * 60 * 1000);

    if (isNaN(from.getTime())) throw new BadRequestException("Invalid 'from' date format");
    if (isNaN(to.getTime())) throw new BadRequestException("Invalid 'to' date format");
    if (from > to) throw new BadRequestException("'from' must be before 'to'");

    return { from, to };
  }

  /**
   * GST is a pass-through collected on behalf of the government, so it is
   * stripped before any margin is computed. It lives on `price_snapshots`,
   * frozen at charge time; payments with no snapshot (cancellation fees, rows
   * predating the snapshot system) are treated as GST-free.
   */
  private async splitOf(where: Prisma.paymentsWhereInput): Promise<MoneySplit> {
    const [amountAgg, gstAgg] = await this.prisma.$transaction([
      this.prisma.payments.aggregate({ where, _sum: { amount: true } }),
      this.prisma.price_snapshots.aggregate({
        where: { payments: { is: where } },
        _sum: { gst_amount: true },
      }),
    ]);

    const gross = Number(amountAgg._sum.amount ?? 0);
    const gst = Number(gstAgg._sum.gst_amount ?? 0);
    return { gross: round2(gross), gst: round2(gst), net: round2(gross - gst) };
  }

  /** Real money in: a genuine charge, not a completion placeholder. */
  private collectedWhere(from?: Date, to?: Date): Prisma.paymentsWhereInput {
    return {
      provider: { not: MANUAL_PENDING_PROVIDER },
      status: { in: COLLECTED_STATUSES },
      ...(from && to ? { created_at: { gte: from, lte: to } } : {}),
    };
  }

  /**
   * Collected money that carries a caregiver share — everything above except
   * cancellation fees, which pay for a booking that never happened and so have no
   * service fee to split. The caregiver's app applies the same rule, so accruing a
   * payout on them here would show admins an obligation the caregiver never sees.
   */
  private caregiverShareWhere(from?: Date, to?: Date): Prisma.paymentsWhereInput {
    return { ...this.collectedWhere(from, to), ...CAREGIVER_SHARE_ONLY };
  }

  /** The mirror image: collected money the platform keeps in full. */
  private cancellationFeeWhere(from?: Date, to?: Date): Prisma.paymentsWhereInput {
    return {
      ...this.collectedWhere(from, to),
      provider: { not: MANUAL_PENDING_PROVIDER },
      price_snapshots: { none: {} },
    };
  }

  private refundedWhere(from?: Date, to?: Date): Prisma.paymentsWhereInput {
    return {
      provider: { not: MANUAL_PENDING_PROVIDER },
      status: PaymentStatus.REFUNDED,
      ...(from && to ? { created_at: { gte: from, lte: to } } : {}),
    };
  }

  /**
   * Headline finance numbers. Everything derives from three facts: what was
   * collected, what was refunded, and what is still owed to caregivers.
   *
   *   net           = gross collected − GST (pass-through)
   *   commission    = take rate × net of splittable work
   *                     + 100% of cancellation fees   → the platform's revenue
   *   caregiver     = splittable net − commission     → the payout obligation
   *   profit        = commission − commission reversed on refunds
   *
   * Cancellation fees are split out rather than run through the take rate: no
   * caregiver worked, so the platform keeps the whole fee. Charging only the take
   * rate on them would book the other 95% as a payout nobody is owed.
   *
   * Window metrics filter on `payments.created_at`; the payout figures are
   * point-in-time balances and deliberately ignore the window — an unreleased
   * payout from four months ago is still owed today.
   */
  async getSummary(query: RevenueQueryDto) {
    const { from, to } = this.dateRange(query);
    // `configured` distinguishes a deliberate 0% from a rate nobody has ever set —
    // the percentage alone cannot, and only one of the two warrants a warning.
    const { percent, configured } = await this.pricingService.getCommissionConfig();
    const rate = percent / 100;

    const [collected, splittable, cancellationFees, refunded, allTimeCollected] =
      await Promise.all([
        this.splitOf(this.collectedWhere(from, to)),
        this.splitOf(this.caregiverShareWhere(from, to)),
        this.splitOf(this.cancellationFeeWhere(from, to)),
        this.splitOf(this.refundedWhere(from, to)),
        this.splitOf(this.collectedWhere()),
      ]);

    // Outstanding: completed work whose caregiver share has not been released.
    // `CAREGIVER_SHARE_ONLY` keeps a cancellation fee from ever appearing as a
    // payout obligation, whatever status it happens to be sitting in.
    const outstandingWhere: Prisma.paymentsWhereInput = {
      status: PaymentStatus.PENDING_RELEASE,
      released_at: null,
      ...CAREGIVER_SHARE_ONLY,
    };
    const releasedWhere: Prisma.paymentsWhereInput = {
      status: PaymentStatus.PENDING_RELEASE,
      released_at: { not: null },
      ...CAREGIVER_SHARE_ONLY,
    };
    // Booking completed with no charge attached — the caregiver is owed but the
    // platform never collected. Tracked separately because it is a loss, not revenue.
    const uncollectedWhere: Prisma.paymentsWhereInput = {
      provider: MANUAL_PENDING_PROVIDER,
      status: PaymentStatus.PENDING_RELEASE,
    };

    const [outstanding, released, uncollected] = await Promise.all([
      this.splitOf(outstandingWhere),
      this.splitOf(releasedWhere),
      this.splitOf(uncollectedWhere),
    ]);

    const [paidCount, refundCount, outstandingCount] = await this.prisma.$transaction([
      this.prisma.payments.count({ where: this.collectedWhere(from, to) }),
      this.prisma.payments.count({ where: this.refundedWhere(from, to) }),
      this.prisma.payments.count({ where: outstandingWhere }),
    ]);

    const commission = round2(splittable.net * rate + cancellationFees.net);
    const commissionReversed = round2(refunded.net * rate);

    return {
      window: { from: from.toISOString(), to: to.toISOString() },
      commissionPercent: percent,
      commissionConfigured: configured,
      collected: {
        gross: collected.gross,
        gst: collected.gst,
        net: collected.net,
        allTimeGross: allTimeCollected.gross,
        allTimeNet: allTimeCollected.net,
      },
      refunds: {
        gross: refunded.gross,
        net: refunded.net,
      },
      platform: {
        commission,
        commissionReversed,
        /** Profit: what the platform keeps after payouts, GST and refunds. */
        profit: round2(commission - commissionReversed),
      },
      payouts: {
        /** Caregiver share of collected money in this window. Excludes cancellation fees. */
        accrued: round2(splittable.net * (1 - rate)),
        outstanding: round2(outstanding.net * (1 - rate)),
        released: round2(released.net * (1 - rate)),
        /** Owed to caregivers on bookings the parent never paid for. */
        uncollected: round2(uncollected.net * (1 - rate)),
      },
      counts: {
        paidPayments: paidCount,
        refunds: refundCount,
        outstandingPayouts: outstandingCount,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Daily series over the window. Fetched as rows rather than grouped in SQL
   * because each day's GST has to come off the joined snapshot before margin
   * is applied, and the window is bounded to at most a year.
   */
  async getTrend(query: RevenueQueryDto) {
    const { from, to } = this.dateRange(query);
    const percent = await this.getCommissionPercent();
    const rate = percent / 100;

    const rows = await this.prisma.payments.findMany({
      where: this.collectedWhere(from, to),
      select: {
        amount: true,
        provider: true,
        created_at: true,
        price_snapshots: { select: { gst_amount: true } },
      },
      orderBy: { created_at: "asc" },
    });

    // `splittableNet` is the part a caregiver has a share of; `feeNet` is
    // cancellation fees, which the platform keeps whole. Same split as getSummary.
    const byDay = new Map<string, { gross: number; splittableNet: number; feeNet: number }>();
    for (const row of rows) {
      const key = (row.created_at ?? from).toISOString().slice(0, 10);
      const bucket = byDay.get(key) ?? { gross: 0, splittableNet: 0, feeNet: 0 };
      const net = preTaxServiceFee(row);
      const isCancellationFee =
        row.provider !== MANUAL_PENDING_PROVIDER && row.price_snapshots.length === 0;

      bucket.gross += Number(row.amount);
      if (isCancellationFee) bucket.feeNet += net;
      else bucket.splittableNet += net;
      byDay.set(key, bucket);
    }

    const points: {
      date: string;
      gross: number;
      net: number;
      commission: number;
      payouts: number;
    }[] = [];

    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      const bucket = byDay.get(key) ?? { gross: 0, splittableNet: 0, feeNet: 0 };
      const net = bucket.splittableNet + bucket.feeNet;
      points.push({
        date: key,
        gross: round2(bucket.gross),
        net: round2(net),
        commission: round2(bucket.splittableNet * rate + bucket.feeNet),
        payouts: round2(bucket.splittableNet * (1 - rate)),
      });
    }

    return { commissionPercent: percent, points };
  }

  /**
   * Outstanding payouts grouped by caregiver — the actual "who do we owe" list.
   * The caregiver comes off the booking, not `payments.nanny_id`, which the
   * completion placeholder never sets.
   */
  async getOutstandingPayouts(query: RevenueQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const percent = await this.getCommissionPercent();
    const rate = percent / 100;

    const where: Prisma.paymentsWhereInput = {
      status: PaymentStatus.PENDING_RELEASE,
      released_at: null,
      ...CAREGIVER_SHARE_ONLY,
    };

    const rows = await this.prisma.payments.findMany({
      where,
      select: {
        id: true,
        amount: true,
        provider: true,
        created_at: true,
        booking_id: true,
        price_snapshots: { select: { gst_amount: true } },
        bookings: {
          select: {
            nanny_id: true,
            users_bookings_nanny_idTousers: {
              select: {
                id: true,
                email: true,
                profiles: { select: { first_name: true, last_name: true } },
              },
            },
          },
        },
      },
      orderBy: { created_at: "asc" },
    });

    const groups = new Map<
      string,
      {
        nannyId: string | null;
        name: string;
        email: string | null;
        bookings: number;
        grossAmount: number;
        payoutAmount: number;
        uncollectedAmount: number;
        oldestSince: string | null;
        paymentIds: string[];
      }
    >();

    for (const row of rows) {
      const nanny = row.bookings?.users_bookings_nanny_idTousers ?? null;
      const key = nanny?.id ?? "unassigned";
      const name =
        [nanny?.profiles?.first_name, nanny?.profiles?.last_name].filter(Boolean).join(" ") ||
        "Unassigned";

      const gross = Number(row.amount);
      const payout = preTaxServiceFee(row) * (1 - rate);

      const group =
        groups.get(key) ??
        {
          nannyId: nanny?.id ?? null,
          name,
          email: nanny?.email ?? null,
          bookings: 0,
          grossAmount: 0,
          payoutAmount: 0,
          uncollectedAmount: 0,
          oldestSince: null as string | null,
          paymentIds: [] as string[],
        };

      group.bookings += 1;
      group.grossAmount += gross;
      group.payoutAmount += payout;
      if (row.provider === MANUAL_PENDING_PROVIDER) group.uncollectedAmount += payout;
      group.paymentIds.push(row.id);
      const createdAt = row.created_at?.toISOString() ?? null;
      if (createdAt && (!group.oldestSince || createdAt < group.oldestSince)) {
        group.oldestSince = createdAt;
      }

      groups.set(key, group);
    }

    const all = Array.from(groups.values())
      .map((g) => ({
        ...g,
        grossAmount: round2(g.grossAmount),
        payoutAmount: round2(g.payoutAmount),
        uncollectedAmount: round2(g.uncollectedAmount),
      }))
      .sort((a, b) => b.payoutAmount - a.payoutAmount);

    return {
      commissionPercent: percent,
      items: all.slice((page - 1) * pageSize, page * pageSize),
      pagination: {
        page,
        pageSize,
        total: all.length,
        totalPages: Math.ceil(all.length / pageSize) || 1,
      },
    };
  }

  /** Marks a caregiver's share as paid out. Idempotent by design — a second call errors. */
  async releasePayout(paymentId: string, adminId: string, ipAddress?: string) {
    const payment = await this.prisma.payments.findUnique({
      where: { id: paymentId },
      select: { id: true, status: true, amount: true, released_at: true, booking_id: true },
    });

    if (!payment) throw new NotFoundException("Payment record not found");
    if (payment.status !== PaymentStatus.PENDING_RELEASE) {
      throw new BadRequestException("Only pending_release payments can be released");
    }
    if (payment.released_at) {
      throw new BadRequestException("This payout has already been released");
    }

    const updated = await this.prisma.payments.update({
      where: { id: paymentId },
      data: { released_at: new Date(), released_by: adminId },
      select: { id: true, released_at: true, released_by: true },
    });

    await this.auditService.logAction({
      adminId,
      action: "RELEASE_PAYOUT",
      targetType: "payment",
      targetId: paymentId,
      metadata: { bookingId: payment.booking_id, amount: Number(payment.amount) },
      ipAddress,
    });

    return updated;
  }

  /** Releases every outstanding payout for one caregiver in a single settlement. */
  async releasePayoutsForNanny(nannyId: string, adminId: string, ipAddress?: string) {
    const pending = await this.prisma.payments.findMany({
      where: {
        status: PaymentStatus.PENDING_RELEASE,
        released_at: null,
        bookings: { nanny_id: nannyId },
      },
      select: { id: true, amount: true },
    });

    if (pending.length === 0) {
      throw new NotFoundException("No outstanding payouts for this caregiver");
    }

    const releasedAt = new Date();
    await this.prisma.payments.updateMany({
      where: { id: { in: pending.map((p) => p.id) } },
      data: { released_at: releasedAt, released_by: adminId },
    });

    await this.auditService.logAction({
      adminId,
      action: "RELEASE_PAYOUT_BATCH",
      targetType: "user",
      targetId: nannyId,
      metadata: {
        paymentIds: pending.map((p) => p.id),
        grossAmount: pending.reduce((s, p) => s + Number(p.amount), 0),
      },
      ipAddress,
    });

    return { released: pending.length, releasedAt: releasedAt.toISOString() };
  }
}
