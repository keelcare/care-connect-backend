import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { SupabaseStorageService } from "../supabase-storage/supabase-storage.service";
import { UploadDocumentDto } from "./dto/upload-document.dto";
import { RejectVerificationDto } from "./dto/reject-verification.dto";

const IDENTITY_DOC_TYPES = ["AADHAR", "PAN", "VOTER_ID"];

@Injectable()
export class VerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: SupabaseStorageService,
  ) {}

  async uploadDocuments(
    userId: string,
    dto: UploadDocumentDto,
    file: Express.Multer.File,
  ) {
    // 1. Get user profile for naming the folder
    const userProfile = await this.prisma.profiles.findUnique({
      where: { user_id: userId },
      select: { first_name: true, last_name: true },
    });
    const nannyName =
      userProfile?.first_name || userProfile?.last_name
        ? `${userProfile.first_name || ""} ${userProfile.last_name || ""}`.trim()
        : "Unknown Nanny";

    // Sanitize nanny name for storage path
    const sanitizedNannyName = nannyName.replace(/[^a-zA-Z0-9]/g, "_");
    const folderName = `${sanitizedNannyName}_${userId}`;

    // 2. Upload the new file to Supabase Storage first — if this fails we
    // have touched nothing, and the old document stays intact and reviewable.
    const storagePath = await this.storageService.uploadFile(folderName, file);

    const isIdentityDoc = IDENTITY_DOC_TYPES.includes(dto.idType);

    // 3. Replace the same-type document row and flip the user's status in ONE
    // transaction. These three writes describe a single fact ("this file is
    // now the user's AADHAR, awaiting review"): if the delete landed but the
    // create failed, the user would have no document on file while sitting in
    // the pending queue. Old storage files are deleted only AFTER the commit
    // (same ordering as resetVerification) so a failed transaction cannot
    // leave a DB row pointing at a file we already destroyed.
    const [existingDocs, , , updatedUser] = await this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.identity_documents.findMany({
          where: { user_id: userId, type: dto.idType },
        });

        const deleted = await tx.identity_documents.deleteMany({
          where: { user_id: userId, type: dto.idType },
        });

        const created = await tx.identity_documents.create({
          data: {
            user_id: userId,
            type: dto.idType,
            id_number: dto.idNumber || "N/A",
            file_path: file.originalname,
            supabase_storage_path: storagePath,
          },
        });

        const user = await tx.users.update({
          where: { id: userId },
          data: {
            // Only identity documents (not resumes etc.) drive identity verification status
            ...(isIdentityDoc && { identity_verification_status: "pending" }),
            profiles: {
              upsert: {
                create: {
                  phone: dto.phone,
                  address: dto.address,
                },
                update: {
                  phone: dto.phone || undefined,
                  address: dto.address || undefined,
                },
              },
            },
          },
          select: {
            id: true,
            identity_verification_status: true,
            identity_documents: true,
            profiles: true,
          },
        });

        return [existing, deleted, created, user] as const;
      },
    );

    // 4. Storage cleanup of the replaced files, after the DB state is durable.
    // deleteFile logs-and-swallows errors, so a failed cleanup can only orphan
    // a file, never break the upload.
    for (const doc of existingDocs) {
      if (doc.supabase_storage_path) {
        await this.storageService.deleteFile(doc.supabase_storage_path);
      }
    }

    return updatedUser;
  }

  async getDocumentStream(documentId: string) {
    const doc = await this.prisma.identity_documents.findUnique({
      where: { id: documentId },
    });

    if (!doc || !doc.supabase_storage_path) {
      throw new NotFoundException("Document not found or has no storage path");
    }

    return this.storageService.getFileStream(doc.supabase_storage_path);
  }

  async getPendingVerifications() {
    return this.prisma.users.findMany({
      // Verification only applies to nannies — a parent can never be in this
      // queue, so scope the query rather than relying on the status field alone.
      where: { identity_verification_status: "pending", role: "nanny" },
      select: {
        id: true,
        email: true,
        identity_documents: true,
        profiles: {
          select: {
            first_name: true,
            last_name: true,
          },
        },
      },
      orderBy: {
        updated_at: "desc",
      },
    });
  }

  /**
   * Archived verification submissions for a nanny, newest first. These rows are
   * written by resetVerification() when a user withdraws an application.
   * `id_number` is deliberately excluded — ops don't need the raw ID to review
   * a resubmission, and the storage path is enough to fetch the document.
   */
  async getVerificationAttempts(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException("User not found");

    return this.prisma.verification_attempts.findMany({
      where: { user_id: userId },
      select: {
        id: true,
        type: true,
        status: true,
        rejection_reason: true,
        uploaded_at: true,
        archived_at: true,
        supabase_storage_path: true,
      },
      orderBy: { archived_at: "desc" },
    });
  }

  async approveVerification(id: string) {
    const user = await this.prisma.users.findUnique({ where: { id } });
    if (!user) throw new NotFoundException("User not found");
    if (user.role !== "nanny")
      throw new ForbiddenException("Only nannies can be verified");

    // Verified caregivers' identity documents (Aadhaar/PAN) are retained
    // indefinitely, not deleted on approval — kept for safety, dispute, and
    // re-verification purposes. See the privacy policy's "Data we collect" /
    // "How long we keep it" sections in keel-mobile for the current wording.
    //
    // RACE GUARD: the admin pending queue is a snapshot. Between rendering it
    // and this click, the nanny can withdraw (resetVerification archives and
    // DELETES their documents, status → "unverified"). An unguarded update
    // would then mark a nanny "verified" with zero documents on file — a
    // discoverable, bookable caregiver whose identity was never reviewed.
    // Claim the transition atomically: only a user who still has a submission
    // ("pending", or "rejected" being reconsidered) can be approved.
    const claimed = await this.prisma.users.updateMany({
      where: {
        id,
        role: "nanny",
        identity_verification_status: { in: ["pending", "rejected"] },
      },
      data: {
        identity_verification_status: "verified",
        verification_rejection_reason: null,
      },
    });
    if (claimed.count === 0) {
      throw new ConflictException(
        "No reviewable submission — the application was withdrawn or already processed",
      );
    }

    return this.prisma.users.findUnique({ where: { id } });
  }

  async rejectVerification(id: string, dto: RejectVerificationDto) {
    const user = await this.prisma.users.findUnique({ where: { id } });
    if (!user) throw new NotFoundException("User not found");
    if (user.role !== "nanny")
      throw new ForbiddenException("Only nannies can be verified");

    // Same race guard as approveVerification: never reject a submission that
    // no longer exists (withdrawn → "unverified"). Rejecting from "verified"
    // stays allowed — that is how ops revoke a caregiver whose verification
    // turns out to be bad — and re-rejecting updates the reason.
    const claimed = await this.prisma.users.updateMany({
      where: {
        id,
        role: "nanny",
        identity_verification_status: { in: ["pending", "verified", "rejected"] },
      },
      data: {
        identity_verification_status: "rejected",
        verification_rejection_reason: dto.reason,
      },
    });
    if (claimed.count === 0) {
      throw new ConflictException(
        "No reviewable submission — the application was withdrawn",
      );
    }

    return this.prisma.users.findUnique({ where: { id } });
  }

  async resetVerification(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: {
        identity_verification_status: true,
        verification_rejection_reason: true,
        role: true,
      },
    });

    if (!user) throw new NotFoundException("User not found");
    if (user.role !== "nanny")
      throw new ForbiddenException("Only nannies can withdraw verification");

    // Archive-and-delete in one transaction. The document snapshot is taken
    // INSIDE the transaction and the delete targets exactly those ids — a
    // pre-transaction snapshot plus deleteMany({ user_id }) would let a
    // concurrent upload land between the two and be deleted without ever
    // being archived (and its storage file would be orphaned).
    const currentDocs = await this.prisma.$transaction(async (tx) => {
      const docs = await tx.identity_documents.findMany({
        where: { user_id: userId },
      });

      // Archive entries
      if (docs.length > 0) {
        await tx.verification_attempts.createMany({
          data: docs.map((doc) => ({
            user_id: doc.user_id,
            type: doc.type,
            id_number: doc.id_number,
            file_path: doc.file_path,
            supabase_storage_path: doc.supabase_storage_path,
            uploaded_at: doc.uploaded_at,
            status: user?.identity_verification_status || "unknown",
            rejection_reason: "User Withdrew Application",
          })),
        });

        // Delete exactly the archived rows, not "everything for this user"
        await tx.identity_documents.deleteMany({
          where: { id: { in: docs.map((d) => d.id) } },
        });
      }

      // Reset IDENTITY verification only. `is_verified` is EMAIL verification
      // (set by auth's verifyEmail / Google OAuth, gates OAuth account
      // linking) — clearing it here silently un-verified the user's email
      // whenever they withdrew an identity application, breaking Google
      // sign-in linking and re-triggering "verify your email" flows.
      await tx.users.update({
        where: { id: userId },
        data: {
          identity_verification_status: "unverified",
          verification_rejection_reason: null,
        },
      });

      return docs;
    });

    // 3. Delete files from Supabase Storage (after transaction succeeds)
    for (const doc of currentDocs) {
      if (doc.supabase_storage_path) {
        await this.storageService.deleteFile(doc.supabase_storage_path);
      }
    }

    return { success: true, message: "Application withdrawn successfully" };
  }
}
