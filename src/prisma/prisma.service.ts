import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { EncryptionService } from "../common/services/encryption.service";

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(private encryptionService: EncryptionService) {
    super();
  }

  async onModuleInit() {
    await this.$connect();
    // DO NOT UNCOMMENT — see registerEncryptionMiddleware() below. This call
    // would throw at boot on Prisma 6 ($use no longer exists), and even if it
    // ran it would corrupt reads of existing plaintext rows.
    // this.registerEncryptionMiddleware();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * DEAD CODE — application-level PII encryption for profiles.phone /
   * profiles.address / identity_documents.id_number. It is deliberately not
   * wired up, and re-enabling it is a migration project, not a one-line change:
   *
   *  1. `$use` was removed in Prisma 6 (this project runs 6.19.2), so calling
   *     this method throws `this.$use is not a function` at startup. A port to
   *     client extensions (`$extends`) is required.
   *  2. Every existing row is plaintext. Turning decryption on without a
   *     backfill makes reads either throw or return garbage for all current
   *     users, so a one-off re-encryption migration must land first.
   *  3. Encrypting `phone` breaks every lookup and uniqueness check that filters
   *     on it — ciphertext is not comparable. Those call sites need a separate
   *     blind index (e.g. an HMAC column) before the field can be encrypted.
   *
   * Until that work is done these fields are protected by database-level
   * encryption at rest and access control only. Tracked in the audit report.
   */
  private registerEncryptionMiddleware() {
    // Fields to encrypt/decrypt
    const encryptedFields = {
      profiles: ["phone", "address"],
      identity_documents: ["id_number"],
    };

    // Middleware for WRITE operations (create, update)
    (this as any).$use(async (params, next) => {
      // Encrypt before write
      if (
        (params.action === "create" || params.action === "update") &&
        encryptedFields[params.model]
      ) {
        const fieldsToEncrypt = encryptedFields[params.model];

        if (params.args.data) {
          for (const field of fieldsToEncrypt) {
            if (params.args.data[field]) {
              params.args.data[field] = this.encryptionService.encrypt(
                params.args.data[field],
              );
            }
          }
        }
      }

      const result = await next(params);

      // Decrypt after read
      if (
        (params.action === "findUnique" ||
          params.action === "findFirst" ||
          params.action === "findMany") &&
        encryptedFields[params.model]
      ) {
        const fieldsToDecrypt = encryptedFields[params.model];

        if (Array.isArray(result)) {
          // findMany
          result.forEach((record) => {
            for (const field of fieldsToDecrypt) {
              if (record[field]) {
                record[field] = this.encryptionService.decrypt(record[field]);
              }
            }
          });
        } else if (result) {
          // findUnique, findFirst
          for (const field of fieldsToDecrypt) {
            if (result[field]) {
              result[field] = this.encryptionService.decrypt(result[field]);
            }
          }
        }
      }

      return result;
    });
  }
}
