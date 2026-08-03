import { IsIn, IsOptional } from "class-validator";

/**
 * Without this the `period` query param was an unvalidated raw string typed only at
 * compile time: anything that wasn't exactly `"week"` fell through to the month
 * branch, so `?period=montth` silently returned month figures under a week label.
 */
export class NannyEarningsAnalyticsQueryDto {
  @IsOptional()
  @IsIn(["week", "month"])
  period: "week" | "month" = "week";
}
