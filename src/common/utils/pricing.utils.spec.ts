import {
  apportion,
  calculatePrice,
  cycleWindow,
  isSplittable,
  planInstalments,
  resolveDaysPerWeek,
  splitAmount,
  weeksInCycleFor,
  PriceInput,
} from './pricing.utils';

const base: PriceInput = {
  pricingMode: 'standard',
  baseHourlyRate: 99,
  hoursPerDay: 4,
  daysPerWeek: 5,
  weeksInCycle: 4,
  gstPercent: 0,
};

describe('calculatePrice', () => {
  describe('with GST disabled (gstPercent = 0)', () => {
    it('charges the subtotal untaxed', () => {
      const r = calculatePrice(base);

      expect(r.totalHours).toBe(80); // 4h × 5d × 4w
      expect(r.subtotalAmount).toBe(7920); // 80 × ₹99
      expect(r.gstAmount).toBe(0);
      expect(r.finalAmount).toBe(7920);
    });

    it('leaves finalAmount identical to subtotalAmount', () => {
      // This is the guarantee that shipping GST behind an off flag changes no prices.
      for (const rate of [1, 99, 250, 1337.5]) {
        const r = calculatePrice({ ...base, baseHourlyRate: rate });
        expect(r.finalAmount).toBe(r.subtotalAmount);
      }
    });
  });

  describe('with GST enabled at 18%', () => {
    const gst: PriceInput = { ...base, gstPercent: 18 };

    it('adds tax on top of the subtotal', () => {
      const r = calculatePrice(gst);

      expect(r.subtotalAmount).toBe(7920);
      expect(r.gstPercent).toBe(18);
      expect(r.gstAmount).toBe(1425.6); // 7920 × 0.18
      expect(r.finalAmount).toBe(9345.6);
    });

    it('always reconciles: subtotal + gst === final', () => {
      // The old mobile UI could not satisfy this — it showed percentages of the
      // total that only summed by construction. Every row must now add up.
      const awkward = [1, 7, 33.33, 99, 100.01, 12345.67];
      for (const rate of awkward) {
        const r = calculatePrice({ ...gst, baseHourlyRate: rate });
        expect(r.subtotalAmount + r.gstAmount).toBeCloseTo(r.finalAmount, 10);
      }
    });

    it('rounds each line to paise without drift', () => {
      // 1 hour at ₹33.33 → subtotal 33.33, gst 5.9994 → 6.00, final 39.33
      const r = calculatePrice({
        ...gst,
        baseHourlyRate: 33.33,
        hoursPerDay: 1,
        daysPerWeek: 1,
        weeksInCycle: 1,
      });

      expect(r.subtotalAmount).toBe(33.33);
      expect(r.gstAmount).toBe(6);
      expect(r.finalAmount).toBe(39.33);
    });
  });

  describe('custom_rate', () => {
    it('uses the custom hourly rate and still taxes it', () => {
      const r = calculatePrice({
        ...base,
        pricingMode: 'custom_rate',
        customHourlyRate: 200,
        gstPercent: 18,
      });

      expect(r.baseHourlyRate).toBe(200);
      expect(r.subtotalAmount).toBe(16000); // 80 × ₹200
      expect(r.gstAmount).toBe(2880);
      expect(r.finalAmount).toBe(18880);
      expect(r.customPriceApplied).toBe(true);
    });

    it('falls back to the rate card when no custom rate is set', () => {
      const r = calculatePrice({ ...base, pricingMode: 'custom_rate' });
      expect(r.baseHourlyRate).toBe(99);
    });
  });

  describe('custom_override', () => {
    it('treats the override as the subtotal and applies GST on top', () => {
      // Tax is statutory: it does not depend on how the base price was set.
      const r = calculatePrice({
        ...base,
        pricingMode: 'custom_override',
        customFinalPrice: 5000,
        gstPercent: 18,
      });

      expect(r.subtotalAmount).toBe(5000);
      expect(r.gstAmount).toBe(900);
      expect(r.finalAmount).toBe(5900);
      expect(r.customPriceApplied).toBe(true);
      expect(r.baseHourlyRate).toBeNull();
    });

    it('charges the override verbatim when GST is off', () => {
      const r = calculatePrice({
        ...base,
        pricingMode: 'custom_override',
        customFinalPrice: 5000,
      });

      expect(r.finalAmount).toBe(5000);
    });

    it('throws when customFinalPrice is missing', () => {
      expect(() =>
        calculatePrice({ ...base, pricingMode: 'custom_override' }),
      ).toThrow(/requires customFinalPrice/);
    });
  });
});

