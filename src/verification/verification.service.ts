import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { SupabaseStorageService } from "../supabase-storage/supabase-storage.service";
import { UploadDocumentDto } from "./dto/upload-document.dto";
import { RejectVerificationDto } from "./dto/reject-verification.dto";

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

    // 2. Upload to Supabase Storage
    const storagePath = await this.storageService.uploadFile(folderName, file);

    // 2. Remove existing same-type documents (and cleanup storage)
    const existingDocs = await this.prisma.identity_documents.findMany({
      where: {
        user_id: userId,
        type: dto.idType,
      },
    });

    for (const doc of existingDocs) {
      if (doc.supabase_storage_path) {
        await this.storageService.deleteFile(doc.supabase_storage_path);
      }
    }

    await this.prisma.identity_documents.deleteMany({
      where: {
        user_id: userId,
        type: dto.idType,
      },
    });

    // 3. Create the identity document record
    await this.prisma.identity_documents.create({
      data: {
        user_id: userId,
        type: dto.idType,
        id_number: dto.idNumber,
        file_path: file.originalname,
        supabase_storage_path: storagePath,
      },
    });

    // 4. Update user status and profile
    return this.prisma.users.update({
      where: { id: userId },
      data: {
        identity_verification_status: "pending",
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
      where: { identity_verification_status: "pending" },
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

  async approveVerification(id: string) {
    const user = await this.prisma.users.findUnique({ where: { id } });
    if (!user) throw new NotFoundException("User not found");

    return this.prisma.users.update({
      where: { id },
      data: {
        identity_verification_status: "verified",
        verification_rejection_reason: null,
      },
    });
  }

  async rejectVerification(id: string, dto: RejectVerificationDto) {
    const user = await this.prisma.users.findUnique({ where: { id } });
    if (!user) throw new NotFoundException("User not found");

    return this.prisma.users.update({
      where: { id },
      data: {
        identity_verification_status: "rejected",
        verification_rejection_reason: dto.reason,
      },
    });
  }

  async resetVerification(userId: string) {
    // 1. Fetch current identity documents
    const currentDocs = await this.prisma.identity_documents.findMany({
      where: { user_id: userId },
    });

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

    // 2. Transaction to archive and delete
    await this.prisma.$transaction(async (tx) => {
      // Archive entries
      if (currentDocs.length > 0) {
        await tx.verification_attempts.createMany({
          data: currentDocs.map((doc) => ({
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
      }

      // Delete current documents from DB
      await tx.identity_documents.deleteMany({
        where: { user_id: userId },
      });

      // Reset user status
      await tx.users.update({
        where: { id: userId },
        data: {
          identity_verification_status: "unverified",
          verification_rejection_reason: null,
          is_verified: false,
        },
      });
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
