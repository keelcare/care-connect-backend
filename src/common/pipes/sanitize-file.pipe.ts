import { PipeTransform, Injectable, BadRequestException } from "@nestjs/common";
import * as DOMPurify from "isomorphic-dompurify";

@Injectable()
export class SanitizeFilePipe implements PipeTransform {
  transform(file: Express.Multer.File) {
    if (!file) return file;

    // Only sanitize SVGs
    if (file.mimetype === "image/svg+xml") {
      try {
        const originalContent = file.buffer.toString("utf-8");
        const sanitizedContent = DOMPurify.sanitize(originalContent);

        // Re-buffer the sanitized content
        file.buffer = Buffer.from(sanitizedContent, "utf-8");
        // Update size
        file.size = file.buffer.length;
      } catch (error) {
        throw new BadRequestException("Failed to sanitize SVG file");
      }
    }

    return file;
  }
}
