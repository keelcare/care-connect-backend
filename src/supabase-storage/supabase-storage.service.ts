import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { Readable } from "stream";

const BUCKET = "verification-documents";
const AVATAR_BUCKET = "avatars";

@Injectable()
export class SupabaseStorageService {
  private readonly logger = new Logger(SupabaseStorageService.name);
  private readonly supabase: SupabaseClient | null;
  private readonly configured: boolean;
  private avatarBucketReady = false;

  constructor(private readonly configService: ConfigService) {
    const url = this.configService.get<string>("SUPABASE_URL");
    const key = this.configService.get<string>("SUPABASE_SERVICE_ROLE_KEY");
    this.configured = Boolean(url && key);

    if (!this.configured) {
      this.logger.warn(
        "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured. Storage operations will fail closed.",
      );
      this.supabase = null;
    } else {
      this.supabase = createClient(url!, key!);
    }
  }

  private assertConfigured(): SupabaseClient {
    if (!this.configured || !this.supabase) {
      throw new ServiceUnavailableException(
        "Supabase Storage service is not configured",
      );
    }
    return this.supabase;
  }

  /**
   * Uploads a file buffer to Supabase Storage.
   * Path format: <userId>/<timestamp>-<originalname>
   * Returns the storage path for later retrieval.
   */
  async uploadFile(
    folderName: string,
    file: Express.Multer.File,
  ): Promise<string> {
    const client = this.assertConfigured();
    const sanitizedName = (file?.originalname || "file").replace(
      /[^a-zA-Z0-9._-]/g,
      "_",
    );
    const storagePath = `${folderName}/${Date.now()}-${sanitizedName}`;

    const { error } = await client.storage
      .from(BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (error) {
      this.logger.error(
        `Error uploading ${file.originalname} to Supabase: ${error.message}`,
      );
      throw new Error(error.message);
    }

    this.logger.log(`Uploaded file to Supabase Storage: ${storagePath}`);
    return storagePath;
  }

  /**
   * Ensures the public avatars bucket exists (created on first use).
   */
  private async ensureAvatarBucket(): Promise<void> {
    if (this.avatarBucketReady) return;
    const client = this.assertConfigured();
    try {
      const { data } = await client.storage.getBucket(AVATAR_BUCKET);
      if (!data) {
        await client.storage.createBucket(AVATAR_BUCKET, {
          public: true,
          fileSizeLimit: 5 * 1024 * 1024,
        });
      }
    } catch {
      // Best-effort: attempt create, ignore if it already exists
      await client.storage
        .createBucket(AVATAR_BUCKET, { public: true })
        .catch(() => undefined);
    }
    this.avatarBucketReady = true;
  }

  /**
   * Uploads a publicly-readable image (e.g. a profile picture) and returns its
   * permanent public URL, suitable for use directly in an <img> tag.
   */
  async uploadPublicImage(
    folderName: string,
    file: Express.Multer.File,
  ): Promise<string> {
    const client = this.assertConfigured();
    await this.ensureAvatarBucket();
    const sanitizedName = (file?.originalname || "image").replace(
      /[^a-zA-Z0-9._-]/g,
      "_",
    );
    const storagePath = `${folderName}/${Date.now()}-${sanitizedName}`;

    const { error } = await client.storage
      .from(AVATAR_BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (error) {
      this.logger.error(`Error uploading avatar to Supabase: ${error.message}`);
      throw new Error(error.message);
    }

    const { data } = client.storage
      .from(AVATAR_BUCKET)
      .getPublicUrl(storagePath);

    this.logger.log(`Uploaded avatar to Supabase Storage: ${storagePath}`);
    return data.publicUrl;
  }

  /**
   * Downloads a file from Supabase Storage and returns it as a Readable stream
   * along with the MIME type.
   */
  async getFileStream(
    storagePath: string,
  ): Promise<{ stream: Readable; mimeType: string }> {
    const client = this.assertConfigured();
    const { data, error } = await client.storage
      .from(BUCKET)
      .download(storagePath);

    if (error || !data) {
      this.logger.error(
        `Error downloading ${storagePath} from Supabase: ${error?.message}`,
      );
      throw new NotFoundException("Document not found in storage");
    }

    // Convert Blob to Buffer then to Readable stream
    const buffer = Buffer.from(await data.arrayBuffer());
    const stream = Readable.from(buffer);
    const mimeType = data.type || "application/octet-stream";

    return { stream, mimeType };
  }

  /**
   * Deletes a file from Supabase Storage.
   */
  async deleteFile(storagePath: string): Promise<void> {
    const client = this.assertConfigured();
    const { error } = await client.storage
      .from(BUCKET)
      .remove([storagePath]);

    if (error) {
      this.logger.error(
        `Failed to delete ${storagePath} from Supabase: ${error.message}`,
      );
    } else {
      this.logger.log(`Deleted file from Supabase Storage: ${storagePath}`);
    }
  }
}
