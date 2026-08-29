import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PricingEngineService } from './pricing.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Covers the GST feature flag only. The maths lives in — and is tested by —
 * `utils/pricing.utils.spec.ts`; this asserts that the flag correctly decides
 * whether any tax reaches the calculator at all.
 */
describe('PricingEngineService — GST config', () => {
  async function build(env: Record<string, string | undefined>) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PricingEngineService,
        { provide: PrismaService, useValue: {} },
        { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
      ],
    }).compile();
    return moduleRef.get(PricingEngineService);
  }

  it('is disabled unless GST_ENABLED is exactly "true"', async () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
      const svc = await build({ GST_ENABLED: value, GST_PERCENT: '18' });
      expect(svc.getGstConfig().enabled).toBe(false);
    }
  });

  it('reports the configured rate when enabled', async () => {
    const svc = await build({ GST_ENABLED: 'true', GST_PERCENT: '18' });
    expect(svc.getGstConfig()).toEqual({ enabled: true, percent: 18 });
  });

  it('still reports the rate while disabled, so the client can preview it', async () => {
    const svc = await build({ GST_ENABLED: 'false', GST_PERCENT: '18' });
    expect(svc.getGstConfig()).toEqual({ enabled: false, percent: 18 });
  });

  it('defaults the rate to 18 when unset, blank, or unparseable', async () => {
    // A blank value must not resolve to 0% — that would silently stop collecting
    // tax we owe while the flag still claims GST is enabled.
    for (const value of [undefined, '', '   ', 'abc', '0', '-5']) {
      const svc = await build({ GST_ENABLED: 'true', GST_PERCENT: value });
      expect(svc.getGstConfig().percent).toBe(18);
    }
  });

  it('honours a non-default rate', async () => {
    const svc = await build({ GST_ENABLED: 'true', GST_PERCENT: '5' });
    expect(svc.getGstConfig().percent).toBe(5);
  });
});

/**
 * The single resolver behind both the caregiver's payout figures and the admin
 * revenue ledger. A wrong answer here is money quoted wrong to a caregiver, so the
 * unconfigured and malformed paths matter as much as the happy one.
 */
describe('PricingEngineService — commission config', () => {
  async function build(row: unknown) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PricingEngineService,
        {
          provide: PrismaService,
          useValue: { system_settings: { findUnique: async () => row } },
        },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    return moduleRef.get(PricingEngineService);
  }

  it('reports the configured rate', async () => {
    const svc = await build({ value: { percent: 5 } });
    expect(await svc.getCommissionConfig()).toEqual({ percent: 5, configured: true });
  });

  it('accepts a bare number, which is how the setting may have been written by hand', async () => {
    const svc = await build({ value: 12.5 });
    expect(await svc.getCommissionConfig()).toEqual({ percent: 12.5, configured: true });
  });

  it('reports unconfigured — never a guess — when no rate has been set', async () => {
    // Inventing a rate would take money off a caregiver's payout that no admin set.
    const svc = await build(null);
    expect(await svc.getCommissionConfig()).toEqual({ percent: 0, configured: false });
  });

  it('treats an unusable value as unconfigured rather than as 0% by accident', async () => {
    for (const value of [{ percent: 'abc' }, { percent: -1 }, { percent: 101 }, {}, 'nope']) {
      const svc = await build({ value });
      expect(await svc.getCommissionConfig()).toEqual({ percent: 0, configured: false });
    }
  });

  it('allows an explicit 0%, distinguished from unset by `configured`', async () => {
    const svc = await build({ value: { percent: 0 } });
    expect(await svc.getCommissionConfig()).toEqual({ percent: 0, configured: true });
  });
});

/**
 * The deferral window decides when a parent's balance falls due — and, through the
 * kill switch, whether cycles are split at all. Both are read on the payment path,
 * so a malformed value must degrade to sane terms rather than throw.
 */