describe('weeksInCycleFor', () => {
  it('bills a one-time booking as a single session', () => {
    expect(weeksInCycleFor('ONE_TIME')).toBe(1);
    expect(weeksInCycleFor(null)).toBe(1);
  });

  it('bills every subscription cycle as four weeks', () => {
    for (const plan of ['MONTHLY', 'SIX_MONTH', 'YEARLY']) {
      expect(weeksInCycleFor(plan)).toBe(4);
    }
  });
});

describe('resolveDaysPerWeek', () => {
  it('prefers the explicit column over everything else', () => {
    expect(
      resolveDaysPerWeek({
        planType: 'MONTHLY',
        daysPerWeek: 5,
        recurrencePattern: { days: ['Mon'] },
        sessionsPerMonth: 12,
      }),
    ).toBe(5);
  });

  it('counts the weekdays the parent actually picked', () => {
    expect(
      resolveDaysPerWeek({
        planType: 'MONTHLY',
        recurrencePattern: { days: ['Mon', 'Wed', 'Fri'] },
      }),
    ).toBe(3);
  });

  it('falls back to sessions_per_month for rows written before the column existed', () => {
    expect(resolveDaysPerWeek({ planType: 'MONTHLY', sessionsPerMonth: 20 })).toBe(5);
  });

  it('ignores a specific_dates pattern that carries no weekday list', () => {
    expect(
      resolveDaysPerWeek({ planType: 'MONTHLY', recurrencePattern: { dates: [1, 15] } }),
    ).toBe(1);
  });

  it('treats a one-time booking as one session however many days are passed', () => {
    expect(resolveDaysPerWeek({ planType: 'ONE_TIME', daysPerWeek: 5 })).toBe(1);
  });

  it('clamps to a week that exists', () => {
    expect(resolveDaysPerWeek({ planType: 'MONTHLY', daysPerWeek: 99 })).toBe(7);
    expect(resolveDaysPerWeek({ planType: 'MONTHLY', daysPerWeek: 0 })).toBe(1);
  });
});

describe('the days-per-week regression', () => {
  // A 1 h/day plan used to price at ₹396 (99 × 4 weeks) no matter how many days
  // the parent selected, because days_per_week was never sent and defaulted to 1.
  it('scales the monthly subtotal with the number of days selected', () => {
    const monthly = (hoursPerDay: number, daysPerWeek: number) =>
      calculatePrice({
        pricingMode: 'standard',
        baseHourlyRate: 99,
        hoursPerDay,
        daysPerWeek,
        weeksInCycle: weeksInCycleFor('MONTHLY'),
        gstPercent: 0,
      }).finalAmount;

    expect(monthly(1, 1)).toBe(396);
    expect(monthly(1, 5)).toBe(1980);
    // 99 × 6 h × 5 d × 4 w — the worked example from the bug report.
    expect(monthly(6, 5)).toBe(11880);
  });
});

describe('isSplittable', () => {
  it('splits every subscription plan', () => {
    for (const plan of ['MONTHLY', 'SIX_MONTH', 'YEARLY']) {
      expect(isSplittable(plan, 5000, true)).toBe(true);
    }
  });

  it('never splits a one-time booking', () => {
    // There is no ongoing relationship to spread a single session's cost across.
    expect(isSplittable('ONE_TIME', 5000, true)).toBe(false);
    expect(isSplittable(null, 5000, true)).toBe(false);
    expect(isSplittable(undefined, 5000, true)).toBe(false);
  });

  it('obeys the kill switch', () => {
    expect(isSplittable('MONTHLY', 5000, false)).toBe(false);
  });

  it('refuses to split a cycle whose halves would fall under the gateway floor', () => {
    // Razorpay rejects orders below ₹1, so a ₹1.50 cycle split in two leaves a
    // balance that could never be collected. Charge it whole instead.
    expect(isSplittable('MONTHLY', 2, true)).toBe(true);
    expect(isSplittable('MONTHLY', 1.5, true)).toBe(false);
    expect(isSplittable('MONTHLY', 0, true)).toBe(false);
  });
});

