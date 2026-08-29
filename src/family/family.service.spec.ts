import { Test, TestingModule } from "@nestjs/testing";
import { FamilyService } from "./family.service";
import { PrismaService } from "../prisma/prisma.service";
import { ConsentsService } from "../users/consents.service";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChildProfileType, Gender } from "./dto/create-child.dto";

describe("FamilyService", () => {
  let service: FamilyService;
  let prisma: any;
  let consents: any;

  beforeEach(async () => {
    prisma = {
      children: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };

    consents = {
      storeConsentSafe: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FamilyService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConsentsService, useValue: consents },
      ],
    }).compile();

    service = module.get<FamilyService>(FamilyService);
  });

  describe("create", () => {
    it("rejects future date of birth", async () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 2);

      await expect(
        service.create("parent-1", {
          first_name: "Tim",
          last_name: "Smith",
          dob: futureDate.toISOString(),
          gender: Gender.MALE,
          profile_type: ChildProfileType.STANDARD,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("creates child with valid DOB and records DPDPA consent", async () => {
      const pastDate = new Date("2020-01-01");
      prisma.children.create.mockResolvedValue({
        id: "child-1",
        parent_id: "parent-1",
        first_name: "Tim",
        last_name: "Smith",
        dob: pastDate,
        gender: Gender.MALE,
        profile_type: ChildProfileType.STANDARD,
        metadata: { hobbies: ["drawing"] },
      });

      const result = await service.create(
        "parent-1",
        {
          first_name: "Tim",
          last_name: "Smith",
          dob: pastDate.toISOString(),
          gender: Gender.MALE,
          profile_type: ChildProfileType.STANDARD,
          hobbies: ["drawing"],
        },
        "192.168.1.1",
      );

      expect(prisma.children.create).toHaveBeenCalled();
      expect(consents.storeConsentSafe).toHaveBeenCalledWith(
        "parent-1",
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ subjectId: "child-1" }),
      );
      expect(result.hobbies).toEqual(["drawing"]);
    });
  });

  describe("update", () => {
    it("rejects updating to a future date of birth", async () => {
      prisma.children.findFirst.mockResolvedValue({
        id: "child-1",
        parent_id: "parent-1",
        metadata: {},
      });

      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 2);

      await expect(
        service.update("child-1", "parent-1", {
          dob: futureDate.toISOString(),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws ForbiddenException if child does not belong to parent", async () => {
      prisma.children.findFirst.mockResolvedValue({
        id: "child-1",
        parent_id: "parent-2",
        metadata: {},
      });

      await expect(
        service.update("child-1", "parent-1", { first_name: "Leo" }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("remove", () => {
    it("soft deletes with atomic claim", async () => {
      prisma.children.updateMany.mockResolvedValue({ count: 1 });

      const res = await service.remove("child-1", "parent-1");
      expect(prisma.children.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "child-1", parent_id: "parent-1", deleted_at: null },
        }),
      );
      expect(res).toEqual({ success: true });
    });

    it("throws NotFoundException if child already removed or nonexistent", async () => {
      prisma.children.updateMany.mockResolvedValue({ count: 0 });
      prisma.children.findUnique.mockResolvedValue(null);

      await expect(service.remove("child-1", "parent-1")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws ForbiddenException if child belongs to another parent on failed updateMany", async () => {
      prisma.children.updateMany.mockResolvedValue({ count: 0 });
      prisma.children.findUnique.mockResolvedValue({
        id: "child-1",
        parent_id: "parent-2",
        deleted_at: null,
      });

      await expect(service.remove("child-1", "parent-1")).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe("restore", () => {
    it("restores soft-deleted child with atomic claim within retention period", async () => {
      prisma.children.updateMany.mockResolvedValue({ count: 1 });
      prisma.children.findUnique.mockResolvedValue({
        id: "child-1",
        parent_id: "parent-1",
        deleted_at: null,
      });

      const res = await service.restore("child-1", "parent-1");
      expect(prisma.children.updateMany).toHaveBeenCalled();
      expect(res.id).toBe("child-1");
    });
  });
});