describe('PricingEngineService — advance payment config', () => {
  async function build(rows: Record<string, unknown>) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PricingEngineService,
        {
          provide: PrismaService,
          useValue: {
            system_settings: {
              findUnique: async ({ where }: { where: { key: string } }) =>
                where.key in rows ? { value: rows[where.key] } : null,
            },
          },
        },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    return moduleRef.get(PricingEngineService);
  }

  it('defaults to the two weeks we advertise when nothing is configured', async () => {
    // Unlike commission, falling back here is safe: a missing window cannot
    // overcharge anyone, it only decides how long the parent has to pay.
    const svc = await build({});
    expect(await svc.getAdvancePaymentConfig()).toEqual({
      enabled: true,
      ratioPercent: 50,
      dueDays: 14,
    });
  });

  it('accepts a bare number, which is what the admin settings screen writes', async () => {
    const svc = await build({ advance_payment_due_days: 1 });
    expect((await svc.getAdvancePaymentConfig()).dueDays).toBe(1);
  });

  it('accepts the wrapped form used by the commission key', async () => {
    const svc = await build({ advance_payment_due_days: { days: 30 } });
    expect((await svc.getAdvancePaymentConfig()).dueDays).toBe(30);
  });

  it('falls back rather than honouring an unusable window', async () => {
    for (const value of ['abc', 0, -5, 91, {}, null]) {
      const svc = await build({ advance_payment_due_days: value });
      expect((await svc.getAdvancePaymentConfig()).dueDays).toBe(14);
    }
  });

  it('is on unless explicitly switched off', async () => {
    expect((await (await build({})).getAdvancePaymentConfig()).enabled).toBe(true);
    expect(
      (await (await build({ split_payments_enabled: true })).getAdvancePaymentConfig()).enabled,
    ).toBe(true);
    expect(
      (await (await build({ split_payments_enabled: false })).getAdvancePaymentConfig()).enabled,
    ).toBe(false);
    // A string "false" is what a hand-edited setting most plausibly contains.
    expect(
      (await (await build({ split_payments_enabled: 'false' })).getAdvancePaymentConfig()).enabled,
    ).toBe(false);
  });

  it('holds the advance share at 50%', async () => {
    const svc = await build({});
    expect((await svc.getAdvancePaymentConfig()).ratioPercent).toBe(50);
  });
});

/**
 * The matching fee is a charge, so the paths that decide *whether* to raise one
 * matter as much as the amount. Getting these wrong bills a parent for a fee no
 * admin enabled, or bills them twice for the same placement.
 */
describe('PricingEngineService — matching fee config', () => {
  async function build(settingValue: unknown | undefined) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PricingEngineService,
        {
          provide: PrismaService,
          useValue: {
            system_settings: {
              findUnique: jest
                .fn()
                .mockResolvedValue(settingValue === undefined ? null : { value: settingValue }),
            },
          },
        },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    return moduleRef.get(PricingEngineService);
  }

  it('charges nothing when no fee has ever been configured', async () => {
    const svc = await build(undefined);
    expect(await svc.getMatchingFeeConfig()).toEqual({ enabled: false, amount: 0 });
  });

  it('requires `enabled` explicitly — an amount alone is not consent to bill', async () => {
    const svc = await build({ amount: 249 });
    expect(await svc.getMatchingFeeConfig()).toEqual({ enabled: false, amount: 0 });
  });

  it('reports the configured fee when switched on', async () => {
    const svc = await build({ enabled: true, amount: 249 });
    expect(await svc.getMatchingFeeConfig()).toEqual({ enabled: true, amount: 249 });
  });

  it('refuses an enabled fee with an unusable amount rather than guessing one', async () => {
    for (const amount of [0, -100, 'abc', null, 10_000_000]) {
      const svc = await build({ enabled: true, amount });
      expect(await svc.getMatchingFeeConfig()).toEqual({ enabled: false, amount: 0 });
    }
  });

  it('reports nothing owed once the fee is switched back off', async () => {
    const svc = await build({ enabled: false, amount: 249 });
    expect(await svc.getMatchingFeeConfig()).toEqual({ enabled: false, amount: 0 });
  });
});

/**
 * `raiseMatchingFee` runs at booking confirmation. The re-entrancy case is the
 * one that costs real money: a parent who abandons the payment sheet and comes
 * back must be shown the same charge, never a second one.
 */
