import { calculatePrice, PriceInput } from './pricing.utils';

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
