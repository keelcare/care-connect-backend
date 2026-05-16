import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PricingUtils, PricingCalculationResult } from "./utils/pricing.utils";

@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name);
  private ratesCache: Map<string, number> = new Map();
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL = 1000 * 60 * 60; // 1 hour

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get hourly rate for a specific category, with caching
   */
  async getHourlyRate(category: string): Promise<number> {
    await this.refreshCacheIfNeeded();
    const rate = this.ratesCache.get(category);
    
    if (rate === undefined) {
      this.logger.warn(`Rate not found for category: ${category}. Using default 500.`);
      return 500;
    }
    
    return rate;
  }

  /**
   * Calculate total cost for a booking/request
   */
  async calculateCost(
    category: string,
    durationHours: number,
    discountPercentage: number = 0,
    planDurationMonths: number = 1,
    planType: string = "ONE_TIME",
    sessionsPerMonth?: number
  ): Promise<PricingCalculationResult> {
    const hourlyRate = await this.getHourlyRate(category);
    return PricingUtils.calculateTotal(
      hourlyRate,
      durationHours,
      discountPercentage,
      planDurationMonths,
      planType,
      sessionsPerMonth
    );
  }

  private async refreshCacheIfNeeded() {
    const now = Date.now();
    if (now - this.cacheTimestamp > this.CACHE_TTL || this.ratesCache.size === 0) {
      try {
        const services = await this.prisma.services.findMany();
        this.ratesCache.clear();
        services.forEach(s => {
          this.ratesCache.set(s.name, Number(s.hourly_rate));
        });
        this.cacheTimestamp = now;
        this.logger.log("Pricing rates cache refreshed");
      } catch (error) {
        this.logger.error("Failed to refresh pricing rates cache", error.stack);
      }
    }
  }

  /**
   * Manual cache invalidation
   */
  invalidateCache() {
    this.ratesCache.clear();
    this.cacheTimestamp = 0;
  }
}