describe('PricingEngineService — raising the fee at confirmation', () => {
  function build(opts: { fee?: unknown; existing?: unknown } = {}) {
    const create = jest.fn().mockImplementation(({ data }) => ({ id: 'new-row', ...data }));
    const prisma = {
      system_settings: {
        findUnique: jest.fn().mockResolvedValue(opts.fee ? { value: opts.fee } : null),
      },
      payment_installments: {
        findFirst: jest.fn().mockResolvedValue(opts.existing ?? null),
      },
      $transaction: jest.fn().mockImplementation((cb: any) =>
        cb({
          price_snapshots: { create },
          payment_installments: { create },
        }),
      ),
    };
    return { prisma, create };
  }

  async function service(prisma: unknown) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PricingEngineService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    return moduleRef.get(PricingEngineService);
  }

  it('raises nothing when the fee is off', async () => {
    const { prisma } = build();
    const svc = await service(prisma);

    expect(await svc.raiseMatchingFee('booking-1')).toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('raises a fee payable immediately, outside the monthly cycles', async () => {
    const { prisma, create } = build({ fee: { enabled: true, amount: 249 } });
    const svc = await service(prisma);

    const res = await svc.raiseMatchingFee('booking-1');

    expect(res?.amount).toBe(249);
    // cycle 0 keeps cycle 1 as the first month of care while still sorting first.
    const snapshot = create.mock.calls[0][0].data;
    expect(snapshot.cycle_number).toBe(0);
    expect(snapshot.final_amount).toBe(249);

    const installment = create.mock.calls[1][0].data;
    expect(installment.kind).toBe('matching_fee');
    // Due on sight: it is owed from the moment the parent confirms.
    expect(installment.due_date).toBeInstanceOf(Date);
  });

  it('never charges twice for the same placement', async () => {
    const { prisma } = build({
      fee: { enabled: true, amount: 249 },
      existing: { id: 'fee-1', price_snapshot_id: 'snap-1', amount: 249 },
    });
    const svc = await service(prisma);

    const res = await svc.raiseMatchingFee('booking-1');

    expect(res).toEqual({ snapshotId: 'snap-1', installmentId: 'fee-1', amount: 249 });
    // The existing row is returned as-is; nothing new is written.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('honours the fee already raised, not a rate an admin changed since', async () => {
    const { prisma } = build({
      fee: { enabled: true, amount: 999 },
      existing: { id: 'fee-1', price_snapshot_id: 'snap-1', amount: 249 },
    });
    const svc = await service(prisma);

    expect((await svc.raiseMatchingFee('booking-1'))?.amount).toBe(249);
  });
});

/**
 * The dedupe/credit pair must agree about which fee rows are alive. A fee voided
 * at cancellation (or refunded) is money the platform never kept — treating it
 * as the live fee blocks re-raising, and crediting it against cycle 1 gives the
 * parent a discount for a fee they never paid.
 */
describe('PricingEngineService — dead fee rows (void/refunded)', () => {
  async function service(prisma: unknown) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PricingEngineService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    return moduleRef.get(PricingEngineService);
  }

  it('ignores voided/refunded fee rows when deduping a re-raise', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const create = jest.fn().mockImplementation(({ data }) => ({ id: 'row', ...data }));
    const prisma = {
      system_settings: {
        findUnique: jest.fn().mockResolvedValue({ value: { enabled: true, amount: 249 } }),
      },
      payment_installments: { findFirst },
      $transaction: jest.fn().mockImplementation((cb: any) =>
        cb({ price_snapshots: { create }, payment_installments: { create } }),
      ),
    };
    const svc = await service(prisma);
    const res = await svc.raiseMatchingFee('booking-1');

    // The dedupe query must exclude rows that stopped being owed…
    expect(findFirst.mock.calls[0][0].where.status).toEqual({
      notIn: ['void', 'refunded'],
    });
    // …so with only a dead row present (findFirst → null), a fresh fee is raised.
    expect(res?.amount).toBe(249);
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('does not credit a voided/refunded fee against cycle 1', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const prisma = { payment_installments: { findFirst } };
    const svc = await service(prisma);

    // Private, but this is the single place the credit is decided.
    const credit = await (svc as any).matchingFeeCreditFor('booking-1', 1);

    expect(credit).toBe(0);
    expect(findFirst.mock.calls[0][0].where.status).toEqual({
      notIn: ['void', 'refunded'],
    });
  });

  it('credits nothing for cycles after the first without querying', async () => {
    const findFirst = jest.fn();
    const svc = await service({ payment_installments: { findFirst } });
    expect(await (svc as any).matchingFeeCreditFor('booking-1', 2)).toBe(0);
    expect(findFirst).not.toHaveBeenCalled();
  });
});

/**
 * Advancing the due date is calendar arithmetic on someone's bill. A raw
 * setMonth overflowed short months (31 Jan → 3 Mar) and the drift never healed,
 * misaligning the due date with the clamped cycleWindow forever.
 */
