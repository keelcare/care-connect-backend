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
