import { Test, TestingModule } from "@nestjs/testing";
import { AddressesService } from "./addresses.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotFoundException } from "@nestjs/common";

describe("AddressesService", () => {
  let service: AddressesService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      addresses: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn(),
      },
      $transaction: jest.fn(async (cb) => cb(prisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AddressesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<AddressesService>(AddressesService);
  });

  describe("list", () => {
    it("returns addresses with lat/lng coerced to numbers", async () => {
      prisma.addresses.findMany.mockResolvedValue([
        {
          id: "addr-1",
          user_id: "user-1",
          label: "Home",
          address: "123 Street",
          lat: "12.97160000",
          lng: "77.59460000",
          is_default: true,
          deleted_at: null,
        },
      ]);

      const result = await service.list("user-1");
      expect(result).toEqual([
        expect.objectContaining({
          id: "addr-1",
          lat: 12.9716,
          lng: 77.5946,
        }),
      ]);
    });
  });

  describe("create", () => {
    it("makes the first address default atomically inside transaction", async () => {
      prisma.addresses.count.mockResolvedValue(0);
      prisma.addresses.create.mockResolvedValue({
        id: "addr-1",
        user_id: "user-1",
        label: "Home",
        address: "123 Main St",
        lat: "12.97",
        lng: "77.59",
        is_default: true,
      });

      const result = await service.create("user-1", {
        address: "123 Main St",
        lat: 12.97,
        lng: 77.59,
      });

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.addresses.count).toHaveBeenCalledWith({
        where: { user_id: "user-1", deleted_at: null },
      });
      expect(prisma.addresses.updateMany).toHaveBeenCalledWith({
        where: { user_id: "user-1", is_default: true },
        data: { is_default: false },
      });
      expect(result?.is_default).toBe(true);
    });

    it("does not unset existing defaults if new address is not default and others exist", async () => {
      prisma.addresses.count.mockResolvedValue(1);
      prisma.addresses.create.mockResolvedValue({
        id: "addr-2",
        user_id: "user-1",
        label: "Work",
        address: "456 Office Rd",
        lat: "12.98",
        lng: "77.60",
        is_default: false,
      });

      const result = await service.create("user-1", {
        address: "456 Office Rd",
        lat: 12.98,
        lng: 77.6,
        isDefault: false,
      });

      expect(prisma.addresses.updateMany).not.toHaveBeenCalled();
      expect(result?.is_default).toBe(false);
    });
  });

  describe("remove", () => {
    it("throws NotFoundException if address does not exist or belongs to another user", async () => {
      prisma.addresses.findFirst.mockResolvedValue(null);

      await expect(service.remove("user-1", "addr-nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("soft-deletes address and promotes next default when deleting default address", async () => {
      prisma.addresses.findFirst
        .mockResolvedValueOnce({
          id: "addr-1",
          user_id: "user-1",
          is_default: true,
          deleted_at: null,
        })
        .mockResolvedValueOnce({
          id: "addr-2",
          user_id: "user-1",
          is_default: false,
          deleted_at: null,
        });

      const result = await service.remove("user-1", "addr-1");

      expect(prisma.addresses.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "addr-1" },
          data: expect.objectContaining({ is_default: false }),
        }),
      );
      expect(prisma.addresses.update).toHaveBeenCalledWith({
        where: { id: "addr-2" },
        data: { is_default: true },
      });
      expect(result).toEqual({ success: true });
    });
  });

  describe("resolveForUser", () => {
    it("resolves specific address if owned by user", async () => {
      prisma.addresses.findFirst.mockResolvedValue({
        id: "addr-1",
        user_id: "user-1",
        lat: "12.9",
        lng: "77.6",
      });

      const result = await service.resolveForUser("user-1", "addr-1");
      expect(result?.id).toBe("addr-1");
    });

    it("throws NotFoundException if specific address is not found or not owned", async () => {
      prisma.addresses.findFirst.mockResolvedValue(null);

      await expect(service.resolveForUser("user-1", "addr-other")).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