describe('PricingEngineService — advancing a payment plan', () => {
  async function service(prisma: unknown) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PricingEngineService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    return moduleRef.get(PricingEngineService);
  }

  function tx(plan: any) {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    return {
      payment_plans: { findUnique: jest.fn().mockResolvedValue(plan), updateMany },
      updateMany,
    };
  }

  it('clamps a month-end due date instead of overflowing into the next month', async () => {
    const t = tx({
      id: 'plan-1',
      cycles_completed: 0,
      total_cycles: 6,
      next_due_date: new Date(2026, 0, 31), // 31 Jan
    });
    const svc = await service({});
    expect(await svc.advancePaymentPlanTx(t as any, 'plan-1')).toBe(true);

    const written = t.updateMany.mock.calls[0][0].data.next_due_date as Date;
    expect(written.getMonth()).toBe(1); // February…
    expect(written.getDate()).toBe(28); // …clamped to its last day, not 3 Mar.
  });

  it('advances at most once: the completed count is part of the WHERE clause', async () => {
    const t = tx({
      id: 'plan-1',
      cycles_completed: 2,
      total_cycles: 6,
      next_due_date: new Date(2026, 3, 15),
    });
    const svc = await service({});
    await svc.advancePaymentPlanTx(t as any, 'plan-1');
    expect(t.updateMany.mock.calls[0][0].where).toEqual({
      id: 'plan-1',
      cycles_completed: 2,
    });
  });

  it('refuses to advance when the caller expected a different cycle count', async () => {
    const t = tx({ id: 'plan-1', cycles_completed: 3, total_cycles: 6, next_due_date: new Date() });
    const svc = await service({});
    expect(await svc.advancePaymentPlanTx(t as any, 'plan-1', 2)).toBe(false);
    expect(t.updateMany).not.toHaveBeenCalled();
  });
});

describe('PricingEngineService — plan creation and snapshot state', () => {
  async function service(prisma: unknown) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PricingEngineService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    return moduleRef.get(PricingEngineService);
  }

  it('creates a payment plan atomically and never resets an existing one', async () => {
    const upsert = jest.fn().mockResolvedValue({ id: 'plan-1' });
    const svc = await service({ payment_plans: { upsert } });
    const start = new Date('2026-09-01T00:00:00Z');

    await svc.createPaymentPlan('booking-1', 6, start);

    const args = upsert.mock.calls[0][0];
    expect(args.where).toEqual({ booking_id: 'booking-1' });
    // Empty update arm: a re-confirmation must not zero cycles_completed.
    expect(args.update).toEqual({});
    expect(args.create.total_cycles).toBe(6);
  });

  it('never downgrades a charged snapshot back to failed/retryable', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const svc = await service({ price_snapshots: { updateMany } });

    await svc.markSnapshotFailed('snap-1');

    expect(updateMany.mock.calls[0][0].where).toEqual({
      id: 'snap-1',
      status: { not: 'charged' },
    });
  });
});

/**
 * Publishing a rate card must take effect immediately and leave no instant with
 * no card in force.
 */
describe('PricingEngineService — rate card publication', () => {
  async function service(prisma: unknown) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PricingEngineService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    return moduleRef.get(PricingEngineService);
  }

  it('closes the old card and opens the new one at the same instant', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const create = jest.fn().mockImplementation(({ data }) => ({ id: 'card-2', ...data }));
    const prisma = {
      $transaction: (cb: any) => cb({ rate_cards: { updateMany, create } }),
      rate_cards: { findMany: jest.fn() },
    };
    const svc = await service(prisma);
    await svc.createRateCard('svc-1', 120, 'admin-1');

    const closedAt = updateMany.mock.calls[0][0].data.effective_to;
    const openedFrom = create.mock.calls[0][0].data.effective_from;
    // Identical instant: any gap, even milliseconds, is a window where
    // getEffectiveRateCard finds no card at all and billing throws.
    expect(closedAt).toBe(openedFrom);
  });

  it('drops the cached card list so the new rate is used immediately', async () => {
    const oldCard = {
      id: 'card-1',
      hourly_rate: 100,
      effective_from: new Date('2026-01-01'),
      effective_to: null,
    };
    const newCard = {
      id: 'card-2',
      hourly_rate: 120,
      effective_from: new Date('2026-06-01'),
      effective_to: null,
    };
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([oldCard])
      .mockResolvedValueOnce([newCard]);
    const prisma = {
      rate_cards: { findMany },
      $transaction: (cb: any) =>
        cb({
          rate_cards: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            create: jest.fn().mockResolvedValue(newCard),
          },
        }),
    };
    const svc = await service(prisma);

    // Warm the cache with the old card…
    expect((await svc.getEffectiveRateCard('svc-1')).id).toBe('card-1');
    // …publish a new one…
    await svc.createRateCard('svc-1', 120, 'admin-1');
    // …and the very next lookup must re-query rather than serve the stale list.
    expect((await svc.getEffectiveRateCard('svc-1')).id).toBe('card-2');
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