describe('splitAmount', () => {
  it('halves an even amount', () => {
    expect(splitAmount(11880, 2)).toEqual([5940, 5940]);
  });

  it('puts the odd paisa on the advance, never on the balance', () => {
    // The advance is charged today against a live checkout; a stray paisa left on
    // the balance is money we might never get a second chance to collect.
    expect(splitAmount(100.01, 2)).toEqual([50.01, 50]);
    expect(splitAmount(0.03, 2)).toEqual([0.02, 0.01]);
  });

  it('always sums back to the total exactly', () => {
    for (const total of [11880, 100.01, 2970.55, 0.03, 7.77, 99.99]) {
      const parts = splitAmount(total, 2);
      const sum = parts.reduce((a, b) => a + b, 0);
      expect(Math.round(sum * 100)).toBe(Math.round(total * 100));
    }
  });

  it('returns the whole amount when not splitting', () => {
    expect(splitAmount(2970, 1)).toEqual([2970]);
  });

  it('never halves a float — 0.1 + 0.2 drift must not reach a charge', () => {
    const parts = splitAmount(0.3, 2);
    expect(parts).toEqual([0.15, 0.15]);
  });
});

describe('the split as a parent experiences it', () => {
  it('charges half of a 1-month, 5-day, 6-hour plan now and half later', () => {
    const cycle = calculatePrice({
      pricingMode: 'standard',
      baseHourlyRate: 99,
      hoursPerDay: 6,
      daysPerWeek: 5,
      weeksInCycle: weeksInCycleFor('MONTHLY'),
      gstPercent: 0,
    }).finalAmount;

    expect(cycle).toBe(11880);
    expect(splitAmount(cycle, 2)).toEqual([5940, 5940]);
  });
});

describe('planInstalments — splits what is left to pay', () => {
  const sum = (parts: { amount: number }[]) =>
    Math.round(parts.reduce((a, p) => a + p.amount, 0) * 100) / 100;

  it('halves the amount net of a fee already collected at confirmation', () => {
    // Plan 10,000 with a 249 matching fee taken at confirmation leaves 9,751,
    // and the advance is half of *that* — not half of 10,000. This is what makes
    // the confirmation screen's promise true: the fee comes off the total.
    const parts = planInstalments(9751, { splittable: true });

    expect(parts).toEqual([
      { kind: 'cycle', amount: 4875.5, dueNow: true },
      { kind: 'cycle', amount: 4875.5, dueNow: false },
    ]);
    // 249 already paid + these two = the 10,000 originally quoted.
    expect(round2(249 + sum(parts))).toBe(10000);
  });

  it('leaves the plain 50/50 untouched when no fee was charged', () => {
    const parts = planInstalments(11880, { splittable: true });

    expect(parts).toEqual([
      { kind: 'cycle', amount: 5940, dueNow: true },
      { kind: 'cycle', amount: 5940, dueNow: false },
    ]);
  });

  it('charges a one-time booking whole — there is nothing to spread it across', () => {
    expect(planInstalments(2751, { splittable: false })).toEqual([
      { kind: 'cycle', amount: 2751, dueNow: true },
    ]);
  });

  it('puts the odd paisa on the advance, which is charged against a live checkout', () => {
    const parts = planInstalments(999.99, { splittable: true });

    expect(sum(parts)).toBe(999.99);
    expect(parts[0].amount).toBeGreaterThan(parts[1].amount);
  });
});

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

describe('apportion', () => {
  it('splits a tax line in proportion to uneven instalments', () => {
    expect(apportion(1800, [500, 4500, 5000])).toEqual([90, 810, 900]);
  });

  it('sums back exactly, giving the remainder to the first part', () => {
    const parts = apportion(100, [1, 1, 1]);
    expect(Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100).toBe(100);
  });

  it('falls back to an even split when there is nothing to weight by', () => {
    expect(apportion(100, [0, 0])).toEqual([50, 50]);
  });
});

describe('cycleWindow — natural months', () => {
  it('runs 1 Aug to 31 Aug, not 1 Aug to 1 Sep', () => {
    const { start, end } = cycleWindow('2026-08-01', 1);
    expect(start.toISOString().slice(0, 10)).toBe('2026-08-01');
    // Exclusive: 1 Sep belongs to cycle 2.
    expect(end.toISOString().slice(0, 10)).toBe('2026-09-01');
  });

  it('anchors on the start day — 4 Sep to 3 Oct', () => {
    const { start, end } = cycleWindow('2026-09-04', 1);
    expect(start.toISOString().slice(0, 10)).toBe('2026-09-04');
    expect(end.toISOString().slice(0, 10)).toBe('2026-10-04');
  });

  it('clamps a start day the target month does not have', () => {
    // 31 Jan + 1 month has no 31 Feb; the cycle ends at the month's last day
    // rather than silently rolling into March.
    const { end } = cycleWindow('2027-01-31', 1);
    expect(end.getMonth()).toBe(1);
  });

  it('does not drift as cycles roll forward', () => {
    const { start } = cycleWindow('2026-09-04', 7);
    expect(start.toISOString().slice(0, 10)).toBe('2027-03-04');
  });
});
