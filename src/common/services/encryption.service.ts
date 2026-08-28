import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "node:crypto";

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly algorithm = "aes-256-gcm";
  private readonly key: Buffer;

  constructor(private configService: ConfigService) {
    const keyHex = this.configService.get<string>("ENCRYPTION_KEY");

    if (!keyHex) {
      this.logger.warn(
        "ENCRYPTION_KEY not set. PII encryption/decryption will throw until it is configured.",
      );
    }

    if (keyHex) {
      // Key must be 32 bytes (64 hex characters) for AES-256
      if (keyHex.length !== 64) {
        throw new Error("ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
      }
      this.key = Buffer.from(keyHex, "hex");
    }
  }

  /**
   * Encrypt plaintext using AES-256-GCM
   * Returns: iv:authTag:ciphertext (all hex-encoded)
   */
  encrypt(plaintext: string): string {
    if (!plaintext) return plaintext;
    if (!this.key) {
      throw new Error(
        "ENCRYPTION_KEY is not configured — refusing to store sensitive data unencrypted.",
      );
    }

    try {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);

      let encrypted = cipher.update(plaintext, "utf8", "hex");
      encrypted += cipher.final("hex");

      const authTag = cipher.getAuthTag();

      // Format: iv:authTag:ciphertext
      return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
    } catch (e) {
      this.logger.error("Encryption failed", e instanceof Error ? e.stack : e);
      throw e;
    }
  }

  /**
   * Decrypt ciphertext using AES-256-GCM
   * Expects format: iv:authTag:ciphertext
   */
  decrypt(encryptedData: string): string {
    if (!encryptedData || !this.key) return encryptedData;

    // Check if data is encrypted (contains colons)
    if (!encryptedData.includes(":")) {
      // Data is not encrypted (legacy data), return as-is
      return encryptedData;
    }

    try {
      const parts = encryptedData.split(":");
      if (parts.length !== 3) return encryptedData;

      const [ivHex, authTagHex, encrypted] = parts;

      const iv = Buffer.from(ivHex, "hex");
      const authTag = Buffer.from(authTagHex, "hex");

      const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(encrypted, "hex", "utf8");
      decrypted += decipher.final("utf8");

      return decrypted;
    } catch {
      // If decryption fails, return original (might be legacy unencrypted data)
      return encryptedData;
    }
  }

  /**
   * Check if data is encrypted
   */
  isEncrypted(data: string): boolean {
    return data && data.includes(":") && data.split(":").length === 3;
  }
}
