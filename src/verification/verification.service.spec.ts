import { Test, TestingModule } from "@nestjs/testing";
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { VerificationService } from "./verification.service";
import { PrismaService } from "../prisma/prisma.service";
import { SupabaseStorageService } from "../supabase-storage/supabase-storage.service";

describe("VerificationService", () => {
  let service: VerificationService;
  let prisma: any;
  let tx: any;
  let storage: any;

  const file = {
    originalname: "aadhar.pdf",
    buffer: Buffer.from("x"),
    mimetype: "application/pdf",
  } as Express.Multer.File;

  beforeEach(async () => {
    tx = {
      identity_documents: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ id: "doc-new" }),
      },
      verification_attempts: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      users: {
        update: jest.fn().mockResolvedValue({
          id: "user-1",
          identity_verification_status: "pending",
          identity_documents: [],
          profiles: {},
        }),
      },
    };
    prisma = {
      profiles: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ first_name: "Asha", last_name: "K" }),
      },
      users: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      identity_documents: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      verification_attempts: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn().mockImplementation((cb) => cb(tx)),
    };
    storage = {
      uploadFile: jest.fn().mockResolvedValue("folder/123-aadhar.pdf"),
      deleteFile: jest.fn().mockResolvedValue(undefined),
      getFileStream: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VerificationService,
        { provide: PrismaService, useValue: prisma },
        { provide: SupabaseStorageService, useValue: storage },
      ],
    }).compile();

    service = module.get(VerificationService);
  });

  describe("uploadDocuments", () => {
    it("replaces the same-type document inside one transaction and flips status to pending", async () => {
      const result = await service.uploadDocuments(
        "user-1",
        { idType: "AADHAR", idNumber: "1234" } as any,
        file,
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.identity_documents.deleteMany).toHaveBeenCalledWith({
        where: { user_id: "user-1", type: "AADHAR" },
      });
      expect(tx.identity_documents.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          user_id: "user-1",
          type: "AADHAR",
          supabase_storage_path: "folder/123-aadhar.pdf",
        }),
      });
      expect(tx.users.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            identity_verification_status: "pending",
          }),
        }),
      );
      expect(result.identity_verification_status).toBe("pending");
    });

    it("does not change identity status for non-identity documents (RESUME)", async () => {
      await service.uploadDocuments("user-1", { idType: "RESUME" } as any, file);

      const data = tx.users.update.mock.calls[0][0].data;
      expect(data.identity_verification_status).toBeUndefined();
    });

    it("deletes replaced storage files only AFTER the transaction commits", async () => {
      tx.identity_documents.findMany.mockResolvedValue([
        { id: "old-1", supabase_storage_path: "folder/old.pdf" },
      ]);
      const order: string[] = [];
      prisma.$transaction.mockImplementation(async (cb: any) => {
        order.push("tx");
        return cb(tx);
      });
      storage.deleteFile.mockImplementation(async () => {
        order.push("delete");
      });

      await service.uploadDocuments(
        "user-1",
        { idType: "AADHAR", idNumber: "1234" } as any,
        file,
      );

      expect(order).toEqual(["tx", "delete"]);
      expect(storage.deleteFile).toHaveBeenCalledWith("folder/old.pdf");
    });

    it("does not delete old storage files if the transaction fails", async () => {
      tx.identity_documents.findMany.mockResolvedValue([
        { id: "old-1", supabase_storage_path: "folder/old.pdf" },
      ]);
      prisma.$transaction.mockRejectedValue(new Error("db down"));

      await expect(
        service.uploadDocuments(
          "user-1",
          { idType: "AADHAR", idNumber: "1234" } as any,
          file,
        ),
      ).rejects.toThrow("db down");
      expect(storage.deleteFile).not.toHaveBeenCalled();
    });
  });

  describe("approveVerification", () => {
    beforeEach(() => {
      prisma.users.findUnique.mockResolvedValue({ id: "n-1", role: "nanny" });
    });

    it("claims the transition atomically from pending/rejected only", async () => {
      await service.approveVerification("n-1");

      expect(prisma.users.updateMany).toHaveBeenCalledWith({
        where: {
          id: "n-1",
          role: "nanny",
          identity_verification_status: { in: ["pending", "rejected"] },
        },
        data: {
          identity_verification_status: "verified",
          verification_rejection_reason: null,
        },
      });
    });

    it("refuses to approve when the submission was withdrawn (lost claim)", async () => {
      prisma.users.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.approveVerification("n-1")).rejects.toThrow(
        ConflictException,
      );
    });

    it("rejects non-nanny users", async () => {
      prisma.users.findUnique.mockResolvedValue({ id: "p-1", role: "parent" });
      await expect(service.approveVerification("p-1")).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.users.updateMany).not.toHaveBeenCalled();
    });

    it("throws NotFound for unknown users", async () => {
      prisma.users.findUnique.mockResolvedValue(null);
      await expect(service.approveVerification("nope")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("rejectVerification", () => {
    beforeEach(() => {
      prisma.users.findUnique.mockResolvedValue({ id: "n-1", role: "nanny" });
    });

    it("allows rejecting from pending, verified (revocation) and rejected, never unverified", async () => {
      await service.rejectVerification("n-1", { reason: "blurry" });

      expect(prisma.users.updateMany).toHaveBeenCalledWith({
        where: {
          id: "n-1",
          role: "nanny",
          identity_verification_status: {
            in: ["pending", "verified", "rejected"],
          },
        },
        data: {
          identity_verification_status: "rejected",
          verification_rejection_reason: "blurry",
        },
      });
    });

    it("refuses when the submission was withdrawn", async () => {
      prisma.users.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.rejectVerification("n-1", { reason: "blurry" }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("resetVerification", () => {
    beforeEach(() => {
      prisma.users.findUnique.mockResolvedValue({
        role: "nanny",
        identity_verification_status: "rejected",
        verification_rejection_reason: "blurry",
      });
      tx.users.update.mockResolvedValue({});
    });

    it("archives the docs read inside the transaction and deletes exactly those ids", async () => {
      tx.identity_documents.findMany.mockResolvedValue([
        {
          id: "doc-1",
          user_id: "n-1",
          type: "AADHAR",
          id_number: "1234",
          file_path: "a.pdf",
          supabase_storage_path: "f/a.pdf",
          uploaded_at: new Date("2026-01-01"),
        },
      ]);

      await service.resetVerification("n-1");

      expect(tx.verification_attempts.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            user_id: "n-1",
            type: "AADHAR",
            status: "rejected",
            rejection_reason: "User Withdrew Application",
          }),
        ],
      });
      expect(tx.identity_documents.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ["doc-1"] } },
      });
      expect(storage.deleteFile).toHaveBeenCalledWith("f/a.pdf");
    });

    it("resets identity status but never touches email verification (is_verified)", async () => {
      await service.resetVerification("n-1");

      const data = tx.users.update.mock.calls[0][0].data;
      expect(data.identity_verification_status).toBe("unverified");
      expect(data.verification_rejection_reason).toBeNull();
      expect(data).not.toHaveProperty("is_verified");
    });

    it("refuses withdrawal for non-nannies", async () => {
      prisma.users.findUnique.mockResolvedValue({ role: "parent" });
      await expect(service.resetVerification("p-1")).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe("getPendingVerifications", () => {
    it("scopes the queue to nannies with pending status", async () => {
      await service.getPendingVerifications();
      expect(prisma.users.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { identity_verification_status: "pending", role: "nanny" },
        }),
      );
    });
  });
});
