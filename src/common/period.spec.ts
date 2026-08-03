import { daysInWindow, istDateKey, resolvePeriod } from "./period";

/**
 * Boundaries are asserted as IST wall-clock, because that is the only frame in
 * which they are meaningful to a caregiver. The instants themselves are UTC.
 */
describe("resolvePeriod", () => {
  // Thursday 6 Aug 2026, 12:00 IST.
  const thursdayNoonIst = new Date("2026-08-06T06:30:00.000Z");

  describe("week", () => {
    it("runs Monday to Sunday around the given instant", () => {
      const w = resolvePeriod("week", thursdayNoonIst);

      // Mon 3 Aug 00:00 IST === 2 Aug 18:30 UTC
      expect(w.start.toISOString()).toBe("2026-08-02T18:30:00.000Z");
      // Sun 9 Aug 23:59:59.999 IST === 9 Aug 18:29:59.999 UTC
      expect(w.end.toISOString()).toBe("2026-08-09T18:29:59.999Z");
      expect(w.totalDays).toBe(7);
      expect(w.elapsedDays).toBe(4); // Mon, Tue, Wed, Thu
    });

    it("keeps Monday morning inside the new week, not the finished one", () => {
      // Mon 3 Aug, 06:00 IST — half an hour after UTC's day rolls over.
      const w = resolvePeriod("week", new Date("2026-08-03T00:30:00.000Z"));
      expect(istDateKey(w.start)).toBe("2026-08-03");
      expect(w.elapsedDays).toBe(1);
    });

    it("keeps late Sunday evening IST inside the week that is ending", () => {
      // Sun 9 Aug 23:00 IST === 9 Aug 17:30 UTC. Server-local UTC would have
      // called this Monday and rolled the week over six hours early.
      const w = resolvePeriod("week", new Date("2026-08-09T17:30:00.000Z"));
      expect(istDateKey(w.start)).toBe("2026-08-03");
      expect(w.totalDays).toBe(7);
    });

    it("compares against the same elapsed offset in the previous week", () => {
      const w = resolvePeriod("week", thursdayNoonIst);
      expect(istDateKey(w.previousStart)).toBe("2026-07-27");
      // Truncated to Thursday noon of that week, not the whole week.
      expect(w.previousEnd.toISOString()).toBe("2026-07-30T06:30:00.000Z");
      expect(w.previousEnd.getTime()).toBeLessThan(w.start.getTime());
    });
  });

  describe("month", () => {
    it("runs the 1st to the last day", () => {
      const w = resolvePeriod("month", thursdayNoonIst);
      expect(istDateKey(w.start)).toBe("2026-08-01");
      expect(istDateKey(w.end)).toBe("2026-08-31");
      expect(w.totalDays).toBe(31);
      expect(istDateKey(w.previousStart)).toBe("2026-07-01");
    });

    it("handles February in a leap year", () => {
      const w = resolvePeriod("month", new Date("2028-02-10T06:30:00.000Z"));
      expect(w.totalDays).toBe(29);
      expect(istDateKey(w.end)).toBe("2028-02-29");
    });

    it("rolls the year boundary backwards for the previous period", () => {
      const w = resolvePeriod("month", new Date("2026-01-15T06:30:00.000Z"));
      expect(istDateKey(w.previousStart)).toBe("2025-12-01");
    });

    it("never lets a long month borrow a day from a shorter previous one", () => {
      // 31 May, 23:00 IST — 30 days elapsed, but April only has 30.
      const w = resolvePeriod("month", new Date("2026-05-31T17:30:00.000Z"));
      expect(w.previousEnd.getTime()).toBeLessThan(w.start.getTime());
    });
  });

  it("enumerates every day of the window in order", () => {
    const w = resolvePeriod("week", thursdayNoonIst);
    const keys = daysInWindow(w).map(istDateKey);

    expect(keys).toEqual([
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
      "2026-08-09",
    ]);
  });
});
