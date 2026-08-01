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
