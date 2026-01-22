import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class FavoritesService {
  constructor(private prisma: PrismaService) {}

  async addFavorite(parentId: string, nannyId: string) {
    // Check if already favorited
    const existing = await this.prisma.favorite_nannies.findFirst({
      where: {
        parent_id: parentId,
        nanny_id: nannyId,
      },
    });

    if (existing) {
      // Return existing favorite instead of throwing error
      return existing;
    }

    return this.prisma.favorite_nannies.create({
      data: {
        parent_id: parentId,
        nanny_id: nannyId,
      },
    });
  }

  async removeFavorite(parentId: string, nannyId: string) {
    return this.prisma.favorite_nannies.deleteMany({
      where: {
        parent_id: parentId,
        nanny_id: nannyId,
      },
    });
  }

  async getFavorites(parentId: string) {
    return this.prisma.favorite_nannies.findMany({
      where: { parent_id: parentId },
      include: {
        users_favorite_nannies_nanny_idTousers: {
          include: {
            profiles: true,
            nanny_details: true,
          },
        },
      },
    });
  }

  async isFavorite(parentId: string, nannyId: string): Promise<boolean> {
    const favorite = await this.prisma.favorite_nannies.findFirst({
      where: {
        parent_id: parentId,
        nanny_id: nannyId,
      },
    });
    return !!favorite;
  }

  async getFavoriteNannyIds(parentId: string): Promise<string[]> {
    const favorites = await this.prisma.favorite_nannies.findMany({
      where: { parent_id: parentId },
      select: { nanny_id: true },
    });
    return favorites.map((f) => f.nanny_id);
  }
}
