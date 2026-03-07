import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  Get,
  Param,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Delete,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { extname } from "path";
import { VerificationService } from "./verification.service";
import { UploadDocumentDto } from "./dto/upload-document.dto";
import { RejectVerificationDto } from "./dto/reject-verification.dto";
import { AuthGuard } from "@nestjs/passport";
import { ActiveUserGuard } from "../common/guards/active-user.guard";

@Controller("verification")
export class VerificationController {
  constructor(private readonly verificationService: VerificationService) {}

  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  @Post("upload")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({
        destination: "./uploads/verification",
        filename: (req, file, cb) => {
          const randomName = Array(32)
            .fill(null)
            .map(() => Math.round(Math.random() * 16).toString(16))
            .join("");
          return cb(null, `${randomName}${extname(file.originalname)}`);
        },
      }),
      fileFilter: (req, file, cb) => {
        if (!file.mimetype.match(/\/(jpg|jpeg|png|pdf)$/)) {
          return cb(
            new BadRequestException(
              "Only image files (jpg, jpeg, png) and PDFs are allowed!",
            ),
            false,
          );
        }
        cb(null, true);
      },
      limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    }),
  )
  async uploadDocuments(
    @Req() req,
    @Body() dto: UploadDocumentDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException("File is required");
    }
    return this.verificationService.uploadDocuments(
      req.user.id,
      dto,
      file.path,
    );
  }

  // TODO: Add Admin Role check
  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  @Get("pending")
  async getPendingVerifications() {
    return this.verificationService.getPendingVerifications();
  }

  // TODO: Add Admin Role check
  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  @Post(":id/approve")
  async approveVerification(@Param("id") id: string) {
    return this.verificationService.approveVerification(id);
  }

  // TODO: Add Admin Role check
  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  @Post(":id/reject")
  async rejectVerification(
    @Param("id") id: string,
    @Body() dto: RejectVerificationDto,
  ) {
    return this.verificationService.rejectVerification(id, dto);
  }

  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  @Delete("reset")
  async resetVerification(@Req() req) {
    return this.verificationService.resetVerification(req.user.id);
  }
}
