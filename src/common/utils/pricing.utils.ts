export interface PricingCalculationResult {
  hourlyRate: number;
  sessionCost: number;
  discountPercentage: number;
  discountAmount: number;
  sessionCostAfterDiscount: number;
  sessionsPerMonth: number;
  monthlyCost: number;
  planDurationMonths: number;
  totalAmount: number;
}

export class PricingUtils {
  /**
   * Calculate total pricing based on hourly rate, duration, discount, and plan type.
   * Matches logic in ShadowTeacherModal.tsx in the frontend.
   */
  static calculateTotal(
    hourlyRate: number,
    durationHours: number,
    discountPercentage: number = 0,
    planDurationMonths: number = 1,
    planType: string = 'ONE_TIME'
  ): PricingCalculationResult {
    const rate = Number(hourlyRate);
    const hours = Number(durationHours);
    const discountPercent = Number(discountPercentage);
    const planMonths = Number(planDurationMonths);

    const sessionCost = rate * hours;
    const discountAmount = (sessionCost * discountPercent) / 100;
    const sessionCostAfterDiscount = sessionCost - discountAmount;

    // Default: 1 session for ONE_TIME, 4 sessions per month for subscriptions
    const sessionsPerMonth = planType === 'ONE_TIME' ? 1 : 4;
    const monthlyCost = sessionCostAfterDiscount * sessionsPerMonth;
    
    // totalAmount = monthlyCost * planDuration (e.g., 6 months)
    const totalAmount = monthlyCost * planMonths;

    return {
      hourlyRate: rate,
      sessionCost,
      discountPercentage: discountPercent,
      discountAmount,
      sessionCostAfterDiscount,
      sessionsPerMonth,
      monthlyCost,
      planDurationMonths: planMonths,
      totalAmount
    };
  }
}
