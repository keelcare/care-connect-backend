import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class ServicesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const services = await this.prisma.services.findMany({
      orderBy: { name: "asc" },
      include: {
        rate_cards: {
          where: {
            effective_from: { lte: new Date() },
            OR: [{ effective_to: null }, { effective_to: { gt: new Date() } }],
          },
          orderBy: { effective_from: "desc" },
          take: 1,
        },
      },
    });

    // Flatten: attach the current hourly_rate at the top level for easier consumption
    return services.map((svc) => ({
      id: svc.id,
      name: svc.name,
      slug: svc.slug,
      created_at: svc.created_at,
      hourly_rate: svc.rate_cards[0]?.hourly_rate ?? null,
      rate_card_id: svc.rate_cards[0]?.id ?? null,
    }));
  }
}
