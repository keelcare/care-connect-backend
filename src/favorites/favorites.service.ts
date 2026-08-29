import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class FavoritesService {
  constructor(private prisma: PrismaService) {}

  async addFavorite(parentId: string, nannyId: string) {
    if (parentId === nannyId) {
      throw new BadRequestException("Cannot favorite yourself");
    }

    // Ensure the target caregiver exists, has NANNY role, and is active.
    const nanny = await this.prisma.users.findFirst({
      where: {
        id: nannyId,
        role: "NANNY",
        is_active: true,
        deleted_at: null,
      },
      select: { id: true },
    });

    if (!nanny) {
      throw new NotFoundException("Caregiver not found");
    }

    // Atomic upsert avoids check-then-create race condition where concurrent
    // requests both pass findFirst and cause a P2002 unique constraint violation.
    return this.prisma.favorite_nannies.upsert({
      where: {
        parent_id_nanny_id: {
          parent_id: parentId,
          nanny_id: nannyId,
        },
      },
      create: {
        parent_id: parentId,
        nanny_id: nannyId,
      },
      update: {},
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
    // Only return favorites for active caregivers so parents don't see deactivated
    // or deleted accounts in their saved favorites list.
    return this.prisma.favorite_nannies.findMany({
      where: {
        parent_id: parentId,
        users_favorite_nannies_nanny_idTousers: {
          is_active: true,
          deleted_at: null,
        },
      },
      include: {
        users_favorite_nannies_nanny_idTousers: {
          include: {
            profiles: true,
            nanny_details: true,
          },
        },
      },
      orderBy: { created_at: "desc" },
    });
  }

  async getFavoriteNannyIds(parentId: string): Promise<string[]> {
    const favorites = await this.prisma.favorite_nannies.findMany({
      where: {
        parent_id: parentId,
        users_favorite_nannies_nanny_idTousers: {
          is_active: true,
          deleted_at: null,
        },
      },
      select: { nanny_id: true },
    });
    return favorites.map((f) => f.nanny_id);
  }
}
