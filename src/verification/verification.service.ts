import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { UploadDocumentDto } from "./dto/upload-document.dto";
import { RejectVerificationDto } from "./dto/reject-verification.dto";

@Injectable()
export class VerificationService {
  constructor(private readonly prisma: PrismaService) {}

  async uploadDocuments(
    userId: string,
    dto: UploadDocumentDto,
    filePath: string,
  ) {
    // Remove any existing document of the same type for this user
    await this.prisma.identity_documents.deleteMany({
      where: {
        user_id: userId,
        type: dto.idType,
      },
    });

    // Create the identity document record
    await this.prisma.identity_documents.create({
      data: {
        user_id: userId,
        type: dto.idType,
        id_number: dto.idNumber,
        file_path: filePath,
      },
    });

    // Update user status and profile
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

  async getPendingVerifications() {
    return this.prisma.users.findMany({
      where: { identity_verification_status: "pending" },
      select: {
        id: true,
        email: true,
        identity_documents: true, // This will now fetch the related IdentityDocument records
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
            uploaded_at: doc.uploaded_at,
            status: user?.identity_verification_status || "unknown",
            rejection_reason: "User Withdrew Application", // Set specific withdrawal reason
          })),
        });
      }

      // Delete current documents
      await tx.identity_documents.deleteMany({
        where: { user_id: userId },
      });

      // Reset user status
      await tx.users.update({
        where: { id: userId },
        data: {
          identity_verification_status: "unverified", // Explicitly set to 'unverified'
          verification_rejection_reason: null,
          is_verified: false,
        },
      });
    });

    return { success: true, message: "Application withdrawn successfully" };
  }
}
