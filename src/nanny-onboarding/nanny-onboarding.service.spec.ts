import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { NannyOnboardingService } from "./nanny-onboarding.service";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../common/services/encryption.service";

describe("NannyOnboardingService", () => {
  let service: NannyOnboardingService;
  let prisma: any;
  let tx: any;

  const completeRecord = {
    user_id: "n-1",
    age: 25,
    gender: "female",
    city: "Mumbai",
    education_qualification: "graduate",
    stream_subjects: "Science",
    shadow_teacher_experience: "1-2",
    categories: ["ST"],
    training_agreement: true,
    placement_fee_agreement: true,
    police_verification_consent: true,
    declaration_confirmed: true,
    onboarding_completed_at: null as Date | null,
    previous_salary: null as string | null,
  };

  beforeEach(async () => {
    tx = {
      nanny_onboarding_details: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      nanny_details: { upsert: jest.fn().mockResolvedValue({}) },
      profiles: {
        upsert: jest.fn().mockResolvedValue({ onboarding_completed: true }),
      },
    };
    prisma = {
      nanny_onboarding_details: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
      nanny_details: { findUnique: jest.fn() },
      identity_documents: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { type: "AADHAR" },
            { type: "PAN" },
            { type: "RESUME" },
          ]),
      },
      services: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ name: "ST" }, { name: "SN" }]),
      },
      $transaction: jest.fn().mockImplementation((cb) => cb(tx)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NannyOnboardingService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: EncryptionService,
          useValue: {
            encrypt: jest.fn((v: string) => `enc:${v}`),
            decrypt: jest.fn((v: string) => v.replace(/^enc:/, "")),
          },
        },
      ],
    }).compile();

    service = module.get(NannyOnboardingService);
  });

  describe("upsertMine", () => {
    it("rejects categories that are not service names", async () => {
      await expect(
        service.upsertMine("n-1", { categories: ["ST", "BOGUS"] } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.nanny_onboarding_details.upsert).not.toHaveBeenCalled();
    });

    it("encrypts previous salary before persisting", async () => {
      prisma.nanny_onboarding_details.upsert.mockResolvedValue({
        ...completeRecord,
        previous_salary: "enc:30000",
      });
      const result = await service.upsertMine("n-1", {
        previousSalary: "30000",
      } as any);

      expect(
        prisma.nanny_onboarding_details.upsert.mock.calls[0][0].update
          .previous_salary,
      ).toBe("enc:30000");
      expect(result.previous_salary).toBe("30000");
    });
  });

  describe("completeMine", () => {
    beforeEach(() => {
      prisma.nanny_onboarding_details.findUnique.mockResolvedValue({
        ...completeRecord,
      });
    });

    it("commits the completion stamp, nanny_details row and profiles flag in one transaction", async () => {
      const result = await service.completeMine("n-1");

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.nanny_onboarding_details.updateMany).toHaveBeenCalledWith({
        where: { user_id: "n-1", onboarding_completed_at: null },
        data: { onboarding_completed_at: expect.any(Date) },
      });
      expect(tx.nanny_details.upsert).toHaveBeenCalledWith({
        where: { user_id: "n-1" },
        update: { categories: ["ST"] },
        create: {
          user_id: "n-1",
          is_available_now: true,
          categories: ["ST"],
        },
      });
      expect(tx.profiles.upsert).toHaveBeenCalled();
      expect(result).toEqual({ onboardingCompleted: true });
    });

    it("does not overwrite nanny_details categories on a repeat completion", async () => {
      // The atomic claim on onboarding_completed_at IS NULL fails: someone
      // (or an earlier call) already stamped completion.
      tx.nanny_onboarding_details.updateMany.mockResolvedValue({ count: 0 });

      await service.completeMine("n-1");

      expect(tx.nanny_details.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: {} }),
      );
    });

    it("rejects when required fields are missing", async () => {
      prisma.nanny_onboarding_details.findUnique.mockResolvedValue({
        ...completeRecord,
        city: null,
      });
      await expect(service.completeMine("n-1")).rejects.toThrow(
        /Missing required fields: city/,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("rejects when consents are not all confirmed", async () => {
      prisma.nanny_onboarding_details.findUnique.mockResolvedValue({
        ...completeRecord,
        police_verification_consent: false,
      });
      await expect(service.completeMine("n-1")).rejects.toThrow(
        /consents and the declaration/,
      );
    });

    it("rejects when required documents are missing", async () => {
      prisma.identity_documents.findMany.mockResolvedValue([
        { type: "AADHAR" },
      ]);
      await expect(service.completeMine("n-1")).rejects.toThrow(
        /Missing required documents: PAN, RESUME/,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("rejects when no onboarding record exists", async () => {
      prisma.nanny_onboarding_details.findUnique.mockResolvedValue(null);
      await expect(service.completeMine("n-1")).rejects.toThrow(
        /Complete the onboarding form/,
      );
    });
  });

  describe("getMine", () => {
    it("falls back to nanny_details categories for legacy caregivers", async () => {
      prisma.nanny_onboarding_details.findUnique.mockResolvedValue({
        ...completeRecord,
        categories: [],
      });
      prisma.nanny_details.findUnique.mockResolvedValue({
        categories: ["SN"],
      });

      const result = await service.getMine("n-1");
      expect(result.categories).toEqual(["SN"]);
    });

    it("decrypts previous salary on read", async () => {
      prisma.nanny_onboarding_details.findUnique.mockResolvedValue({
        ...completeRecord,
        previous_salary: "enc:25000",
      });
      const result = await service.getMine("n-1");
      expect(result.previous_salary).toBe("25000");
    });
  });
});
