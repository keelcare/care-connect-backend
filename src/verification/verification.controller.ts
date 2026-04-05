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
  Res,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { Response } from "express";
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
      storage: memoryStorage(),
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
      file,
    );
  }

  // Admin proxy endpoint to stream document from Drive
  @UseGuards(AuthGuard("jwt"), ActiveUserGuard)
  @Get("document/:id")
  async getDocument(@Param("id") id: string, @Res() res: Response) {
    const { stream, mimeType } = await this.verificationService.getDocumentStream(id);
    res.set("Content-Type", mimeType);
    stream.pipe(res);
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
