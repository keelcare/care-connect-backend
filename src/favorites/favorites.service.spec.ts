import { Test, TestingModule } from "@nestjs/testing";
import { FavoritesService } from "./favorites.service";
import { PrismaService } from "../prisma/prisma.service";
import { BadRequestException, NotFoundException } from "@nestjs/common";

describe("FavoritesService", () => {
  let service: FavoritesService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      users: {
        findFirst: jest.fn(),
      },
      favorite_nannies: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FavoritesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<FavoritesService>(FavoritesService);
  });

  describe("addFavorite", () => {
    it("rejects self-favoriting", async () => {
      await expect(service.addFavorite("user-1", "user-1")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("throws NotFoundException when caregiver does not exist or is inactive", async () => {
      prisma.users.findFirst.mockResolvedValue(null);

      await expect(service.addFavorite("parent-1", "nanny-999")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("upserts favorite atomically when caregiver exists and is active", async () => {
      prisma.users.findFirst.mockResolvedValue({ id: "nanny-1" });
      prisma.favorite_nannies.upsert.mockResolvedValue({
        id: "fav-1",
        parent_id: "parent-1",
        nanny_id: "nanny-1",
      });

      const result = await service.addFavorite("parent-1", "nanny-1");

      expect(prisma.favorite_nannies.upsert).toHaveBeenCalledWith({
        where: {
          parent_id_nanny_id: {
            parent_id: "parent-1",
            nanny_id: "nanny-1",
          },
        },
        create: {
          parent_id: "parent-1",
          nanny_id: "nanny-1",
        },
        update: {},
      });
      expect(result.id).toBe("fav-1");
    });
  });

  describe("getFavorites", () => {
    it("filters out inactive/deleted caregivers", async () => {
      prisma.favorite_nannies.findMany.mockResolvedValue([]);

      await service.getFavorites("parent-1");

      expect(prisma.favorite_nannies.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            parent_id: "parent-1",
            users_favorite_nannies_nanny_idTousers: {
              is_active: true,
              deleted_at: null,
            },
          },
        }),
      );
    });
  });

  describe("removeFavorite", () => {
    it("deletes by parent and nanny id", async () => {
      prisma.favorite_nannies.deleteMany.mockResolvedValue({ count: 1 });

      const res = await service.removeFavorite("parent-1", "nanny-1");
      expect(prisma.favorite_nannies.deleteMany).toHaveBeenCalledWith({
        where: { parent_id: "parent-1", nanny_id: "nanny-1" },
      });
      expect(res).toEqual({ count: 1 });
    });
  });
});
