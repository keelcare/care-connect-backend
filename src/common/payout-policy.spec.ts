import {
  preTaxBookingValue,
  preTaxServiceFee,
  projectableBookingsWhere,
  sessionHours,
  type ProjectableBooking,
} from "./payout-policy";
import { BookingStatus, PaymentStatus } from "../constants";

function booking(over: Partial<ProjectableBooking> = {}): ProjectableBooking {
  return {
    start_time: new Date("2026-08-07T04:30:00.000Z"), // Fri 10:00 IST
    end_time: new Date("2026-08-07T08:30:00.000Z"), // Fri 14:00 IST — 4h
    pricing_mode: "standard",
    custom_hourly_rate: null,
    price_snapshots: [],
    ...over,
  };
}

describe("sessionHours", () => {
  it("measures the scheduled length", () => {
    expect(sessionHours(booking())).toBe(4);
  });

  it("returns null when the schedule is missing or inverted", () => {
    expect(sessionHours(booking({ end_time: null }))).toBeNull();
    expect(sessionHours(booking({ start_time: null }))).toBeNull();
    expect(
      sessionHours(
        booking({ end_time: new Date("2026-08-07T04:30:00.000Z") }), // zero length
      ),
    ).toBeNull();
  });
});

describe("preTaxBookingValue", () => {
  it("values a standard booking at the resolved rate card hourly", () => {
    expect(preTaxBookingValue(booking(), 300)).toBe(1200);
  });

  it("prefers an existing snapshot's implied hourly over the rate card", () => {
    // 8 hours billed at a 2,000 subtotal implies 250/h, not the 300 on the card.
    const b = booking({
      price_snapshots: [{ subtotal_amount: 2000, hours_billed: 8 }],
    });
    expect(preTaxBookingValue(b, 300)).toBe(1000);
  });

  it("uses the admin-set rate for custom_rate bookings", () => {
    const b = booking({ pricing_mode: "custom_rate", custom_hourly_rate: 450 });
    expect(preTaxBookingValue(b, 300)).toBe(1800);
  });

  it("excludes a custom_override booking that has no snapshot", () => {
    // custom_final_price is a whole-cycle subtotal; splitting it per session would
    // invent an hourly rate nobody agreed to.
    const b = booking({ pricing_mode: "custom_override" });
    expect(preTaxBookingValue(b, 300)).toBeNull();
  });

  it("still values a custom_override booking once it has been priced", () => {
    const b = booking({
      pricing_mode: "custom_override",
      price_snapshots: [{ subtotal_amount: 1600, hours_billed: 4 }],
    });
    expect(preTaxBookingValue(b, null)).toBe(1600);
  });

  it("returns null rather than guessing when no rate can be resolved", () => {
    expect(preTaxBookingValue(booking(), null)).toBeNull();
    expect(
      preTaxBookingValue(booking({ pricing_mode: "custom_rate" }), null),
    ).toBeNull();
  });

  it("ignores a snapshot that bills zero hours instead of dividing by it", () => {
    const b = booking({
      price_snapshots: [{ subtotal_amount: 500, hours_billed: 0 }],
    });
    expect(preTaxBookingValue(b, 300)).toBe(1200);
  });

  it("rounds to paise", () => {
    const b = booking({ pricing_mode: "custom_rate", custom_hourly_rate: 333.333 });
    expect(preTaxBookingValue(b, null)).toBe(1333.33);
  });
});

describe("projectableBookingsWhere", () => {
  const from = new Date("2026-08-06T06:30:00.000Z");
  const to = new Date("2026-08-09T18:29:59.999Z");
  const where = projectableBookingsWhere("nanny-1", from, to);

  it("only counts work both sides have committed to", () => {
    expect(where.status).toEqual({
      in: [BookingStatus.CONFIRMED, BookingStatus.IN_PROGRESS],
    });
  });

  it("only looks ahead, never at sessions already started", () => {
    expect(where.start_time).toEqual({ gt: from, lte: to });
  });

  it("excludes bookings already carrying earned money, so nothing is counted twice", () => {
    expect(where.NOT).toEqual({
      payments: {
        some: {
          status: {
            in: [PaymentStatus.CAPTURED, PaymentStatus.PENDING_RELEASE],
          },
        },
      },
    });
  });
});

describe("preTaxServiceFee with split payments", () => {
  it("strips the instalment's own GST, not the whole cycle's", () => {
    // The advance carries half the gross. Stripping the cycle's full GST would
    // understate the caregiver's fee — and go negative on a small cycle.
    const advance = preTaxServiceFee({
      amount: 5940,
      price_snapshots: [{ gst_amount: 1800 }], // the whole cycle's tax
      payment_installments: [{ gst_amount: 900 }], // this half's frozen share
    });
    expect(advance).toBe(5040);
  });

  it("falls back to the snapshot for payments written before instalments existed", () => {
    expect(
      preTaxServiceFee({ amount: 11880, price_snapshots: [{ gst_amount: 1800 }] }),
    ).toBe(10080);
  });

  it("treats a payment with neither as GST-free, as the completion placeholder is", () => {
    expect(preTaxServiceFee({ amount: 500, price_snapshots: [] })).toBe(500);
    expect(
      preTaxServiceFee({ amount: 500, price_snapshots: [], payment_installments: [] }),
    ).toBe(500);
  });

  it("keeps both halves summing to the cycle's own pre-tax fee", () => {
    // What the caregiver is owed cannot depend on how the parent paid.
    const halves = [
      { amount: 5940, price_snapshots: [], payment_installments: [{ gst_amount: 900 }] },
      { amount: 5940, price_snapshots: [], payment_installments: [{ gst_amount: 900 }] },
    ];
    const split = halves.reduce((sum, h) => sum + preTaxServiceFee(h), 0);
    const whole = preTaxServiceFee({
      amount: 11880,
      price_snapshots: [{ gst_amount: 1800 }],
    });
    expect(split).toBe(whole);
  });
});
