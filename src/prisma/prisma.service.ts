import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { EncryptionService } from "../common/services/encryption.service";

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy {
  constructor(private encryptionService: EncryptionService) {
    super();
  }

  async onModuleInit() {
    await this.$connect();
    // this.registerEncryptionMiddleware();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  private registerEncryptionMiddleware() {
    // Fields to encrypt/decrypt
    const encryptedFields = {
      profiles: ['phone', 'address'],
      identity_documents: ['id_number'],
    };

    // Middleware for WRITE operations (create, update)
    (this as any).$use(async (params, next) => {
      // Encrypt before write
      if (
        (params.action === 'create' || params.action === 'update') &&
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
        (params.action === 'findUnique' ||
          params.action === 'findFirst' ||
          params.action === 'findMany') &&
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
